/**
 * Webhook 派发器（M6 / FR-7.3）：自用 API 携带 `callbackUrl` 时，租约成功收码后把
 * 整封邮件 POST 回调给调用方。带 **HMAC 签名 + 超时 + 重试 + 按 leaseId 幂等**。
 *
 * 幂等：每个 leaseId 仅登记一次回调，派发前即从表中删除——配合 FR-0「一码一次收码」，
 * 同一租约绝不重复回调。终态（expired/cancelled）到达则清理未触发的登记。
 */
import { createHmac } from 'node:crypto';
import axios from 'axios';
import { mailView } from './views.js';
import { logger } from '../logger.js';

/** 非 received 的终态事件：清理登记 */
const TERMINAL_EVENTS = new Set(['expired', 'cancelled']);

/** 简单退避 sleep */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WebhookDispatcher {
  /**
   * @param {object} opts
   * @param {string} [opts.secret] HMAC 密钥（空=不签名）
   * @param {number} [opts.timeoutMs] 单次回调超时
   * @param {number} [opts.maxRetries] 失败重试次数
   */
  constructor({ secret = '', timeoutMs = 8000, maxRetries = 3 } = {}) {
    this.secret = secret;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    /** @type {Map<string, string>} leaseId → callbackUrl */
    this.callbacks = new Map();
  }

  /**
   * 登记一个租约的回调地址（createLease 成功后调用）。
   * @param {string} leaseId
   * @param {string} callbackUrl
   */
  register(leaseId, callbackUrl) {
    this.callbacks.set(leaseId, callbackUrl);
  }

  /** 取消登记（提前释放时调用）。 */
  unregister(leaseId) {
    this.callbacks.delete(leaseId);
  }

  /**
   * 接收 LeaseManager 事件（与 SSE 共用同一事件源）。
   * @param {string} type active|received|expired|cancelled
   * @param {string} leaseId
   * @param {object} payload { lease, mail? }
   */
  onEvent(type, leaseId, payload) {
    if (type !== 'received') {
      if (TERMINAL_EVENTS.has(type)) this.callbacks.delete(leaseId);
      return;
    }
    const url = this.callbacks.get(leaseId);
    if (!url) return;
    this.callbacks.delete(leaseId); // 幂等：取出即删，只回调一次
    this._dispatch(leaseId, url, payload).catch((err) => {
      logger.error({ leaseId, err: err.message }, 'webhook 派发异常');
    });
  }

  /**
   * 实际派发（带重试）。整封邮件交付，自用方自行解析验证码。
   * @param {string} leaseId
   * @param {string} url
   * @param {object} payload
   */
  async _dispatch(leaseId, url, payload) {
    const body = JSON.stringify({
      leaseId,
      alias: payload.lease?.alias,
      mail: mailView(payload.mail),
      code: payload.lease?.code ?? null,
    });
    const headers = { 'content-type': 'application/json' };
    if (this.secret) {
      headers['x-signature'] = createHmac('sha256', this.secret).update(body).digest('hex');
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await axios.post(url, body, { headers, timeout: this.timeoutMs });
        logger.info({ leaseId, attempt }, 'webhook 回调成功');
        return;
      } catch (err) {
        if (attempt >= this.maxRetries) {
          logger.error(
            { leaseId, attempts: attempt + 1, err: err.message },
            'webhook 回调最终失败',
          );
          return;
        }
        await sleep(500 * 2 ** attempt); // 指数退避：0.5s/1s/2s
      }
    }
  }
}

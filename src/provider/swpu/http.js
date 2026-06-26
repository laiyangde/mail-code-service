/**
 * SWPU 别名 HTTP 客户端（基座 FR-2）：常态走纯 HTTP（axios + cookie + zid），
 * L1 拟真复刻浏览器环境（NFR-8）；`_login!==1` 经 SwpuSession 重登后自动重放（封顶）。
 *
 * 别名接口走**根路径 `/?q=`**（非 `/user/`），不可混用。
 */
import axios from 'axios';
import { SWPU_BASE_URL } from './constants.js';
import { buildHeaders } from './request-util.js';
import { logger } from '../../logger.js';

export class SwpuHttpClient {
  /**
   * @param {object} opts
   * @param {import('./session.js').SwpuSession} opts.session 会话层（提供 cookie/zid 与自愈）
   */
  constructor({ session }) {
    this.session = session;
  }

  /**
   * 带失效自愈的请求执行器：取会话 → 发请求 → 若 `_login!==1` 则重登重放（封顶 maxReplays）。
   * @param {(session: import('../email-provider.js').Session) => import('axios').AxiosRequestConfig} buildConfig
   *        以当前会话构造 axios 配置（每次重放都用最新会话重建，确保 zid/cookie 最新）
   * @param {{ maxReplays?: number }} [opts]
   * @returns {Promise<any>} 响应体 JSON
   */
  async _request(buildConfig, { maxReplays = 1 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const session = await this.session.ensureSession();
      const { data } = await axios({
        timeout: 20000,
        validateStatus: () => true,
        ...buildConfig(session),
      });
      if (data?._login === 1) return data;
      if (attempt < maxReplays) {
        logger.info({ accountId: this.session.accountId }, '会话失效（_login≠1），重登并重放');
        this.session.invalidate();
        continue;
      }
      throw new Error(`会话失效且重放用尽（_login=${data?._login}）`);
    }
  }

  /**
   * 获取当前别名（FR-2.1）。
   * @returns {Promise<string|null>} 当前别名（不含域名），无则 null
   */
  async getCurrentAlias() {
    const data = await this._request((session) => ({
      method: 'GET',
      // `_data=settings_alias%3D` 中 %3D 即 '='，是接口要求的字面写法
      url: `${SWPU_BASE_URL}/?q=data&_data=settings_alias%3D&zid=${encodeURIComponent(session.zid)}`,
      headers: buildHeaders(session),
    }));
    if (data.settings_alias?.res !== 1) {
      throw new Error('获取别名失败（settings_alias.res≠1）');
    }
    return data.settings_alias.data?.alias?.[0] ?? null;
  }

  /**
   * 设置别名（FR-2.2/2.3）：`action=mod` 修改式；冲突（含「已经存在」）自动加数字后缀重试。
   * @param {string} newAlias 期望别名（不含域名）
   * @param {{ maxRetries?: number }} [opts] 加后缀重试上限（默认 10）
   * @returns {Promise<import('../email-provider.js').SetAliasResult>}
   */
  async setAlias(newAlias, { maxRetries = 10 } = {}) {
    // action=mod 需要 old：取当前别名作为被改对象
    const old = await this.getCurrentAlias();
    if (!old) {
      throw new Error('未找到当前别名，无法以 action=mod 修改');
    }

    for (let retry = 0; retry <= maxRetries; retry++) {
      const finalAlias = retry === 0 ? newAlias : `${newAlias}${retry}`;
      const body = new URLSearchParams({ action: 'mod', old, alias: finalAlias }).toString();
      const data = await this._request((session) => ({
        method: 'POST',
        url: `${SWPU_BASE_URL}/?q=settings.alias.do&zid=${encodeURIComponent(session.zid)}`,
        headers: buildHeaders(session, { 'Content-Type': 'application/x-www-form-urlencoded' }),
        data: body,
      }));

      if (data.res === 1) {
        logger.info({ accountId: this.session.accountId, alias: finalAlias }, '设置别名成功');
        return { ok: true, finalAlias };
      }

      const errMsg = data.errmsg || data.errMsg || '';
      // 冲突 → 加后缀重试；其它错误直接抛
      if (errMsg.includes('已经存在') || errMsg.includes('already exists')) {
        logger.warn({ accountId: this.session.accountId, finalAlias }, '别名冲突，加后缀重试');
        continue;
      }
      throw new Error(`设置别名失败：${errMsg || JSON.stringify(data)}`);
    }
    throw new Error(`设置别名失败：加后缀重试 ${maxRetries} 次仍冲突`);
  }
}

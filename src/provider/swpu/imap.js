/**
 * SWPU IMAP 收码（基座 FR-4）：每账号一条**常驻** IMAP 长连接，IDLE 监听新邮件，
 * 命中三重匹配后把**整封邮件**主动回调给当前活跃租约（推模型）。**服务端不在此提码**。
 *
 * - 连接：`mailgate.<domain>:993` 隐式 TLS，账号 = 完整邮箱，密码 = IMAP 独立密码；
 * - 实时：imapflow 空闲自动 IDLE，`exists` 事件触发 `_poll`；断线**指数退避重连**；
 * - 匹配：`search(SINCE 粗筛)` → 客户端三重精筛（{@link matchMail}，含**秒级** ≥ since）；
 * - 交付：envelope 命中后才 `simpleParser` 取正文（省解析），回调 {@link MailMeta}。
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { matchMail } from './mail-match.js';
import { logger } from '../../logger.js';

/** 连续重连失败达此次数 → 通知账号置 unhealthy（FR-1.2） */
const UNHEALTHY_THRESHOLD = 5;
/** 重连退避上限（毫秒） */
const MAX_BACKOFF_MS = 30000;

export class SwpuImap {
  /**
   * @param {object} opts
   * @param {string} opts.accountId
   * @param {string} opts.imapUser 完整邮箱
   * @param {string} opts.imapPass IMAP 独立密码
   * @param {string} opts.host
   * @param {number} opts.port
   * @param {() => void} [opts.onHealthy] 连接恢复回调
   * @param {(err: Error) => void} [opts.onUnhealthy] 连续失败回调（账号剔除）
   */
  constructor({ accountId, imapUser, imapPass, host, port, onHealthy, onUnhealthy }) {
    this.accountId = accountId;
    this.config = {
      host,
      port: Number(port),
      secure: true, // 993 隐式 TLS
      auth: { user: imapUser, pass: imapPass },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 60000,
      logger: false,
    };
    this.onHealthy = onHealthy;
    this.onUnhealthy = onUnhealthy;
    /** @type {ImapFlow | null} */
    this.client = null;
    this.stopped = false;
    this.backoff = 1000;
    this.failCount = 0;
    // 因 C-1，一个账号同一时刻至多一个活跃订阅
    /** @type {import('../email-provider.js').MailMatch | null} */
    this.currentMatch = null;
    /** @type {((mail: import('../email-provider.js').MailMeta) => void) | null} */
    this.onMail = null;
    /** 本次订阅内已回调的 UID（防同封邮件多次 exists 重复交付） */
    this.handledUids = new Set();
  }

  /** 建立常驻连接（首次失败抛出，由调用方处理；之后断线走后台重连）。 */
  async start() {
    this.stopped = false;
    await this._connect();
  }

  /** 单次连接 + 打开 INBOX + 挂事件。 */
  async _connect() {
    const client = new ImapFlow(this.config);
    this.client = client;
    client.on('error', (err) =>
      logger.warn({ accountId: this.accountId, err: err.message }, 'IMAP 连接错误'),
    );
    client.on('exists', () => {
      this._poll().catch((e) =>
        logger.warn({ accountId: this.accountId, err: e.message }, 'IMAP 轮询失败'),
      );
    });
    client.on('close', () => {
      if (!this.stopped) this._scheduleReconnect();
    });
    await client.connect();
    // 只读打开：收码不改已读状态，删信交由 Cleaner（FR-4.5/FR-9）
    await client.mailboxOpen('INBOX', { readOnly: true });
    this.backoff = 1000;
    this.failCount = 0;
    logger.info({ accountId: this.accountId }, 'IMAP 已连接并打开 INBOX');
    this.onHealthy?.();
    // 连上立即扫一次：捕获订阅前已到达的匹配邮件
    this._poll().catch(() => {});
  }

  /** 断线重连：指数退避 1s→2s→…→30s；连续失败达阈值通知 unhealthy。 */
  _scheduleReconnect() {
    this.failCount++;
    if (this.failCount >= UNHEALTHY_THRESHOLD) {
      this.onUnhealthy?.(new Error('IMAP 连续重连失败'));
    }
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    logger.warn(
      { accountId: this.accountId, delayMs: delay, failCount: this.failCount },
      'IMAP 断开，计划重连',
    );
    setTimeout(() => {
      if (this.stopped) return;
      this._connect().catch((err) => {
        logger.warn({ accountId: this.accountId, err: err.message }, 'IMAP 重连失败');
        this._scheduleReconnect();
      });
    }, delay);
  }

  /**
   * 订阅当前账号的收码（覆盖式：一个账号同一时刻仅一个订阅，C-1）。
   * @param {import('../email-provider.js').MailMatch} match
   * @param {(mail: import('../email-provider.js').MailMeta) => void} onMail
   * @returns {import('../email-provider.js').Unsubscribe}
   */
  subscribeMail(match, onMail) {
    this.currentMatch = match;
    this.onMail = onMail;
    this.handledUids = new Set();
    logger.info({ accountId: this.accountId, to: match.to }, 'IMAP 订阅收码');
    this._poll().catch((e) =>
      logger.warn({ accountId: this.accountId, err: e.message }, '订阅即时轮询失败'),
    );
    return () => {
      // 仅当未被新订阅覆盖时才清空
      if (this.onMail === onMail) {
        this.currentMatch = null;
        this.onMail = null;
      }
    };
  }

  /** 扫描候选邮件并对当前订阅做三重精筛，命中交付整封邮件。 */
  async _poll() {
    const match = this.currentMatch;
    const onMail = this.onMail;
    if (!match || !onMail || !this.client?.usable) return;

    const sinceDate = new Date(match.since * 1000);
    let uids;
    try {
      // SINCE 仅到「天」做粗筛 + UNSEEN，秒级与 To/From 由客户端精筛
      uids = await this.client.search({ since: sinceDate, seen: false }, { uid: true });
    } catch (err) {
      logger.warn({ accountId: this.accountId, err: err.message }, 'IMAP search 失败');
      return;
    }
    if (!Array.isArray(uids) || uids.length === 0) return;

    for (const uid of uids) {
      if (this.handledUids.has(uid)) continue;
      let msg;
      try {
        msg = await this.client.fetchOne(
          String(uid),
          { uid: true, envelope: true, internalDate: true, source: true },
          { uid: true },
        );
      } catch {
        continue;
      }
      if (!msg?.envelope) continue;
      if (!matchMail(this._normalize(msg), match)) continue;

      this.handledUids.add(uid);
      const mail = await this._toMailMeta(msg);
      // 交付前再确认订阅未切换（避免把上一个租约的码交给新订阅）
      if (this.onMail === onMail) onMail(mail);
    }
  }

  /**
   * 从 envelope 提取匹配所需的规范化字段（地址小写、时间秒级，优先 INTERNALDATE 防时钟偏差串号）。
   * @param {object} msg imapflow fetch 结果
   * @returns {{ fromAddr: string, toAddrs: string[], date: number }}
   */
  _normalize(msg) {
    const env = msg.envelope || {};
    return {
      fromAddr: (env.from?.[0]?.address || '').toLowerCase(),
      toAddrs: (env.to || []).map((a) => (a.address || '').toLowerCase()).filter(Boolean),
      date: toEpochSec(msg.internalDate ?? env.date),
    };
  }

  /**
   * 构造交付物 MailMeta：envelope 取头部字段，simpleParser 取完整正文。
   * @param {object} msg
   * @returns {Promise<import('../email-provider.js').MailMeta>}
   */
  async _toMailMeta(msg) {
    const env = msg.envelope || {};
    const parsed = msg.source ? await simpleParser(msg.source).catch(() => ({})) : {};
    const fromObj = env.from?.[0];
    return {
      uid: msg.uid,
      from: fromObj ? `${fromObj.name || ''} <${fromObj.address}>`.trim() : parsed.from?.text || '',
      to:
        (env.to || [])
          .map((a) => a.address)
          .filter(Boolean)
          .join(', ') ||
        parsed.to?.text ||
        '',
      subject: env.subject || parsed.subject || '',
      date: toEpochSec(msg.internalDate ?? env.date),
      text: parsed.text || '',
      html: typeof parsed.html === 'string' ? parsed.html : '',
    };
  }

  /** 停止：断订阅、断连接，不再重连。 */
  async stop() {
    this.stopped = true;
    this.currentMatch = null;
    this.onMail = null;
    try {
      await this.client?.logout();
    } catch {
      /* 忽略关闭异常 */
    }
    this.client = null;
  }
}

/**
 * 把 Date / 时间戳转秒级 epoch；空值返回 0。
 * @param {Date|number|undefined|null} d
 * @returns {number}
 */
function toEpochSec(d) {
  if (!d) return 0;
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

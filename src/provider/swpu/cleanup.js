/**
 * SWPU IMAP 删信（基座 FR-3）：独立的定时批量任务用，**与收码解耦**（独立连接）。
 * 按 UID 执行 `messageDelete`（imapflow = `STORE \Deleted` + `EXPUNGE`，已实测生效）。
 *
 * ⚠️ 安全：拒绝空条件（避免误删全部邮件）；必须按 **UID** 删除（规避 EXPUNGE 后序号重排陷阱）。
 */
import { ImapFlow } from 'imapflow';
import { logger } from '../../logger.js';

/**
 * 把删信条件转为 imapflow search 查询；空条件直接抛错保护。
 * @param {object} criteria { seen?: boolean, before?: Date|number|string, from?: string }
 * @returns {object} imapflow SearchObject
 */
function buildSearch(criteria) {
  const search = {};
  if (criteria.seen !== undefined) search.seen = criteria.seen;
  if (criteria.before) search.before = new Date(criteria.before);
  if (criteria.from) search.from = criteria.from;
  if (Object.keys(search).length === 0) {
    throw new Error('cleanup 拒绝空条件（避免误删全部邮件），请至少指定 seen / before / from 之一');
  }
  return search;
}

/**
 * 删信：连接 → 按条件 search 取 UID → messageDelete → 断开。
 * @param {object} conn
 * @param {string} conn.accountId
 * @param {string} conn.imapUser 完整邮箱
 * @param {string} conn.imapPass IMAP 独立密码
 * @param {string} conn.host
 * @param {number} conn.port
 * @param {object} [criteria] 删信条件（默认只删已读：{ seen: true }）
 * @returns {Promise<import('../email-provider.js').CleanupResult>}
 */
export async function swpuCleanup(
  { accountId, imapUser, imapPass, host, port },
  criteria = { seen: true },
) {
  const search = buildSearch(criteria);
  const client = new ImapFlow({
    host,
    port: Number(port),
    secure: true,
    auth: { user: imapUser, pass: imapPass },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    logger: false,
  });
  await client.connect();
  // 可写锁定 INBOX（删除需写权限）
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uids = await client.search(search, { uid: true });
    if (!Array.isArray(uids) || uids.length === 0) {
      logger.info({ accountId }, '删信：无匹配邮件');
      return { deleted: 0 };
    }
    // 按 UID 删除：STORE \Deleted + EXPUNGE，从 INBOX 彻底移除
    await client.messageDelete(
      uids.map((u) => String(u)),
      { uid: true },
    );
    logger.info({ accountId, deleted: uids.length }, '删信完成');
    return { deleted: uids.length };
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

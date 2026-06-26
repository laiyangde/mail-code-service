/**
 * 删信定时任务（H 层 / FR-9）：周期性遍历启用账号，按时间窗批量删除旧邮件。
 *
 * 与收码**解耦**：走 `provider.cleanup()`（SWPU 为独立 IMAP 连接，见 swpu/cleanup.js），
 * EXPUNGE 仅作用于选中 UID，不影响活跃租约的常驻订阅（C-1/C-4 仍成立，FR-9.2）。
 * 单账号失败不影响其它账号。
 */
import { logger } from '../logger.js';

const DAY_MS = 86_400_000;

/**
 * 执行一轮删信：对每个启用账号删除 `beforeDays` 天前的邮件。
 * @param {import('../services.js').Services} services
 * @param {{ beforeDays?: number }} [opts] beforeDays：删多少天前的邮件（默认 3）
 * @returns {Promise<{ accounts:number, deleted:number }>}
 */
export async function runCleanup(services, { beforeDays = 3 } = {}) {
  const before = new Date(Date.now() - beforeDays * DAY_MS);
  const criteria = { before }; // 按时间窗删（不限已读/未读，彻底清旧信）
  let accounts = 0;
  let deleted = 0;

  for (const acc of services.store.account.listEnabled()) {
    const provider = services.pool.getProvider(acc.id);
    if (!provider?.cleanup) continue;
    accounts++;
    try {
      const res = await provider.cleanup(criteria);
      deleted += res?.deleted ?? 0;
    } catch (err) {
      logger.warn({ accountId: acc.id, err: err.message }, '删信失败（跳过该账号）');
    }
  }
  logger.info({ accounts, deleted, beforeDays }, '删信任务完成');
  return { accounts, deleted };
}

/**
 * 启动周期删信。返回 `{ stop }` 供优雅停机调用。
 * @param {import('../services.js').Services} services
 * @param {{ intervalMs:number, beforeDays?:number }} opts
 * @returns {{ stop: () => void }}
 */
export function startCleaner(services, { intervalMs, beforeDays }) {
  const tick = () => {
    runCleanup(services, { beforeDays }).catch((err) =>
      logger.error({ err: err.message }, '删信任务异常'),
    );
  };
  const handle = setInterval(tick, intervalMs);
  handle.unref?.(); // 不阻止进程退出
  logger.info({ intervalMs, beforeDays }, '删信定时任务已启动');
  return {
    stop() {
      clearInterval(handle);
    },
  };
}

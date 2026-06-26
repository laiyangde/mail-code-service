/**
 * 收码结果保留与清理（H 层 / FR-10）：把回看期满（`used` 且 `retain_until < now`）的唯一码
 * 及其关联数据物理清理，释放隐私邮件内容。
 *
 * 与 Cleaner（FR-9 删邮箱里的邮件）是两件事：本任务清理的是**业务数据库记录**。
 * - **未使用的码（unused）永久保留**，不在清理范围（FR-10.2）；
 * - 删除走事务、可重试无副作用（FR-10.4）；删除前校验无活跃租约，绝不影响 active 数据（FR-10.3）；
 * - 删除顺序遵守外键：processed_mail → lease → access_code；保留 audit_log 脱敏摘要。
 */
import { immediateTx } from '../store/tx.js';
import { logger } from '../logger.js';

/**
 * 执行一轮 GC：清理所有回看期满的唯一码。经串行执行器提交，与收码/状态变更串行（无竞态）。
 * @param {import('../services.js').Services} services
 * @returns {Promise<{ purgedCodes:number, purgedLeases:number }>}
 */
export async function runGc(services) {
  const { store, exec } = services;
  const expirable = store.accessCode.listExpirable(Date.now());
  if (!expirable.length) return { purgedCodes: 0, purgedLeases: 0 };

  // 单码清理事务：校验无 active 租约 → 删 processed_mail/lease/access_code + 记审计（原子）
  const purgeOne = immediateTx(store.db, (code) => {
    if (store.lease.getActiveByCode(code)) return { purged: false, leases: 0 }; // 安全兜底
    const leases = store.lease.listByCode(code);
    for (const l of leases) store.processedMail.deleteByLease(l.id);
    store.lease.deleteByCode(code);
    store.accessCode.delete(code);
    store.auditLog.insert({
      ts: Date.now(),
      actor: 'gc',
      action: 'purge_expired',
      target: code,
      detail: `leases=${leases.length}`, // 脱敏摘要，不含邮件内容
    });
    return { purged: true, leases: leases.length };
  });

  let purgedCodes = 0;
  let purgedLeases = 0;
  for (const c of expirable) {
    try {
      const r = await exec.submit(() => purgeOne(c.code));
      if (r.purged) {
        purgedCodes++;
        purgedLeases += r.leases;
      }
    } catch (err) {
      logger.warn({ code: c.code, err: err.message }, 'GC 清理单码失败（下轮重试）');
    }
  }
  logger.info({ purgedCodes, purgedLeases }, 'GC 清理完成');
  return { purgedCodes, purgedLeases };
}

/**
 * 启动周期 GC。返回 `{ stop }` 供优雅停机调用。
 * @param {import('../services.js').Services} services
 * @param {{ intervalMs:number }} opts
 * @returns {{ stop: () => void }}
 */
export function startGc(services, { intervalMs }) {
  const tick = () => {
    runGc(services).catch((err) => logger.error({ err: err.message }, 'GC 任务异常'));
  };
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  logger.info({ intervalMs }, 'GC 定时任务已启动');
  return {
    stop() {
      clearInterval(handle);
    },
  };
}

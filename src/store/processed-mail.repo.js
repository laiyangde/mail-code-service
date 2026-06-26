/**
 * processed_mail 表 CRUD（纯 SQL）：收码幂等（FR-0 M5）。
 * 复合主键 (account_id, uid) 拦重复邮件；markProcessed 返回是否为首次处理。
 */

/** @param {import('better-sqlite3').Database} db */
export function createProcessedMailRepo(db) {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO processed_mail (account_id, uid, lease_id, processed_at)
     VALUES (?, ?, ?, ?)`,
  );
  const existsStmt = db.prepare(`SELECT 1 FROM processed_mail WHERE account_id = ? AND uid = ?`);
  const deleteByLeaseStmt = db.prepare(`DELETE FROM processed_mail WHERE lease_id = ?`);

  return {
    /** 记录已处理邮件；返回 true=首次（应处理），false=重复（应丢弃，幂等去重） */
    markProcessed({ accountId, uid, leaseId, processedAt }) {
      return insertStmt.run(accountId, uid, leaseId ?? null, processedAt).changes === 1;
    },
    exists(accountId, uid) {
      return !!existsStmt.get(accountId, uid);
    },
    /** 物理删除某租约的幂等记录（GC 用，FR-10.3） */
    deleteByLease(leaseId) {
      return deleteByLeaseStmt.run(leaseId).changes;
    },
  };
}

/**
 * access_code 表 CRUD（纯 SQL）。
 * 含 FR-0 关键的原子条件扣减配额（decrementQuota），供 M5 收码事务复用。
 */

/** @param {import('better-sqlite3').Database} db */
export function createAccessCodeRepo(db) {
  const insertStmt = db.prepare(
    `INSERT INTO access_code (code, prefix, status, quota_left, issued_at, retain_until, bound_lease_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStmt = db.prepare(`SELECT * FROM access_code WHERE code = ?`);
  const listByStatusStmt = db.prepare(`SELECT * FROM access_code WHERE status = ?`);
  const listExpirableStmt = db.prepare(
    `SELECT * FROM access_code WHERE status = 'used' AND retain_until IS NOT NULL AND retain_until < ?`,
  );
  const updateStatusStmt = db.prepare(`UPDATE access_code SET status = ? WHERE code = ?`);
  const setStatusRetainStmt = db.prepare(
    `UPDATE access_code SET status = ?, retain_until = ? WHERE code = ?`,
  );
  const setBoundLeaseStmt = db.prepare(`UPDATE access_code SET bound_lease_id = ? WHERE code = ?`);
  const decrementQuotaStmt = db.prepare(
    `UPDATE access_code SET quota_left = quota_left - 1 WHERE code = ? AND quota_left > 0`,
  );
  const deleteStmt = db.prepare(`DELETE FROM access_code WHERE code = ?`);

  return {
    insert(c) {
      insertStmt.run(
        c.code,
        c.prefix,
        c.status ?? 'unused',
        c.quotaLeft,
        c.issuedAt,
        c.retainUntil ?? null,
        c.boundLeaseId ?? null,
      );
      return c.code;
    },
    getByCode(code) {
      return mapRow(getStmt.get(code));
    },
    listByStatus(status) {
      return listByStatusStmt.all(status).map(mapRow);
    },
    /** 列出已收码且回看期满（retain_until < now）的码，供 GC（FR-10） */
    listExpirable(now) {
      return listExpirableStmt.all(now).map(mapRow);
    },
    updateStatus(code, status) {
      return updateStatusStmt.run(status, code).changes;
    },
    setStatusAndRetain(code, status, retainUntil) {
      return setStatusRetainStmt.run(status, retainUntil ?? null, code).changes;
    },
    setBoundLease(code, leaseId) {
      return setBoundLeaseStmt.run(leaseId ?? null, code).changes;
    },
    /** 原子条件扣减配额（INV-3）：仅 quota_left>0 时减 1，返回受影响行数（M5 事务②应=1） */
    decrementQuota(code) {
      return decrementQuotaStmt.run(code).changes;
    },
    /** 物理删除唯一码（GC 用，FR-10.3；须先删其 lease/processed_mail 以满足外键） */
    delete(code) {
      return deleteStmt.run(code).changes;
    },
  };
}

/** @param {Record<string, unknown> | undefined} row */
function mapRow(row) {
  if (!row) return undefined;
  return {
    code: row.code,
    prefix: row.prefix,
    status: row.status,
    quotaLeft: row.quota_left,
    issuedAt: row.issued_at,
    retainUntil: row.retain_until,
    boundLeaseId: row.bound_lease_id,
  };
}

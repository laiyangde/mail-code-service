/**
 * audit_log 表 CRUD（纯 SQL）。detail 为对象时序列化为 JSON。
 * 注意：调用方须确保 detail 已脱敏（不含明文凭据/cookie），repo 不负责脱敏（NFR-1）。
 */

/** @param {import('better-sqlite3').Database} db */
export function createAuditLogRepo(db) {
  const insertStmt = db.prepare(
    `INSERT INTO audit_log (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)`,
  );
  const listStmt = db.prepare(`SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?`);

  return {
    insert({ ts, actor, action, target, detail }) {
      const detailStr =
        detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail);
      insertStmt.run(ts, actor ?? null, action, target ?? null, detailStr);
    },
    list(limit = 100) {
      return listStmt.all(limit);
    },
  };
}

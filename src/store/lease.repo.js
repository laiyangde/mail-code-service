/**
 * lease 表 CRUD（纯 SQL）。mail_meta 以 JSON 文本存取。
 * 含 FR-0 关键的原子收码①（markReceived：仅 active→received），供 M5 收码事务复用。
 */

/** @param {import('better-sqlite3').Database} db */
export function createLeaseRepo(db) {
  const insertStmt = db.prepare(
    `INSERT INTO lease
       (id, access_code, plan, account_id, alias, status, start_time, expires_at, mail_uid, mail_meta, code, renews, receiving, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStmt = db.prepare(`SELECT * FROM lease WHERE id = ?`);
  const activeByAccountStmt = db.prepare(
    `SELECT * FROM lease WHERE account_id = ? AND status = 'active'`,
  );
  const activeByCodeStmt = db.prepare(
    `SELECT * FROM lease WHERE access_code = ? AND status = 'active'`,
  );
  const listByStatusStmt = db.prepare(`SELECT * FROM lease WHERE status = ?`);
  const listByCodeStmt = db.prepare(
    `SELECT * FROM lease WHERE access_code = ? ORDER BY created_at`,
  );
  const updateStatusStmt = db.prepare(`UPDATE lease SET status = ? WHERE id = ?`);
  const deleteByCodeStmt = db.prepare(`DELETE FROM lease WHERE access_code = ?`);
  const deleteByAccountStmt = db.prepare(`DELETE FROM lease WHERE account_id = ?`);
  const countByStatusStmt = db.prepare(`SELECT COUNT(*) AS n FROM lease WHERE status = ?`);
  const markReceivedStmt = db.prepare(
    `UPDATE lease SET status='received', mail_uid=?, mail_meta=?, code=?
       WHERE id=? AND status='active'`,
  );
  const pendingByCodeStmt = db.prepare(
    `SELECT * FROM lease WHERE access_code = ? AND status = 'pending'`,
  );
  const promoteStmt = db.prepare(
    `UPDATE lease SET status='active', account_id=?, alias=?, start_time=?, expires_at=?
       WHERE id=? AND status='pending'`,
  );
  const markReceivingStmt = db.prepare(
    `UPDATE lease SET receiving=1 WHERE id=? AND status='active'`,
  );

  return {
    insert(l) {
      insertStmt.run(
        l.id,
        l.accessCode ?? null,
        l.plan,
        l.accountId ?? null,
        l.alias ?? null,
        l.status,
        l.startTime ?? null,
        l.expiresAt ?? null,
        l.mailUid ?? null,
        l.mailMeta ? JSON.stringify(l.mailMeta) : null,
        l.code ?? null,
        l.renews ?? 0,
        l.receiving ?? 0,
        l.createdAt,
      );
      return l.id;
    },
    getById(id) {
      return mapRow(getStmt.get(id));
    },
    getActiveByAccount(accountId) {
      return mapRow(activeByAccountStmt.get(accountId));
    },
    getActiveByCode(accessCode) {
      return mapRow(activeByCodeStmt.get(accessCode));
    },
    listByStatus(status) {
      return listByStatusStmt.all(status).map(mapRow);
    },
    /** 该唯一码的全部租约（按创建时间，供收码结果回看 FR-2.7） */
    listByCode(accessCode) {
      return listByCodeStmt.all(accessCode).map(mapRow);
    },
    updateStatus(id, status) {
      return updateStatusStmt.run(status, id).changes;
    },
    /** 物理删除某唯一码的全部租约（GC 用，FR-10.3；须先删 processed_mail 再删本表再删 access_code） */
    deleteByCode(accessCode) {
      return deleteByCodeStmt.run(accessCode).changes;
    },
    /** 物理删除某账号的全部租约（admin 删账号时用；须先删 processed_mail） */
    deleteByAccount(accountId) {
      return deleteByAccountStmt.run(accountId).changes;
    },
    /** 按状态计数（监控 NFR-6） */
    countByStatus(status) {
      return countByStatusStmt.get(status).n;
    },
    /** 原子收码①（INV-4）：仅 active→received，返回 changes（0=已非 active→丢弃此邮件） */
    markReceived({ id, mailUid, mailMeta, code }) {
      return markReceivedStmt.run(
        mailUid ?? null,
        mailMeta ? JSON.stringify(mailMeta) : null,
        code ?? null,
        id,
      ).changes;
    },
    /** 该唯一码当前的 pending 租约（排队中，供同码 activate 复用，INV-1′） */
    getPendingByCode(accessCode) {
      return mapRow(pendingByCodeStmt.get(accessCode));
    },
    /**
     * 原子 promote（pending→active）：条件 WHERE status='pending'，返回 changes
     * （0=该 pending 已被 cancel/超时置终态 → 放弃本次激活，归还预占账号）。
     */
    promoteToActive({ id, accountId, alias, startTime, expiresAt }) {
      return promoteStmt.run(
        accountId ?? null,
        alias ?? null,
        startTime ?? null,
        expiresAt ?? null,
        id,
      ).changes;
    },
    /** 用户确认已发送 → 开启收码（置 receiving=1，仅 active 生效，返回 changes） */
    markReceiving(id) {
      return markReceivingStmt.run(id).changes;
    },
  };
}

/** @param {Record<string, unknown> | undefined} row */
function mapRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    accessCode: row.access_code,
    plan: row.plan,
    accountId: row.account_id,
    alias: row.alias,
    status: row.status,
    startTime: row.start_time,
    expiresAt: row.expires_at,
    mailUid: row.mail_uid,
    mailMeta: row.mail_meta ? JSON.parse(row.mail_meta) : null,
    code: row.code,
    renews: row.renews,
    receiving: row.receiving,
    createdAt: row.created_at,
  };
}

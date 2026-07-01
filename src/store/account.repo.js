/**
 * email_account 表 CRUD（纯 SQL）。
 * 负责 row↔对象映射（snake_case 列 ↔ camelCase 字段、int↔bool）；
 * 不含业务判断、不读时钟（时间戳 updatedAt 由调用方传入）。
 */

/** @param {import('better-sqlite3').Database} db */
export function createAccountRepo(db) {
  const insertStmt = db.prepare(
    `INSERT INTO email_account
       (id, university, domain, group_name, status, creds_ref, current_alias, last_error, disabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getByIdStmt = db.prepare(`SELECT * FROM email_account WHERE id = ?`);
  const listStmt = db.prepare(`SELECT * FROM email_account`);
  const listEnabledStmt = db.prepare(`SELECT * FROM email_account WHERE disabled = 0`);
  const updateStatusStmt = db.prepare(
    `UPDATE email_account SET status = ?, updated_at = ? WHERE id = ?`,
  );
  const updateAliasStmt = db.prepare(
    `UPDATE email_account SET current_alias = ?, updated_at = ? WHERE id = ?`,
  );
  const updateErrorStmt = db.prepare(
    `UPDATE email_account SET last_error = ?, status = ?, updated_at = ? WHERE id = ?`,
  );
  const setDisabledStmt = db.prepare(
    `UPDATE email_account SET disabled = ?, updated_at = ? WHERE id = ?`,
  );
  const deleteStmt = db.prepare(`DELETE FROM email_account WHERE id = ?`);

  return {
    insert(a) {
      insertStmt.run(
        a.id,
        a.university,
        a.domain,
        a.groupName,
        a.status ?? 'free',
        a.credsRef,
        a.currentAlias ?? null,
        a.lastError ?? null,
        a.disabled ? 1 : 0,
        a.updatedAt,
      );
      return a.id;
    },
    getById(id) {
      return mapRow(getByIdStmt.get(id));
    },
    list() {
      return listStmt.all().map(mapRow);
    },
    listEnabled() {
      return listEnabledStmt.all().map(mapRow);
    },
    updateStatus(id, status, updatedAt) {
      return updateStatusStmt.run(status, updatedAt, id).changes;
    },
    updateAlias(id, currentAlias, updatedAt) {
      return updateAliasStmt.run(currentAlias ?? null, updatedAt, id).changes;
    },
    updateError(id, lastError, status, updatedAt) {
      return updateErrorStmt.run(lastError ?? null, status, updatedAt, id).changes;
    },
    setDisabled(id, disabled, updatedAt) {
      return setDisabledStmt.run(disabled ? 1 : 0, updatedAt, id).changes;
    },
    /** 物理删除账号（admin，须先删其关联租约以满足外键） */
    delete(id) {
      return deleteStmt.run(id).changes;
    },
  };
}

/** @param {Record<string, unknown> | undefined} row */
function mapRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    university: row.university,
    domain: row.domain,
    groupName: row.group_name,
    status: row.status,
    credsRef: row.creds_ref,
    currentAlias: row.current_alias,
    lastError: row.last_error,
    disabled: !!row.disabled,
    updatedAt: row.updated_at,
  };
}

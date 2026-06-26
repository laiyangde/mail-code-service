/**
 * plan 表 CRUD（纯 SQL）。allowed_groups/target_senders 以 JSON 文本存取；enabled int↔bool。
 */

/** @param {import('better-sqlite3').Database} db */
export function createPlanRepo(db) {
  const upsertStmt = db.prepare(
    `INSERT INTO plan
       (prefix, name, allowed_groups, target_senders, code_regex, quota, lease_ttl_sec, retention_sec, max_renews, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(prefix) DO UPDATE SET
       name=excluded.name, allowed_groups=excluded.allowed_groups, target_senders=excluded.target_senders,
       code_regex=excluded.code_regex, quota=excluded.quota, lease_ttl_sec=excluded.lease_ttl_sec,
       retention_sec=excluded.retention_sec, max_renews=excluded.max_renews, enabled=excluded.enabled`,
  );
  const getStmt = db.prepare(`SELECT * FROM plan WHERE prefix = ?`);
  const listStmt = db.prepare(`SELECT * FROM plan`);

  return {
    upsert(p) {
      upsertStmt.run(
        p.prefix,
        p.name,
        JSON.stringify(p.allowedGroups ?? []),
        JSON.stringify(p.targetSenders ?? []),
        p.codeRegex ?? null,
        p.quota ?? 1,
        p.leaseTtlSec ?? 900,
        p.retentionSec ?? 604800,
        p.maxRenews ?? 5,
        p.enabled === undefined ? 1 : p.enabled ? 1 : 0,
      );
      return p.prefix;
    },
    getByPrefix(prefix) {
      return mapRow(getStmt.get(prefix));
    },
    list() {
      return listStmt.all().map(mapRow);
    },
  };
}

/** @param {Record<string, unknown> | undefined} row */
function mapRow(row) {
  if (!row) return undefined;
  return {
    prefix: row.prefix,
    name: row.name,
    allowedGroups: JSON.parse(row.allowed_groups),
    targetSenders: JSON.parse(row.target_senders),
    codeRegex: row.code_regex,
    quota: row.quota,
    leaseTtlSec: row.lease_ttl_sec,
    retentionSec: row.retention_sec,
    maxRenews: row.max_renews,
    enabled: !!row.enabled,
  };
}

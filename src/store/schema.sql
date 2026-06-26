-- mail-code-service · 数据库 schema（幂等建表 + FR-0 护栏索引）
-- 注意：连接级 PRAGMA（journal_mode=WAL / foreign_keys=ON）在 store/db.js 的 openDb 中设置。
-- 命名：group 是 SQL 保留字，列名用 group_name（语义即需求的 Group）。

-- 邮箱账号（凭据只存引用，明文进 .env/密钥库，NFR-1）
CREATE TABLE IF NOT EXISTS email_account (
  id            TEXT PRIMARY KEY,
  university    TEXT NOT NULL,
  domain        TEXT NOT NULL,
  group_name    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'free',   -- free|leased|reloging|unhealthy|disabled
  creds_ref     TEXT NOT NULL,
  current_alias TEXT,
  last_error    TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

-- 套餐（前缀）
CREATE TABLE IF NOT EXISTS plan (
  prefix         TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  allowed_groups TEXT NOT NULL,                   -- JSON array
  target_senders TEXT NOT NULL,                   -- JSON array（域名/通配）
  code_regex     TEXT,
  quota          INTEGER NOT NULL DEFAULT 1,
  lease_ttl_sec  INTEGER NOT NULL DEFAULT 900,
  retention_sec  INTEGER NOT NULL DEFAULT 604800, -- 7 天
  max_renews     INTEGER NOT NULL DEFAULT 5,
  enabled        INTEGER NOT NULL DEFAULT 1
);

-- 唯一码
CREATE TABLE IF NOT EXISTS access_code (
  code           TEXT PRIMARY KEY,
  prefix         TEXT NOT NULL REFERENCES plan(prefix),
  status         TEXT NOT NULL DEFAULT 'unused',          -- unused|active|used|expired|revoked
  quota_left     INTEGER NOT NULL CHECK (quota_left >= 0), -- INV-3：永不为负
  issued_at      INTEGER NOT NULL,
  retain_until   INTEGER,                                  -- NULL=未使用，永久保留
  bound_lease_id TEXT
);

-- 租约
CREATE TABLE IF NOT EXISTS lease (
  id          TEXT PRIMARY KEY,
  access_code TEXT REFERENCES access_code(code),
  plan        TEXT NOT NULL,
  account_id  TEXT REFERENCES email_account(id),
  alias       TEXT,
  status      TEXT NOT NULL,             -- pending|active|received|expired|cancelled|rejected
  start_time  INTEGER,
  expires_at  INTEGER,
  mail_uid    INTEGER,
  mail_meta   TEXT,                      -- JSON：整封邮件 from/to/subject/date/text/html
  code        TEXT,                      -- 可选便利提取
  renews      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- 收码幂等（M5）
CREATE TABLE IF NOT EXISTS processed_mail (
  account_id   TEXT NOT NULL,
  uid          INTEGER NOT NULL,
  lease_id     TEXT,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, uid)
);

-- 审计（脱敏）
CREATE TABLE IF NOT EXISTS audit_log (
  ts     INTEGER NOT NULL,
  actor  TEXT,
  action TEXT,
  target TEXT,
  detail TEXT
);

-- ── 护栏索引（即便应用有 bug 也兜底，FR-0）──
-- 同码 / 同账号 至多一个活跃租约（INV-1 / INV-2）
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_lease_per_code
  ON lease(access_code) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_lease_per_account
  ON lease(account_id)  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_lease_status       ON lease(status);
CREATE INDEX IF NOT EXISTS idx_access_code_status ON access_code(status, retain_until);

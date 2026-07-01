-- mail-code-service · 数据库 schema（幂等建表 + FR-0 护栏索引）
-- 注意：连接级 PRAGMA（journal_mode=WAL / foreign_keys=ON）在 store/db.js 的 openDb 中设置。
-- 命名：group 是 SQL 保留字，列名用 group_name（语义即需求的 Group）。
-- 时间戳统一为 Unix 毫秒整数（INTEGER），由调用方传入，DB 层不读时钟。

-- 邮箱账号：一个真实高校邮箱（一个 EmailProvider 实例），接码的最小资源单位（FR-1.1）
-- 凭据只存引用（creds_ref），明文进 .env/密钥库，绝不落表（NFR-1）
CREATE TABLE IF NOT EXISTS email_account (
  id            TEXT PRIMARY KEY,               -- 账号唯一标识（EmailProvider.accountId）
  university    TEXT NOT NULL,                  -- 所属高校（展示/归类用，如「西南石油大学」）
  domain        TEXT NOT NULL,                  -- 邮箱域名（如 swpu.edu.cn），别名地址 = <alias>@<domain>
  group_name    TEXT NOT NULL,                  -- 账号分组：套餐据此限定可用账号（按大学/平台兼容性分组，C-2）
  status        TEXT NOT NULL DEFAULT 'free',   -- 健康/占用态：free|leased|reloging|unhealthy|disabled（FR-1.2）
  creds_ref     TEXT NOT NULL,                  -- 凭据引用（指向 .env/密钥库的 key 前缀，如 SWPU_ACCT_1），非明文（NFR-1）
  current_alias TEXT,                           -- 账号当前生效的别名（每账号同一时刻仅一个，C-1）；空闲时可为 NULL
  last_error    TEXT,                           -- 最近一次错误信息（登录/IMAP 失败等），供运维排查（FR-8.1）
  disabled      INTEGER NOT NULL DEFAULT 0,     -- 管理员禁用开关（0=启用，1=禁用）；禁用账号不参与分配
  updated_at    INTEGER NOT NULL               -- 最后更新时间戳（毫秒），状态/别名/错误变更时刷新
);

-- 套餐（前缀）：唯一码前缀对应的一套约束，决定唯一码归属与全部行为（FR-2.1）
CREATE TABLE IF NOT EXISTS plan (
  prefix         TEXT PRIMARY KEY,              -- 前缀（如 'gh'），唯一码形如 <prefix>-<random>，是套餐主键
  name           TEXT NOT NULL,                 -- 套餐展示名（如「GitHub 注册码」）
  allowed_groups TEXT NOT NULL,                 -- JSON array：允许使用的账号分组（业务定向，NFR-2）
  target_senders TEXT NOT NULL,                 -- JSON array：目标发件人（域名/通配，如 ["@github.com"]），收码 From 匹配（C-4）
  code_regex     TEXT,                          -- 验证码提取正则（可选便利字段，默认 \b\d{4,8}\b）；抽不到不影响交付（FR-4）
  quota          INTEGER NOT NULL DEFAULT 1,    -- 配额：一个唯一码允许的成功收码次数（默认 1，FR-2.5）
  lease_ttl_sec  INTEGER NOT NULL DEFAULT 900,  -- 租约存活秒数：给出别名后无码的超时上限（默认 900s=15min，FR-5.1）
  retention_sec  INTEGER NOT NULL DEFAULT 604800, -- 收码结果保留秒数：末次收码后可回看时长（默认 604800s=7 天，FR-2.8）
  max_renews     INTEGER NOT NULL DEFAULT 5,    -- 最大重申请次数：未收码时可重新获取邮箱的上限（FR-3.5）
  enabled        INTEGER NOT NULL DEFAULT 1     -- 套餐启用开关（0=停用，1=启用）；停用则其码无法激活
);

-- 唯一码：售卖/自用的访问凭证（<prefix>-<random≥128bit>），用户进入服务的 bearer token（FR-2.2）
CREATE TABLE IF NOT EXISTS access_code (
  code           TEXT PRIMARY KEY,              -- 唯一码全文（不可枚举，≥128bit 随机，NFR-1）
  prefix         TEXT NOT NULL REFERENCES plan(prefix), -- 所属套餐前缀（外键 → plan），决定全部约束
  status         TEXT NOT NULL DEFAULT 'unused',-- 生命周期：unused(永久有效)|active(收码中)|used(回看期内)|expired(失效)|revoked(吊销)
  quota_left     INTEGER NOT NULL CHECK (quota_left >= 0), -- 剩余配额：仅成功收码原子减 1（INV-3：永不为负）
  issued_at      INTEGER NOT NULL,              -- 签发时间戳（毫秒），批量生成时写入
  retain_until   INTEGER,                       -- 回看截止时间戳：NULL=未使用永久保留；首次收码后 = 末次收码 + retention_sec
  bound_lease_id TEXT                           -- 绑定的当前/最近租约 id（便利引用，单活跃租约约束见护栏索引）
);

-- 租约：一次「占用账号 + 设别名 + 等码」的会话，调度与超时的核心实体（FR-3.1）
CREATE TABLE IF NOT EXISTS lease (
  id          TEXT PRIMARY KEY,                 -- 租约唯一标识
  access_code TEXT REFERENCES access_code(code),-- 关联唯一码（外键）；自用 API 直接按套餐取码时可为 NULL（FR-7.2）
  plan        TEXT NOT NULL,                    -- 套餐前缀（冗余存便于回溯，不随 access_code 删除而丢失）
  account_id  TEXT REFERENCES email_account(id),-- 分配到的账号（外键）；PENDING 排队中尚未分配时为 NULL
  alias       TEXT,                             -- 本次租约设定的唯一别名（收码 To 匹配的主隔离键，C-4）
  status      TEXT NOT NULL,                    -- 状态机：pending|active|received|expired|cancelled|rejected（终态不可逆 INV-4）
  start_time  INTEGER,                          -- setAlias 完成时间戳：收码时间窗下界（秒级精筛 ≥ start_time，C-4）
  expires_at  INTEGER,                          -- 租约到期时间戳 = start_time + lease_ttl_sec；到期未收码则 EXPIRED（FR-3.4）
  mail_uid    INTEGER,                          -- 命中邮件的 IMAP UID；配合 processed_mail 做收码幂等（M5）
  mail_meta   TEXT,                             -- JSON：整封邮件原文（from/to/subject/date/text/html），交付物本体（FR-4.3）
  code        TEXT,                             -- 可选便利提取的验证码（按 code_regex 尽力抽取，抽不到为 NULL）
  renews      INTEGER NOT NULL DEFAULT 0,       -- 已重申请次数，受 plan.max_renews 约束（FR-3.5）
  receiving   INTEGER NOT NULL DEFAULT 0,       -- 收码是否已开启：0=已设别名待用户确认（未连 IMAP），1=用户已确认、收码中
  created_at  INTEGER NOT NULL                  -- 租约创建时间戳（毫秒），回看按此排序（FR-2.7）
);

-- 收码幂等：记录已处理邮件，同一封邮件二次进入直接丢弃，杜绝重复交付（M5）
CREATE TABLE IF NOT EXISTS processed_mail (
  account_id   TEXT NOT NULL,                   -- 邮件所属账号 id
  uid          INTEGER NOT NULL,                -- 邮件 IMAP UID（账号内唯一）
  lease_id     TEXT,                            -- 交付到的租约 id（可为 NULL：命中但无活跃租约时仍记录以防重复处理）
  processed_at INTEGER NOT NULL,                -- 处理时间戳（毫秒）
  PRIMARY KEY (account_id, uid)                 -- 复合主键：(账号, UID) 唯一，IMAP 事件重复触发时第二次被主键拦截（M5）
);

-- 审计日志：关键操作的脱敏流水，绝不含明文凭据（NFR-1）
CREATE TABLE IF NOT EXISTS audit_log (
  ts     INTEGER NOT NULL,                      -- 事件时间戳（毫秒）
  actor  TEXT,                                  -- 操作主体（管理员/系统/API key 标识等）
  action TEXT,                                  -- 操作类型（如 create_lease / deliver_mail / revoke_code）
  target TEXT,                                  -- 操作对象（唯一码/租约 id/账号 id 等）
  detail TEXT                                   -- 附加详情（脱敏文本，不含密码/cookie/IMAP 密码）
);

-- ── 护栏索引（即便应用有 bug 也兜底，FR-0）──
-- 同码 / 同账号 至多一个活跃租约（INV-1 / INV-2）
-- partial unique index：仅约束 status='active' 行，DB 层直接拒绝第二个活跃租约（M2）
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_lease_per_code
  ON lease(access_code) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_lease_per_account
  ON lease(account_id)  WHERE status = 'active';
-- 同码至多一个 pending 租约（INV-1′：排队期同码单一，配合单飞锁 + createLease 复用 pending）
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_lease_per_code
  ON lease(access_code) WHERE status = 'pending';
-- 按状态查租约（恢复未决租约、监控计数 NFR-6）
CREATE INDEX IF NOT EXISTS idx_lease_status       ON lease(status);
-- 加速 GC 扫描「已收码且回看期满」的码（status='used' AND retain_until < now，FR-10.2）
CREATE INDEX IF NOT EXISTS idx_access_code_status ON access_code(status, retain_until);

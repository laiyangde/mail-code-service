# CLAUDE.md

本文件指导 Claude Code 在本仓库中工作。聚焦本项目特有的架构、不变量与约定；通用开发偏好见全局 `~/.claude/CLAUDE.md`。

## 项目概述

**mail-code-service** 把「高校邮箱别名 + 收码」这一单账号能力，产品化为可售卖、可自用的**接码服务**：多账号编排、按唯一码（前缀）访问控制、别名互斥下的租约调度、超时自动释放，提供 **Web 页面**（`/{code}`）与 **HTTP API** 两种取码入口。

**设计取向（决定一切实现风格）**：账号数少（≤3）、并发取码极少发生，因此**正确性与健壮性 > 吞吐**。

> **最高优先级是 FR-0「杜绝一码多码」**——一个唯一码在配额内有且仅有约定次数的成功收码。任何改动若触及租约、收码交付、配额、状态流转，**必须先读完下方「核心不变量」并保证不破坏它**。完整设计见 `docs/邮箱接码服务.md`，用法见 `README.md`。

## 常用命令

```bash
npm install                  # Node ≥ 20，ESM 工程
npm run migrate              # 建库（幂等，可重复执行，不破坏已有数据）
npm run web:build            # 构建前端（不构建则 Web 取码页 404，仅 API 可用）
npm run dev                  # 开发模式（node --watch 自动重启）
npm start                    # 生产模式

npm test                     # 全量单测 / 集成 / 竞态（vitest run）
npm run test:race            # 仅跑 FR-0 竞态用例（test/race）
npx vitest run test/lease/lease-manager.test.js   # 跑单个测试文件
npm run lint                 # eslint + prettier --check（提交前必跑）
npm run format               # prettier --write 全量格式化

npm run demo:swpu            # 单账号 Provider 自检（连真账号：登录→设别名→IMAP 收码）
docker compose up -d --build # 生产部署（单实例 + 持久化 volume）
```

**验证流程**：改完代码后务必依次跑 `npm run lint` 与 `npm test`；涉及 FR-0 的改动额外跑 `npm run test:race`。

## 架构总览

### 取码闭环（数据流）

```
activate(唯一码) → AccessService 校验分流 → AccountPool 取空闲账号(或排队)
  → provider.setAlias(唯一别名) → 建 active 租约 → ReceiverHub 按需连 IMAP + 绑定收码 + 起超时定时器
  → IMAP 命中邮件(To+From+时间窗) → 原子交付(active→received + 扣配额) → 释放账号(后台断 IMAP) → SSE/webhook 推送整封邮件
  └─(15min 无码)→ expired → 释放 → 可 renew
```

### 分层与目录（`src/`）

| 目录 | 职责 |
|---|---|
| `provider/` | `EmailProvider` 统一接口 + `swpu/` 实现；`factory.js` 按大学/域名分派。**调度核心只认接口，永不直接碰浏览器/HTTP/IMAP** |
| `pool/` | `AccountPool` 账号池：原子 acquire/release、健康态 |
| `lease/` | **`LeaseManager` 调度核心**；`ports/`（`lock`/`queue` 内存实现，预留 Redis）；`timer`、`alias-generator` |
| `access/` | `AccessService` 唯一码校验分流、配额、状态流转；`code-gen` 唯一码生成 |
| `receiver/` | `ReceiverHub` IMAP 聚合（**按需连**：绑定租约时建连、释放/收码/超时时断连），命中邮件路由到账号当前活跃租约 |
| `api/` | `public`/`v1`/`admin` 路由 + `sse-hub` + `webhook` + `auth`（鉴权钩子）+ `response`（统一响应） |
| `cleaner/` | `cleaner` 删信定时任务、`gc` 回看期满清理 |
| `store/` | SQLite 持久化：`schema.sql`/`db`/`migrate`/`tx` + 六个 `*.repo.js`（account/plan/access-code/lease/processed-mail/audit-log） |
| `core/` | `serial-executor` 单写串行执行器、`state-machine` 状态机 |
| `services.js` | 装配核心栈（`buildServices`），生产与测试共用，消除装配漂移 |
| `index.js` | 启动入口：装配 → 加载会话 → 事件桥 → 重启恢复(按需重连 IMAP) → 定时任务 → 监听 → 优雅停机 |

前端在 `web/`（React 19 + Vite，SSE 取码）；测试在 `test/`（`helpers/harness.js` 用内存 DB + fake provider 装配整栈）。

### 三类 API 入口（各自独立鉴权，统一响应 `{ errCode, errMsg, data }`，成功 `errCode: 0`）

| 入口 | 前缀 | 鉴权 | 未配置密钥 |
|---|---|---|---|
| 公开（付费用户取码） | `/api/public` | 无（凭唯一码本身） | — |
| 自用 API（内部脚本） | `/api/v1` | `X-API-Key: <API_KEY>` | `503 API_DISABLED` |
| Admin（管理后台） | `/api/admin` | `Authorization: Bearer <ADMIN_TOKEN>` | `503 ADMIN_DISABLED` |

密钥比较用定长安全比较（防时序侧信道）；**留空密钥视为「该入口未启用」而非放行任何人**。

### 技术栈

Fastify 5（HTTP）+ `fastify-sse-v2`（SSE）+ `@fastify/static`/`@fastify/rate-limit`；**`better-sqlite3`**（同步、单写连接，天然串行化，契合 FR-0）；`imapflow` + `mailparser`（收码/删信）；`axios`（别名 HTTP）；`cloakbrowser` + `playwright-core`（**仅登录**用，常态不开浏览器）。

## 核心不变量（FR-0）— 触碰调度/收码/配额前必读

「杜绝一码多码」由 **DB 约束 + 单写串行事务**双重保证，**不依赖应用层自觉**：

| 编号 | 不变量 | 强制手段 |
|---|---|---|
| INV-1 | 一个 `accessCode` 至多一个 `active` 租约 | DB partial unique index `uq_active_lease_per_code` |
| INV-2 | 一个 `account` 至多一个 `active` 租约 | DB partial unique index `uq_active_lease_per_account` |
| INV-3 | 配额扣减是原子条件更新，仅在 `active→received` 唯一一次发生，`quota_left` 永不为负 | `UPDATE ... WHERE quota_left>0` + 校验行数 + `CHECK(quota_left>=0)` |
| INV-4 | 终态（received/expired/cancelled/rejected）不可逆；非 active 租约绝不交付、绝不扣配额 | 状态机 + `WHERE status='active'` |
| INV-5 | 「码交付」与「扣配额」在同一事务内原子完成 | 单事务包裹（`LeaseManager._deliverTx`，`store/tx.js` 的 `immediateTx`） |
| INV-6 | 一切「读—判断—写」收敛为 DB 原子操作或单飞锁内串行，无 TOCTOU | `SerialExecutor` + 内存单飞锁 |

**并发模型（`LeaseManager` 的关键设计）**：
- **状态变更（DB 写）一律经 `SerialExecutor.submit`**，短小同步，消除竞态；
- **慢 I/O（`provider.setAlias`，可能开浏览器）放在执行器外**，不阻塞其它账号（跨账号并行、账号内串行）；
- **单飞锁**（`lock.runExclusive(accessCode)`）：同码并发 activate 串行，第二个进入即复用首个活跃租约；
- **收码交付**是执行器内的**同步原子事务**（权威幂等 + active→received + 扣配额）。

状态机定义在 `core/state-machine.js`：任何状态变更前调 `assertLeaseTransition`/`assertAccessCodeTransition` 校验，非法转移（如终态改回 active）直接抛错。

## 关键约定

- **凭据只存 `.env`**（已 gitignore），DB `email_account.creds_ref` 仅存 `.env` 变量**前缀引用**（如 `SWPU_ACCT_1`），明文绝不落表，日志全链路脱敏（NFR-1）。**新增账号前必须先把凭据写进 `.env`**。
- **时间戳统一为 Unix 毫秒整数**，由调用方传入，DB 层不读时钟（便于测试与确定性）。
- **配置集中在 `config.js`**：有默认值的启动即解析；必填凭据用 `requireEnv` 惰性校验（避免起服务即因下游凭据缺失而失败）。完整环境变量见 `.env.example`。
- **错误处理**：调度层抛 `ApiError`（`errors.js` 的 `ErrorCode`），API 层统一映射为 `{ errCode, errMsg, data }`。
- **代码风格**：ESM；Prettier（单引号、分号、`printWidth: 100`、`trailingComma: all`、2 空格、箭头函数始终带括号）；注释用中文、JSDoc3 风格，代码标识符用英文。

## 开发注意事项（易踩的坑）

- **单实例有状态服务，不可横向扩展**：IMAP 连接（按需，仅租约存活期内）、账号锁、PENDING 队列、租约超时定时器、SSE 推送均为**进程内内存态**，必须由唯一进程持有。多实例不增容量（容量=账号数）反引入双占风险。
- **`ReceiverHub` 注入的交付处理器在串行执行器上下文内被同步调用，内部不得再 `submit`**（直接操作 store），否则破坏原子性。见 `LeaseManager._deliver` 与 `setDeliverHandler` 的约定。
- **IMAP 按需连接**：启动不再常驻全连；`ReceiverHub.bindLease` 在 `setAlias` 成功后**按需建 IMAP 连接**，收码/超时/取消时后台断连。连接失败 → `LeaseManager` 回滚本次申请（`active→cancelled`、释放账号、码退回 `unused`、返回 `RECEIVER_UNAVAILABLE`）。`SwpuImap` 以 `#opChain`+`#epoch` 串行化 start/stop 并隔离过期连接的事件/重连；重启恢复对 active 租约即时重连。见 `receiver-hub.js`、`lease-manager.js`、`swpu/imap.js`。
- **新增大学** = 在 `provider/<school>/` 实现 `EmailProvider` + 在 `provider/factory.js` 登记分支 + 填配置，**调度核心/FR-0/API/前端零改动**（设计见 `docs/邮箱接码服务.md` §0）。
- **改 `schema.sql` 后**需重跑 `npm run migrate`；护栏索引（partial unique index）是 FR-0 的 DB 兜底，**勿删除或弱化**。
- **删除/重置数据**：`docker compose down -v` 会连数据卷一起删（清空 DB），慎用。

## 参考文档

- `README.md` — 部署与使用（Docker / 源码、Admin 全流程、API 参考）
- `docs/邮箱接码服务.md` — 完整需求与设计（FR-0 不变量、各大学差异点、威胁路径封堵、验收标准）
- `docs/开发实施计划.md` — 分阶段（M0–M8）实施计划

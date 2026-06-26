# mail-code-service · 高校邮箱接码服务

把「高校邮箱别名 + 收码」单账号能力，**产品化**为可售卖、可自用的接码服务：多账号编排、按订单（唯一码 + 前缀）访问控制、别名互斥下的租约调度、超时自动释放，对外提供 **Web 页面** 与 **HTTP API** 两种取码入口。

> **独立项目**：独立 git、独立技术栈，与 `register-factory` **无源码耦合**。开发阶段暂置于其目录下，仅为参考其 `emailManage`（SWPU 登录/别名/IMAP 收码）等既有能力，后续迁出为独立仓库。

## 文档

- 需求（WHAT/WHY，逐条 FR/不变量/验收）：`docs/邮箱接码服务.md`
- 实施计划（HOW/WHEN，里程碑 M0–M8）：`docs/开发实施计划.md`

## 技术栈

`fastify` + `better-sqlite3`（单实例、同步、单写串行，契合「杜绝一码多码」）+ `imapflow`/`mailparser`（收码/删信）+ `axios`（别名 HTTP）+ `cloakbrowser`（仅登录）；前端 `React` + `Vite`。**首版单实例、不引入 Redis**（队列/锁走进程内存，以 `QueuePort`/`LockPort` 预留升级路径）。

## 快速开始

```bash
npm install
cp .env.example .env      # 填写账号/IMAP/打码凭据与 API_KEY/ADMIN_TOKEN（见「配置」）
npm run migrate           # 建库（幂等，可重复执行）

# 开发：仅起后端，GET /healthz 应返回 { ok: true }
npm run dev

# 生产：先构建前端（index.js 仅当 web/dist 存在才托管页面），再起服务
npm run web:build
npm start
```

启动后：

- **Web 取码页**：浏览器访问 `http://<host>:<PORT>/<唯一码>`（如 `/svc-xxxx`），点「申请邮箱」→ 倒计时 → SSE 实时回显整封邮件。
- **健康检查**：`GET /healthz`（含池水位、IMAP 健康数、排队数、SSE 连接数）。
- **单账号 Provider 自检**（真账号联调）：`npm run demo:swpu`（设别名 → IMAP 收码 → 打印整封邮件）。

## 配置

凭据**仅存 `.env`**（已 gitignore），DB 只存引用，日志全链路脱敏（NFR-1）。完整项见 `.env.example`，关键变量：

| 变量 | 说明 |
|---|---|
| `PORT` / `SESSION_DATA_DIR` | 端口 / 运行态目录（SQLite + 会话缓存，挂 volume） |
| `API_KEY` / `ADMIN_TOKEN` | 自用 API（`X-API-Key`）/ Admin（`Bearer`）鉴权；**留空则该入口返回 503 未启用** |
| `SWPU_ACCT_1_NAME` / `_PASS` / `_IMAP_PASS` / `_GROUP` | 单账号登录名 / 登录密码 / IMAP 独立密码 / 分组（多账号用编号后缀） |
| `SWPU_CAPTCHA_API_TOKEN` | 登录图形验证码打码（云码） |
| `IMAP_HOST` / `IMAP_PORT` | 收码 IMAP（默认 `mailgate.swpu.edu.cn:993`） |
| `LEASE_TTL_SEC` / `ACQUIRE_TIMEOUT_SEC` / `RETENTION_SEC` | 租约无码上限 900s / 排队等待上限 60s / 收码保留期 7 天（可被单个 plan 覆盖） |
| `RATE_LIMIT_*` / `WEBHOOK_*` / `CLEANUP_*` / `GC_*` | activate 限流 / 自用 webhook / 删信周期 / 回看期满 GC |

## API 速览

响应统一 `{ errCode, errMsg, data }`。详见需求文档 §9。

**公开入口**（凭唯一码，无需鉴权，`/api/public`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/activate` | `{ code }` → 分流 `active`（含别名/到期）/ `used` 回看 / 错误码 |
| GET | `/leases/:id` | 轮询租约状态 |
| GET | `/leases/:id/stream` | **SSE** 实时推送：`message`(状态) / `done`(终态，附整封邮件) |
| POST | `/leases/:id/renew` · `/cancel` | 超时重申请 / 提前释放 |
| GET | `/codes/:code/results` | 收码结果回看（保留期内的整封历史邮件） |

**自用 API**（`X-API-Key`，`/api/v1`）：`POST /leases`（可带 `callbackUrl` webhook）· `GET /leases/:id` · `DELETE /leases/:id`

**Admin**（`Authorization: Bearer <ADMIN_TOKEN>`，`/api/admin`）：`accounts`（增删/启停/强制重登，新增即热起 IMAP）· `plans` · `codes`（批量生成/吊销）· `stats`

## 测试与验收

```bash
npm test            # 全量单测/集成/竞态：113 通过 / 16 文件
npm run test:race   # 仅 FR-0「杜绝一码多码」六个竞态用例
npm run lint        # eslint + prettier
```

- **FR-0 头号不变量**：DB partial unique index + CHECK + 单写串行执行器 + 原子收码事务 + 收码幂等 + 终态不可逆，六个竞态用例全过。
- **真实账号端到端**（已用真实 SWPU 账号验证）：
  - *Provider 级*——CloakBrowser 登录 + 打码 + 会话持久化复用 + 别名改名（HTTP `action=mod`）+ IMAP 三重匹配交付整封邮件 + 删信（`STORE \Deleted` + `EXPUNGE` 按 UID）；
  - *服务级*——Admin 热注册账号 → 生成唯一码 → `activate` 取别名 → **SSE 实时回显**收到的整封邮件 → 原子扣配额 → 回看，全链路打通。

## 部署

单容器 Docker（`Dockerfile` + `docker-compose.yml`）：构建期预置 CloakBrowser 二进制，运行期固定 `CLOAKBROWSER_BINARY_PATH` + `AUTO_UPDATE=false`；`data/` 挂 named volume（重启恢复占用/租约/配额，C-6）；`--init` 回收 Chromium 子进程；有头登录配 Xvfb。优雅停机（SIGTERM）先停接收、持久化在途、关闭 IMAP 再退出。

```bash
docker compose up -d        # 起单实例 + data volume
```

## 项目状态

里程碑 M0–M8 全部完成，单测 113 通过、lint 0 错、真实账号 Provider 级与服务级端到端均已跑通。

- [x] **M0** 工程脚手架：ESM 工程 + 配置/脱敏日志 + `/healthz`
- [x] **M1** 持久化与状态地基：DDL + 护栏索引 + 状态机 + 单写串行执行器
- [x] **M2** Provider（SWPU）· **M3** AccountPool · **M4** ReceiverHub
- [x] **M5** LeaseManager + FR-0 全护栏（核心，含一码多码竞态用例）
- [x] **M6** 接入层 API：public/v1/admin 路由 + SSE 实时回显 + 限流 + 统一错误码
- [x] **M7** Web 前端（React `/{code}`：申请邮箱/倒计时/SSE 回显整封邮件/重申请/回看）
- [x] **M8** 运维/部署：Cleaner 删信 + 7 天 GC + 重启恢复 + 优雅停机 + Docker

## 目录

```
src/
├── provider/     # A 层 EmailProvider 接口 + SWPU 实现（仅登录走浏览器）
├── pool/         # B 层 账号池（空闲选取/健康/原子加锁）
├── lease/        # C 层 租约调度（核心）+ ports（QueuePort/LockPort 内存实现）
├── access/       # D 层 套餐/前缀/唯一码 校验与配额
├── receiver/     # E 层 IMAP 聚合收码 → 路由到活跃租约
├── api/          # F 层 public / v1 / admin 路由 + SSE
├── cleaner/      # H 层 删信 + 7 天 GC 定时任务
├── store/        # G 层 SQLite 持久化（schema/migrate/repo/tx）
├── core/         # 单写串行执行器 + 状态机
├── config.js  logger.js  index.js
web/              # React 前端 /{code}
data/             # 运行态（SQLite + 会话缓存，gitignore，挂 volume）
```

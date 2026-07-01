# mail-code-service · 高校邮箱接码服务使用指南

把「高校邮箱别名 + 收码」单账号能力，产品化为可售卖、可自用的接码服务：多账号编排、按唯一码（前缀）访问控制、别名互斥下的租约调度、超时自动释放，提供 **Web 页面** 与 **HTTP API** 两种取码入口。

> 想了解设计与不变量（FR-0「杜绝一码多码」等），见 `docs/邮箱接码服务.md`；本文件只讲**怎么用**。

---

## 一、两种运行方式

### 方式 A：Docker 运行（推荐生产）

镜像在构建期预置隐身浏览器二进制、编译 native 模块、构建前端，开箱即用。

```bash
# 1. 准备配置（首次）
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
#    编辑 .env，至少填：ADMIN_TOKEN、API_KEY、SWPU_ACCT_1_* 账号凭据

# 2. 构建并后台启动（单实例 + 持久化 volume）
docker compose up -d --build

# 3. 验证
curl http://localhost:8080/healthz      # 返回 { "ok": true, ... } 即正常
docker compose logs -f                   # 看启动日志
```

要点（已在 `Dockerfile` / `docker-compose.yml` 配好，无需改动）：

- 端口 `8080:8080`；数据卷 `mcs-data → /app/data`（SQLite + 会话缓存，**重启不丢**占用/租约/配额）。
- `init: true` 回收浏览器子进程；有头登录用 `xvfb-run` 提供虚拟显示。
- 健康检查每 30s 打 `/healthz`；`restart: unless-stopped` 自动拉起。

停止 / 更新：

```bash
docker compose down                      # 停止（保留数据卷）
docker compose up -d --build             # 改代码后重建
docker compose down -v                   # 连数据卷一起删（慎用，清空 DB）
```

### 方式 B：源码运行（推荐开发调试）

需要 **Node ≥ 20**。

```bash
# 1. 安装依赖
npm install

# 2. 准备配置
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
#    编辑 .env（同上）

# 3. 建库（幂等，可重复执行，不破坏已有数据）
npm run migrate

# 4. 构建前端（不构建则 Web 取码页不可用，仅 API 可用）
npm run web:build

# 5. 启动
npm start                   # 生产模式
# 或
npm run dev                 # 开发模式（--watch 自动重启）
```

辅助脚本：

```bash
npm run demo:swpu           # 单账号 Provider 自检（真账号：登录→设别名→IMAP 收码→打印邮件）
npm test                    # 全量单测 / 集成 / 竞态用例
npm run lint                # eslint + prettier 检查
```

---

## 二、关键配置（`.env`）

凭据**仅存 `.env`**（已 gitignore），数据库只存引用，日志全链路脱敏。完整项见 `.env.example`，最常用：

| 变量 | 说明 |
|---|---|
| `PORT` | 服务端口，默认 `8080` |
| `SESSION_DATA_DIR` | 运行态目录（SQLite + 会话缓存），默认 `./data` |
| `ADMIN_TOKEN` | **Admin 鉴权令牌**。留空则 `/api/admin/*` 一律返回 `503`（未启用） |
| `API_KEY` | **自用 API 鉴权密钥**。留空则 `/api/v1/*` 一律返回 `503`（未启用） |
| `SWPU_ACCT_1_NAME` / `_PASS` / `_IMAP_PASS` / `_GROUP` | 账号登录名 / 登录密码 / IMAP 独立密码 / 分组。多账号用编号后缀：`SWPU_ACCT_2_NAME`… |
| `SWPU_CAPTCHA_API_TOKEN` | 登录图形验证码打码 token（云码） |
| `IMAP_HOST` / `IMAP_PORT` | 收码 IMAP，默认 `mailgate.swpu.edu.cn:993` |
| `LEASE_TTL_SEC` | 租约「无码」上限，默认 `900`（15 分钟） |
| `QUEUE_TIMEOUT_SEC` | 排队兜底上限，默认 `1800`（30min）；超此仍未轮到转 `rejected`。产品上不设硬超时，排队实时显示前面人数与已等待时长 |
| `RETENTION_SEC` | 成功收码后回看保留期，默认 `604800`（7 天） |
| `RATE_LIMIT_ACTIVATE_MAX` / `_WINDOW_SEC` | activate 限流：单 `code+IP` 窗口内最大次数 / 窗口秒数 |
| `WEBHOOK_SECRET` / `_TIMEOUT_MS` / `_MAX_RETRIES` | 自用 API webhook 的 HMAC 签名 / 超时 / 重试 |

> **账号凭据存放规则（重要）**：数据库 `email_account.creds_ref` 字段存的是 **`.env` 变量前缀**（如 `SWPU_ACCT_1`），运行时据此读取 `SWPU_ACCT_1_NAME/_PASS/_IMAP_PASS/_GROUP`。所以**新增账号前，必须先把该账号的凭据写进 `.env`**。

---

## 三、鉴权（三类入口，各自独立）

所有响应统一为 `{ errCode, errMsg, data }`：成功 `errCode: 0`，失败 `errCode` 为字符串错误码。

| 入口 | 前缀 | 鉴权方式 | 未配置密钥时 | 密钥错误时 |
|---|---|---|---|---|
| **公开**（付费用户取码） | `/api/public` | 无需鉴权（凭唯一码本身） | — | — |
| **自用 API**（内部脚本） | `/api/v1` | 请求头 `X-API-Key: <API_KEY>` | `503 API_DISABLED` | `401 UNAUTHORIZED` |
| **Admin**（管理后台） | `/api/admin` | 请求头 `Authorization: Bearer <ADMIN_TOKEN>` | `503 ADMIN_DISABLED` | `401 UNAUTHORIZED` |

> 密钥比较使用定长安全比较（防时序侧信道）。留空密钥被视为「该入口未启用」，而非「放行任何人」。

---

## 四、管理员完整流程（从零到可取码）

以下示例假设 `ADMIN_TOKEN=local-dev-admin`，服务跑在 `localhost:8080`。

### 1）先在 `.env` 配好账号凭据，再新增账号

`.env` 里确保有：

```
SWPU_ACCT_1_NAME=2020xxxx@swpu.edu.cn
SWPU_ACCT_1_PASS=登录密码
SWPU_ACCT_1_IMAP_PASS=IMAP授权码
SWPU_ACCT_1_GROUP=swpu
```

新增账号（`credsRef` 填上面的前缀 `SWPU_ACCT_1`）。**新增即热生效**：自动注册 provider 入池，无需重启；IMAP 在首次取码（绑定租约）时**按需建连**，不常驻。

```bash
curl -X POST http://localhost:8080/api/admin/accounts \
  -H "Authorization: Bearer local-dev-admin" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "swpu-1",
    "university": "西南石油大学",
    "domain": "swpu.edu.cn",
    "group": "swpu",
    "credsRef": "SWPU_ACCT_1"
  }'
```

其它账号管理：

```bash
curl http://localhost:8080/api/admin/accounts        -H "Authorization: Bearer local-dev-admin"   # 列表（脱敏，含健康度）
curl -X POST .../api/admin/accounts/swpu-1/disable   -H "Authorization: Bearer local-dev-admin"   # 禁用
curl -X POST .../api/admin/accounts/swpu-1/enable    -H "Authorization: Bearer local-dev-admin"   # 启用
curl -X POST .../api/admin/accounts/swpu-1/relogin   -H "Authorization: Bearer local-dev-admin"   # 强制重登
```

### 2）创建套餐（前缀 = 一套约束）

`group` 必须与账号分组匹配，套餐才能选到该账号。

```bash
curl -X POST http://localhost:8080/api/admin/plans \
  -H "Authorization: Bearer local-dev-admin" \
  -H "Content-Type: application/json" \
  -d '{
    "prefix": "gh",
    "name": "GitHub 注册码",
    "allowedGroups": ["swpu"],
    "targetSenders": ["@github.com"],
    "codeRegex": "\\b\\d{4,8}\\b",
    "quota": 1,
    "leaseTtlSec": 900,
    "retentionSec": 604800,
    "maxRenews": 5,
    "enabled": true
  }'

curl http://localhost:8080/api/admin/plans -H "Authorization: Bearer local-dev-admin"   # 列出套餐
```

字段含义：`allowedGroups` 允许使用的账号分组；`targetSenders` 收码发件人（域名/通配）；`codeRegex` 验证码提取正则（可选便利字段）；`quota` 成功收码次数；`leaseTtlSec` 无码超时；`retentionSec` 回看保留期；`maxRenews` 最大重申请次数。`POST` 为 upsert（同前缀覆盖）。

### 3）批量生成唯一码

```bash
curl -X POST http://localhost:8080/api/admin/codes \
  -H "Authorization: Bearer local-dev-admin" \
  -H "Content-Type: application/json" \
  -d '{ "prefix": "gh", "count": 10 }'
# → { "errCode":0, "data": { "count":10, "codes":["gh-3f9a…","gh-7c2b…", …] } }
```

唯一码形如 `gh-<32位hex>`（128bit 随机，不可枚举）。生成的码 `status=unused`、**永久有效**（直到首次成功收码才开始 7 天回看倒计时）。

按状态查询 / 吊销：

```bash
curl "http://localhost:8080/api/admin/codes?status=unused" -H "Authorization: Bearer local-dev-admin"
curl -X POST http://localhost:8080/api/admin/codes/gh-3f9a.../revoke -H "Authorization: Bearer local-dev-admin"
```

### 4）发放与取码

把链接 `http://<host>:8080/<唯一码>`（如 `/gh-3f9a…`）发给用户。用户打开页面 → 点「申请邮箱」→ 倒计时 → SSE 实时回显整封邮件。

### 5）监控

```bash
curl http://localhost:8080/api/admin/stats -H "Authorization: Bearer local-dev-admin"
# → 池水位 free/leased/unhealthy、排队数、SSE 连接数、各状态租约数
```

---

## 五、API 参考

### 公开入口 `/api/public`（无需鉴权）

| 方法 | 路径 | 请求 | 说明 |
|---|---|---|---|
| POST | `/activate` | `{ "code": "gh-…" }` | 申请邮箱：分流 `active`（含 `alias`/`expiresAt`）或 `used` 回看；失效返回错误码 |
| GET | `/leases/:id` | — | 轮询租约状态 |
| GET | `/leases/:id/stream` | — | **SSE** 实时推送：`message`（状态）/ `done`（终态，附整封邮件）；已终态重连返回 `204` |
| POST | `/leases/:id/renew` | — | 超时后重申请（受 `maxRenews` 限制） |
| POST | `/leases/:id/cancel` | — | 提前释放 |
| GET | `/codes/:code/results` | — | 收码结果回看（保留期内的整封历史邮件） |

### 自用 API `/api/v1`（`X-API-Key`）

直接按套餐取码，内部即时签发临时码走同一闭环（复用全部安全护栏）。

```bash
# 申请：返回别名 + 到期时间（可选 callbackUrl 做 webhook 回调）
curl -X POST http://localhost:8080/api/v1/leases \
  -H "X-API-Key: local-dev-apikey" \
  -H "Content-Type: application/json" \
  -d '{ "plan": "gh", "callbackUrl": "https://your.app/hook" }'
# → { "data": { "leaseId":"…", "alias":"xxx@swpu.edu.cn", "expiresAt":169…, "code":"gh-…" } }

# 取码：received 时 data 含整封 mail（from/to/subject/date/text/html）+ 便利 code
curl http://localhost:8080/api/v1/leases/<leaseId> -H "X-API-Key: local-dev-apikey"

# 提前释放
curl -X DELETE http://localhost:8080/api/v1/leases/<leaseId> -H "X-API-Key: local-dev-apikey"
```

### 常见错误码

`CODE_NOT_FOUND`（不存在）· `CODE_EXPIRED`（回看期满，410）· `CODE_EXHAUSTED`（配额耗尽，409）· `CODE_REVOKED`（已吊销）· `PLAN_DISABLED`（套餐停用/不存在）· `POOL_BUSY`（池满排队超时，503）· `LEASE_NOT_FOUND` · `LEASE_NOT_TERMINAL`（非终态不能 renew）· `RENEW_LIMIT`（超重申请上限）。

---

## 六、目录结构

```
src/
├── provider/   EmailProvider 接口 + SWPU 实现（仅登录走浏览器）
├── pool/       账号池（空闲选取 / 健康 / 原子加锁）
├── lease/      租约调度（核心）+ ports（队列/锁内存实现）
├── access/     套餐/前缀/唯一码 校验、配额、唯一码生成
├── receiver/   IMAP 聚合收码（按需连：绑定租约时连、释放时断）→ 路由到活跃租约
├── api/        public / v1 / admin 路由 + SSE + 鉴权 + 统一响应
├── cleaner/    删信 + 7 天 GC 定时任务
├── store/      SQLite 持久化（schema / migrate / repo / 事务）
├── core/       单写串行执行器 + 状态机
└── index.js    装配与启动（恢复状态 / 优雅停机）
web/            React 前端 /{code}
data/           运行态（SQLite + 会话缓存，挂 volume）
```

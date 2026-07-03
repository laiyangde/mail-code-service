# 自用 API 使用文档（`/api/v1`）

在你**自己的其它项目**里，程序化地「取一个一次性邮箱别名 → 用它去目标平台注册 → 收回验证码邮件」。
凭 API Key 直接按**套餐**取码，**流程与网页取码页完全一致**：取别名 →（可能排队）→ 确认「我已发送」→ 收码。

- **Base URL**：`https://19880321.xyz/api/v1`
- **认证**：请求头 `X-API-Key: <API_KEY>`
- **响应**：统一 `{ errCode, errMsg, data }`，成功 `errCode: 0`

---

## 1. 前置条件

| 项 | 说明 |
|---|---|
| `API_KEY` | 服务端 `.env` 已配置。未配置该入口返回 `503 API_DISABLED` |
| 套餐 `plan` | 需先在 Admin 后台创建（前缀 + 目标发件人）。如套餐 `gh`：`targetSenders=["@github.com"]`，取码用前缀 `gh` |
| 账号 | Admin 已添加可用邮箱账号，且分组被套餐允许 |

> 容量 = 账号数（≤3）。自用 API 与网页取码页**共享同一账号池**：账号全忙时**自动排队**（返回 `pending`），不再报错、也不会与取码页互相挤占（FIFO 公平）。

---

## 2. 认证

每个请求都要带头 `X-API-Key: <你的 API_KEY>`。

| 情况 | 返回 |
|---|---|
| 头缺失/不匹配 | `401 UNAUTHORIZED` |
| 服务端未配置 `API_KEY` | `503 API_DISABLED` |

---

## 3. 响应约定

```json
{ "errCode": 0, "errMsg": "ok", "data": { ... } }   // 成功
{ "errCode": "PLAN_DISABLED", "errMsg": "...", "data": null }  // 失败（errCode 为字符串）
```

---

## 4. 端点参考

### 4.1 取号（取一个别名，可自定义、可排队）

```
POST /api/v1/leases
Content-Type: application/json
X-API-Key: <API_KEY>
```

请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `plan` | string | 是 | 套餐前缀（如 `gh`） |
| `alias` | string | 否 | **自定义别名的本地部分**（不含域名，如 `myname`）。不传则系统生成拟真姓名式别名 |
| `callbackUrl` | string | 否 | 收到验证码后回调此地址（Webhook 模式，见 §5.2） |

响应 `data`（两种状态之一）：

**① 有空闲账号 → `active`（别名已设，待确认）**
```json
{
  "leaseId": "b7f3c8a2-...",
  "status": "active",
  "alias": "myname@swpu.edu.cn",     // 拿去目标平台注册
  "expiresAt": 1751520000000,        // 租约到期（ms）
  "receiving": false,                 // 尚未开始收码——需调 /confirm
  "code": "gh-pq02we4ar7dx3s4t"       // 内部码（一般忽略）
}
```

**② 账号全忙 → `pending`（排队中）**
```json
{
  "leaseId": "b7f3c8a2-...",
  "status": "pending",
  "queueAhead": 2,                    // 前面还有几人
  "enqueuedAt": 1751519900000,        // 入队时刻（ms）
  "code": "gh-..."
}
```
排队时**别名尚未确定**（要等轮到你、分到账号才设）。轮询 `GET`（§4.3）直到 `status` 变为 `active`，再 `/confirm`。

> **注意**：自定义 `alias` 若排队后轮到时才发现被占用，租约会转 `rejected`（见 §4.3 状态表）——需换别名重取。

错误：`PLAN_DISABLED`（套餐不存在/停用）、`ALIAS_TAKEN`（指定别名已被占用，409）。

---

### 4.2 确认「我已发送」→ 开始收码

```
POST /api/v1/leases/:leaseId/confirm
X-API-Key: <API_KEY>
```

**必须在 `active` 后调用**，服务端才连 IMAP 开始收码（与网页「我已发送邮件」按钮一致）。幂等：重复调用无副作用。

成功 `data`：`active` 租约视图，`receiving: true`。
若租约仍 `pending`（还没轮到）→ 报错，请先轮询到 `active`。

**推荐时序**：先触发目标平台发码 → 再 `/confirm`（收码窗口从设别名时刻起算，确认前到达的邮件也扫得到；但尽早 confirm 更稳）。

---

### 4.3 查询状态 / 取回邮件（轮询）

```
GET /api/v1/leases/:leaseId
X-API-Key: <API_KEY>
```

响应 `data`：`received` 时含整封 `mail` + 便利 `code`；`pending` 时含 `queueAhead`。

**状态（`status`）**：

| 状态 | 含义 | 下一步 |
|---|---|---|
| `pending` | 排队中，未分到账号 | 继续轮询，等 `active` |
| `active` | 已设别名 | `receiving:false` → 调 `/confirm`；`true` → 等 `received` |
| `received` | 已收到目标邮件 | 读 `mail` / `code`，完成 |
| `expired` | 到期未收到码（默认 15 分钟） | 重新 `POST /leases` |
| `cancelled` | 被主动释放 | 结束 |
| `rejected` | 排队超时 / 自定义别名冲突 | 重新 `POST /leases`（冲突则换 `alias`） |

---

### 4.4 提前释放

```
DELETE /api/v1/leases/:leaseId
X-API-Key: <API_KEY>
```
释放账号、注销 Webhook 登记。成功 `data`：`{ "status": "cancelled" }`。拿到码后调用可更快归还账号。

---

## 5. 两种取码模式

### 5.1 模式 A：轮询

```
POST /leases {plan, alias?}
   → active?  → /confirm → 轮询 GET 到 received
   → pending? → 轮询 GET 到 active → /confirm → 轮询 GET 到 received
DELETE /leases/:id   （可选）
```

### 5.2 模式 B：Webhook 回调

`POST /leases` 带 `callbackUrl`。**仍需走完 active→/confirm**（否则不收码）。收到目标邮件后服务端向 `callbackUrl` POST 一次：

```
POST <callbackUrl>
X-Signature: <HMAC-SHA256(WEBHOOK_SECRET, rawBody) hex>   // 配了 WEBHOOK_SECRET 才有
{ "leaseId": "...", "alias": "...", "mail": {...}, "code": "123456" }
```
用相同 `WEBHOOK_SECRET` 对**原始请求体**验签。失败按指数退避重试（默认 3 次）。

---

## 6. 集成示例（Node.js，含排队 + confirm 完整流程）

```js
// mailcode-client.js —— Node ≥ 18，内置 fetch
const BASE = 'https://19880321.xyz/api/v1';
const API_KEY = process.env.MAILCODE_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'X-API-Key': API_KEY, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (body.errCode !== 0) {
    const e = new Error(body.errMsg || 'request failed');
    e.errCode = body.errCode; e.status = res.status;
    throw e;
  }
  return body.data;
}

/** 取号（可选自定义别名）；返回 {leaseId, status, alias?, ...} */
export const acquire = (plan, alias) =>
  call('/leases', { method: 'POST', body: JSON.stringify({ plan, ...(alias ? { alias } : {}) }) });

const get = (id) => call(`/leases/${encodeURIComponent(id)}`);
export const confirm = (id) => call(`/leases/${encodeURIComponent(id)}/confirm`, { method: 'POST' });
export const release = (id) => call(`/leases/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** 轮询直到租约变为某状态集合之一；超时/终态抛错 */
async function waitUntil(id, targets, { intervalMs = 2500, timeoutMs = 16 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lease = await get(id);
    if (targets.includes(lease.status)) return lease;
    if (['expired', 'cancelled', 'rejected'].includes(lease.status)) {
      throw new Error(`租约已 ${lease.status}`);
    }
    await sleep(intervalMs);
  }
  throw new Error('等待超时');
}

/** 一站式：取号 →（排队则等 active）→ confirm → 等验证码。返回 received 租约（含 mail/code） */
export async function getCode(plan, { alias, onAlias } = {}) {
  let lease = await acquire(plan, alias);
  if (lease.status === 'pending') lease = await waitUntil(lease.leaseId, ['active']);
  onAlias?.(lease.alias);          // 回调：拿到别名，去目标平台触发发码
  await confirm(lease.leaseId);    // 「我已发送」
  return waitUntil(lease.leaseId, ['received']);
}

// ── 用法 ──
// const lease = await getCode('gh', {
//   alias: 'myname',                                  // 可选：自定义别名
//   onAlias: (alias) => registerOnGithub(alias),      // 用别名去注册
// });
// console.log('验证码：', lease.code, lease.mail.text);
// await release(lease.leaseId);
```

### Python（要点相同）

```python
import os, time, requests
BASE, H = "https://19880321.xyz/api/v1", {"X-API-Key": os.environ["MAILCODE_API_KEY"]}

def _d(r):
    b = r.json()
    if b.get("errCode") != 0: raise RuntimeError(f'{b.get("errCode")}: {b.get("errMsg")}')
    return b["data"]

def acquire(plan, alias=None):
    body = {"plan": plan} | ({"alias": alias} if alias else {})
    return _d(requests.post(f"{BASE}/leases", json=body, headers=H, timeout=15))

def wait_until(id, targets, interval=2.5, timeout=960):
    end = time.time() + timeout
    while time.time() < end:
        lease = _d(requests.get(f"{BASE}/leases/{id}", headers=H, timeout=15))
        if lease["status"] in targets: return lease
        if lease["status"] in ("expired","cancelled","rejected"): raise RuntimeError(lease["status"])
        time.sleep(interval)
    raise TimeoutError

def get_code(plan, alias=None, on_alias=None):
    lease = acquire(plan, alias)
    if lease["status"] == "pending": lease = wait_until(lease["leaseId"], ["active"])
    if on_alias: on_alias(lease["alias"])
    requests.post(f'{BASE}/leases/{lease["leaseId"]}/confirm', headers=H, timeout=15)
    return wait_until(lease["leaseId"], ["received"])
```

### curl

```bash
API_KEY=你的key; BASE=https://19880321.xyz/api/v1
curl -s -X POST $BASE/leases -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d '{"plan":"gh","alias":"myname"}'
curl -s -X POST $BASE/leases/<leaseId>/confirm -H "X-API-Key: $API_KEY"   # 我已发送
curl -s $BASE/leases/<leaseId> -H "X-API-Key: $API_KEY"                   # 轮询取码
```

---

## 7. 错误码

| errCode | HTTP | 含义 | 处理 |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | API Key 无效/缺失 | 检查 `X-API-Key` |
| `API_DISABLED` | 503 | 未配置 `API_KEY` | 服务端配置 |
| `PLAN_DISABLED` | 409 | 套餐不存在/停用 | 检查 `plan` |
| `ALIAS_TAKEN` | 409 | 自定义别名已被占用 | 换一个 `alias` |
| `POOL_BUSY` | 503 | 排队超时无空闲账号 | 稍后重试 |
| `RECEIVER_UNAVAILABLE` | 503 | 收码通道暂不可用 | 稍后重试 / 重新 confirm |
| `LEASE_NOT_FOUND` | 404 | 租约不存在 | 检查 `leaseId` |
| `LEASE_NOT_TERMINAL` | 409 | 租约未结束 | — |

---

## 8. 注意事项

- **必须 `/confirm`**：取号后不自动收码，务必在 `active` 后调 `/confirm`，否则永远收不到（与网页「我已发送」一致）。
- **排队**：账号忙时返回 `pending`，轮询到 `active` 再 confirm；不会与网页取码互相冲突。
- **自定义别名**：传本地部分（不含域名）；已被占用 → `ALIAS_TAKEN`（立即取号时）或 `rejected`（排队后轮到时）。不传则系统生成。
- **别名一次性**：用完随租约释放，不可复用。
- **收码窗口**：默认 15 分钟（`expiresAt`），超时 `expired`，需重取。
- **目标发件人**：仅匹配套餐 `targetSenders`、发往该别名、时间在别名生效后的邮件才交付（防串号核心）。
- **及时释放**：拿到码后 `DELETE`，更快归还账号。
- **HTTPS + 保密**：生产走 `https://`；`API_KEY` 勿泄漏、勿写入前端。

---

## 附：三类入口

| 入口 | 前缀 | 认证 | 适用 |
|---|---|---|---|
| 公开取码 | `/api/public` | 无（凭唯一码） | 面向终端用户的网页取码 |
| **自用 API** | `/api/v1` | `X-API-Key` | **你的其它项目程序化取码（本文档）** |
| 管理后台 | `/api/admin` | `Bearer <ADMIN_TOKEN>` | 账号/套餐/唯一码管理 |

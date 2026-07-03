/**
 * 自用 API 路由（M6 / 需求 §9，FR-7）：内部脚本凭 `X-API-Key` 直接按套餐取码，
 * 无需走预发放的唯一码。注册为 fastify 插件（prefix `/api/v1`）。
 *
 * 流程与取码页**完全一致**：取别名（可自定义 `alias`、池满则排队 `pending`）→ 确认「我已发送」
 * (`/confirm`) → 才连 IMAP 收码。自用「按套餐取码」= 内部即时签发一个临时唯一码再走 `createLease`，
 * 完全复用公开入口闭环与 FR-0 全护栏，不新增旁路（保「杜绝一码多码」不变量）。
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} opts
 * @param {import('../services.js').Services} opts.services
 * @param {import('./webhook.js').WebhookDispatcher} opts.webhook
 */
import { ok, fail, sendError } from './response.js';
import { leaseView } from './views.js';
import { ApiError, ErrorCode } from '../errors.js';
import { generateCode } from '../access/code-gen.js';
import { apiKeyHook } from './auth.js';

/**
 * 租约视图；`pending` 时附排队位次 queueAhead（与取码页一致，供调用方显示/判断）。
 * @param {import('../lease/lease-manager.js').LeaseManager} manager
 * @param {object} lease
 */
function viewOf(manager, lease) {
  const extra = {};
  if (lease.status === 'pending') extra.queueAhead = manager.queuePosition(lease.id);
  return leaseView(lease, extra);
}

export default async function v1Routes(app, opts) {
  const { services, webhook } = opts;
  const { manager, store } = services;

  app.addHook('preHandler', apiKeyHook); // 本组全部路由需 X-API-Key

  // 取号：按套餐取一个别名。可传 alias 自定义（本地部分）；池满则返回 pending 排队（与取码页一致）。
  // **不自动收码**——需再调 POST /leases/:id/confirm 表示「我已发送」后才连 IMAP。
  app.post('/leases', async (req, reply) => {
    const planPrefix = req.body?.plan;
    const callbackUrl = req.body?.callbackUrl;
    const rawAlias = req.body?.alias;
    if (typeof planPrefix !== 'string' || !planPrefix) {
      return sendError(reply, 400, 'BAD_REQUEST', '缺少 plan');
    }
    if (rawAlias != null && (typeof rawAlias !== 'string' || !rawAlias.trim())) {
      return sendError(reply, 400, 'BAD_REQUEST', 'alias 需为非空字符串（本地部分，不含域名）');
    }
    const plan = store.plan.getByPrefix(planPrefix);
    if (!plan || !plan.enabled) {
      return fail(reply, new ApiError(ErrorCode.PLAN_DISABLED, '套餐不存在或已停用'));
    }

    // 即时签发内部码（走正常唯一码生命周期，取码后自然 used）
    const code = generateCode(plan.prefix);
    store.accessCode.insert({
      code,
      prefix: plan.prefix,
      status: 'unused',
      quotaLeft: plan.quota,
      issuedAt: Date.now(),
    });

    try {
      const result = await manager.createLease(code, { alias: rawAlias?.trim() });
      // active（已设别名待确认）或 pending（排队中）均为正常返回；used 不应出现（新码）
      if (result.status !== 'active' && result.status !== 'pending') {
        store.accessCode.updateStatus(code, 'revoked');
        return fail(reply, new ApiError(ErrorCode.CODE_EXHAUSTED, '套餐配额异常'));
      }
      if (callbackUrl) webhook.register(result.lease.id, callbackUrl); // 收码后回调（pending 也先登记）
      return ok(reply, { ...viewOf(manager, result.lease), code });
    } catch (err) {
      // 取号失败（含别名冲突 ALIAS_TAKEN）：置 revoked，避免遗留永久保留的 unused 孤儿码
      store.accessCode.updateStatus(code, 'revoked');
      return fail(reply, err);
    }
  });

  // 确认「我已发送」→ 开始连 IMAP 收码（与取码页 /confirm 一致；pending 未轮到时报错，需先等 active）
  app.post('/leases/:id/confirm', async (req, reply) => {
    try {
      const result = await manager.confirmReceiving(req.params.id);
      return ok(reply, viewOf(manager, result.lease));
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 取码：状态 + 整封邮件（received 时含 mail/code；pending 时含 queueAhead）。自用方自行解析验证码。
  app.get('/leases/:id', async (req, reply) => {
    const lease = manager.getLease(req.params.id);
    if (!lease) return fail(reply, new ApiError(ErrorCode.LEASE_NOT_FOUND, '租约不存在'));
    return ok(reply, viewOf(manager, lease));
  });

  // 提前释放
  app.delete('/leases/:id', async (req, reply) => {
    try {
      const result = await manager.cancel(req.params.id);
      webhook.unregister(req.params.id);
      return ok(reply, { status: result.status });
    } catch (err) {
      return fail(reply, err);
    }
  });
}

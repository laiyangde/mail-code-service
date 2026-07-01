/**
 * 自用 API 路由（M6 / 需求 §9，FR-7）：内部脚本凭 `X-API-Key` 直接按套餐取码，
 * 无需走预发放的唯一码。注册为 fastify 插件（prefix `/api/v1`）。
 *
 * 关键：自用「按套餐取码」= **内部即时签发一个临时唯一码**再走 `createLease`，
 * 完全复用公开入口闭环与 FR-0 全护栏，不新增旁路（保「杜绝一码多码」不变量）。
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} opts
 * @param {import('../services.js').Services} opts.services
 * @param {import('./webhook.js').WebhookDispatcher} opts.webhook
 */
import { ok, fail, sendError } from './response.js';
import { leaseView, secToMs } from './views.js';
import { ApiError, ErrorCode } from '../errors.js';
import { generateCode } from '../access/code-gen.js';
import { apiKeyHook } from './auth.js';

export default async function v1Routes(app, opts) {
  const { services, webhook } = opts;
  const { manager, store } = services;

  app.addHook('preHandler', apiKeyHook); // 本组全部路由需 X-API-Key

  // 按套餐取码：内部签发临时码 → createLease → 返回别名
  app.post('/leases', async (req, reply) => {
    const planPrefix = req.body?.plan;
    const callbackUrl = req.body?.callbackUrl;
    if (typeof planPrefix !== 'string' || !planPrefix) {
      return sendError(reply, 400, 'BAD_REQUEST', '缺少 plan');
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
      const result = await manager.createLease(code);
      if (result.status !== 'active') {
        // 新签发码不应命中 used 分支；防御性返回
        return fail(reply, new ApiError(ErrorCode.CODE_EXHAUSTED, '套餐配额异常'));
      }
      // 自用 API 无「我已发送邮件」交互，拿到别名即开始收码（立即连 IMAP）
      await manager.confirmReceiving(result.lease.id);
      if (callbackUrl) webhook.register(result.lease.id, callbackUrl);
      return ok(reply, {
        leaseId: result.lease.id,
        alias: result.lease.alias,
        expiresAt: secToMs(result.lease.expiresAt),
        code,
      });
    } catch (err) {
      // 取号失败：置 revoked，避免遗留「永久保留」的 unused 孤儿码（此时码仍 unused，转移合法）
      store.accessCode.updateStatus(code, 'revoked');
      return fail(reply, err);
    }
  });

  // 取码：状态 + 整封邮件（自用方自行解析验证码）
  app.get('/leases/:id', async (req, reply) => {
    const lease = manager.getLease(req.params.id);
    if (!lease) return fail(reply, new ApiError(ErrorCode.LEASE_NOT_FOUND, '租约不存在'));
    return ok(reply, leaseView(lease)); // received 时含 mail/code
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

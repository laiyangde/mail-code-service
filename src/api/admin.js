/**
 * 管理后台路由（M6 / 需求 §9，FR-8）：账号池 / 套餐 / 唯一码 / 监控。
 * 独立鉴权（`Authorization: Bearer <ADMIN_TOKEN>`），与公开 / 自用入口隔离。
 * 注册为 fastify 插件（prefix `/api/admin`）。
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} opts
 * @param {import('../services.js').Services} opts.services
 * @param {import('./sse-hub.js').SseHub} opts.sseHub
 */
import { ok, fail, sendError } from './response.js';
import { ApiError, ErrorCode } from '../errors.js';
import { batchGenerate } from '../access/code-gen.js';
import { registerAccount } from '../services.js';
import { adminHook } from './auth.js';

/**
 * 账号视图（脱敏：不含 creds_ref；附 IMAP 健康度）。
 * @param {object} acc
 * @param {import('../pool/account-pool.js').AccountPool} pool
 */
function accountView(acc, pool) {
  return {
    id: acc.id,
    university: acc.university,
    domain: acc.domain,
    group: acc.groupName,
    status: acc.status,
    currentAlias: acc.currentAlias,
    lastError: acc.lastError,
    disabled: acc.disabled,
    healthy: pool.healthy.get(acc.id) !== false,
  };
}

export default async function adminRoutes(app, opts) {
  const { services, sseHub } = opts;
  const { store, pool, manager, queue } = services;

  app.addHook('preHandler', adminHook); // 本组全部路由需 Admin Token

  // ── 账号（FR-8.1）──
  app.get('/accounts', async (_req, reply) => {
    return ok(
      reply,
      store.account.list().map((a) => accountView(a, pool)),
    );
  });

  // 新增账号：入库 + 动态注册 provider + 起 IMAP（免重启，凭据须先配在 .env）
  app.post('/accounts', async (req, reply) => {
    const { id, university, domain, group, credsRef } = req.body ?? {};
    if (!id || !university || !domain || !group || !credsRef) {
      return sendError(
        reply,
        400,
        'BAD_REQUEST',
        '缺少账号字段（id/university/domain/group/credsRef）',
      );
    }
    try {
      store.account.insert({
        id,
        university,
        domain,
        groupName: group,
        credsRef,
        updatedAt: Date.now(),
      });
    } catch (err) {
      return sendError(reply, 409, 'ACCOUNT_EXISTS', `账号已存在或入库失败：${err.message}`);
    }
    const account = store.account.getById(id);
    const provider = registerAccount(services, account);
    try {
      await provider.startReceiver?.();
      pool.setHealthy(id);
    } catch (err) {
      pool.setUnhealthy(id);
      req.log.warn({ id, err: err.message }, 'admin 新增账号：IMAP 启动失败，置 unhealthy');
    }
    return ok(reply, accountView(store.account.getById(id), pool));
  });

  // 启用 / 禁用（FR-8.1）
  app.post('/accounts/:id/disable', async (req, reply) =>
    setAccountDisabled(req, reply, store, pool, true),
  );
  app.post('/accounts/:id/enable', async (req, reply) =>
    setAccountDisabled(req, reply, store, pool, false),
  );

  // 强制重登（FR-8.1）
  app.post('/accounts/:id/relogin', async (req, reply) => {
    const provider = pool.getProvider(req.params.id);
    if (!provider) return sendError(reply, 404, 'ACCOUNT_NOT_FOUND', '账号不存在或未注册 provider');
    try {
      await provider.login();
      return ok(reply, { id: req.params.id, relogin: true });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── 套餐（FR-8.2）──
  app.get('/plans', async (_req, reply) => ok(reply, store.plan.list()));

  app.post('/plans', async (req, reply) => {
    const p = req.body ?? {};
    if (!p.prefix || !p.name) {
      return sendError(reply, 400, 'BAD_REQUEST', '缺少 prefix/name');
    }
    store.plan.upsert(p);
    return ok(reply, store.plan.getByPrefix(p.prefix));
  });

  // ── 唯一码（FR-8.3）──
  // 批量生成
  app.post('/codes', async (req, reply) => {
    const { prefix, count } = req.body ?? {};
    if (!prefix || !count) {
      return sendError(reply, 400, 'BAD_REQUEST', '缺少 prefix/count');
    }
    if (!store.plan.getByPrefix(prefix)) {
      return fail(reply, new ApiError(ErrorCode.PLAN_DISABLED, '套餐前缀不存在'));
    }
    const codes = batchGenerate(store, prefix, Number(count));
    return ok(reply, { count: codes.length, codes });
  });

  // 按状态查询（status 缺省 unused）
  app.get('/codes', async (req, reply) => {
    const status = req.query?.status ?? 'unused';
    return ok(reply, store.accessCode.listByStatus(status));
  });

  // 吊销：先关联取消活跃租约（释放账号），再置 revoked
  app.post('/codes/:code/revoke', async (req, reply) => {
    const code = store.accessCode.getByCode(req.params.code);
    if (!code) return fail(reply, new ApiError(ErrorCode.CODE_NOT_FOUND, '唯一码不存在'));
    if (code.boundLeaseId) {
      try {
        await manager.cancel(code.boundLeaseId);
      } catch (err) {
        req.log.warn({ code: req.params.code, err: err.message }, 'revoke：取消关联租约失败');
      }
    }
    store.accessCode.updateStatus(req.params.code, 'revoked');
    return ok(reply, { code: req.params.code, status: 'revoked' });
  });

  // ── 监控（FR-8.4）──
  app.get('/stats', async (_req, reply) => {
    return ok(reply, {
      pool: pool.stats(),
      queue: queue.size,
      sse: sseHub?.size ?? 0,
      leases: {
        active: store.lease.listByStatus('active').length,
        received: store.lease.listByStatus('received').length,
        expired: store.lease.listByStatus('expired').length,
      },
    });
  });
}

/**
 * 启用 / 禁用账号的公共处理。
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 * @param {object} store
 * @param {import('../pool/account-pool.js').AccountPool} pool
 * @param {boolean} disabled
 */
function setAccountDisabled(req, reply, store, pool, disabled) {
  const acc = store.account.getById(req.params.id);
  if (!acc) return sendError(reply, 404, 'ACCOUNT_NOT_FOUND', '账号不存在');
  store.account.setDisabled(req.params.id, disabled, Date.now());
  return ok(reply, accountView(store.account.getById(req.params.id), pool));
}

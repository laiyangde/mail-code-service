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
import { immediateTx } from '../store/tx.js';

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

  // 新增账号：入库 + 动态注册 provider（按需连：IMAP 留待首次取码时建连，凭据须先配在 .env）
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
    // 按需连模式：仅注册 provider 入池，IMAP 留待首次取码时按需建连（不在此常驻）
    registerAccount(services, account);
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

  // 删除账号（FR-8.1）：先释放活跃租约 → 删其租约与幂等记录（外键）→ 从池移除 provider → 删账号行
  app.delete('/accounts/:id', async (req, reply) => {
    const id = req.params.id;
    if (!store.account.getById(id)) {
      return sendError(reply, 404, 'ACCOUNT_NOT_FOUND', '账号不存在');
    }
    const active = store.lease.getActiveByAccount(id);
    if (active) {
      try {
        await manager.cancel(active.id);
      } catch (err) {
        req.log.warn({ id, err: err.message }, '删账号：取消活跃租约失败');
      }
    }
    await services.exec.submit(() =>
      immediateTx(store.db, () => {
        store.processedMail.deleteByAccount(id);
        store.lease.deleteByAccount(id);
        store.account.delete(id);
      })(),
    );
    pool.removeProvider(id);
    return ok(reply, { id, deleted: true });
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

  // 删除套餐（FR-8.2）：级联清除该套餐的全部唯一码（含租约/幂等记录），再删套餐本身
  app.delete('/plans/:prefix', async (req, reply) => {
    const prefix = req.params.prefix;
    if (!store.plan.getByPrefix(prefix)) {
      return fail(reply, new ApiError(ErrorCode.PLAN_DISABLED, '套餐不存在'));
    }
    const codes = store.accessCode.listByPrefix(prefix);
    for (const c of codes) await purgeCode(services, c.code);
    store.plan.delete(prefix);
    return ok(reply, { prefix, deletedCodes: codes.length });
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

  // 查询唯一码：按状态 / 套餐前缀组合筛选（均可选，缺省返回全部）
  app.get('/codes', async (req, reply) => {
    const status = req.query?.status || '';
    const prefix = req.query?.prefix || '';
    let list = prefix ? store.accessCode.listByPrefix(prefix) : store.accessCode.listAll();
    if (status) list = list.filter((c) => c.status === status);
    return ok(reply, list);
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

  // 批量删除唯一码（FR-8.3）：物理清除（含租约/幂等记录），先释放活跃租约
  app.delete('/codes', async (req, reply) => {
    const codes = req.body?.codes;
    if (!Array.isArray(codes) || codes.length === 0) {
      return sendError(reply, 400, 'BAD_REQUEST', '缺少 codes 数组');
    }
    let deleted = 0;
    for (const code of codes) {
      if (!store.accessCode.getByCode(code)) continue;
      await purgeCode(services, code);
      deleted++;
    }
    return ok(reply, { deleted });
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

/**
 * 物理清除一个唯一码：先释放其活跃/排队租约（cancel 释放账号、可能推进排队者），
 * 再经串行执行器在单事务内删 processed_mail / lease / access_code（与收码/GC 串行，无竞态）。
 * @param {import('../services.js').Services} services
 * @param {string} code
 */
async function purgeCode(services, code) {
  const { store, manager, exec } = services;
  for (const l of store.lease.listByCode(code)) {
    if (l.status === 'active' || l.status === 'pending') {
      try {
        await manager.cancel(l.id);
      } catch {
        /* 已终态 / 并发释放，忽略 */
      }
    }
  }
  await exec.submit(() =>
    immediateTx(store.db, () => {
      for (const l of store.lease.listByCode(code)) store.processedMail.deleteByLease(l.id);
      store.lease.deleteByCode(code);
      store.accessCode.delete(code);
    })(),
  );
}

/**
 * 公开入口路由（M6 / 需求 §9，FR-6）：付费用户凭唯一码取码。无需 API Key。
 *
 * 注册为 fastify 插件（prefix `/api/public`）。依赖经 opts 注入：
 * @param {import('fastify').FastifyInstance} app
 * @param {object} opts
 * @param {import('../services.js').Services} opts.services
 * @param {import('./sse-hub.js').SseHub} opts.sseHub
 */
import { ok, fail, sendError } from './response.js';
import { leaseView } from './views.js';
import { ApiError, ErrorCode } from '../errors.js';
import { isLeaseTerminal } from '../core/state-machine.js';
import { verifyCodeShape } from '../access/code-gen.js';
import { config } from '../config.js';

/** 终态事件（generator 收到即收尾）。rejected=排队兜底超时失败 */
const TERMINAL_EVENTS = new Set(['received', 'expired', 'cancelled', 'rejected']);

/**
 * 构造租约视图；`pending` 时从队列算出 queueAhead 一并附上（前端显示「前面还有几人」）。
 * 并按套餐前缀查出展示名 planName（前端展示套餐名而非前缀）。
 * @param {import('../lease/lease-manager.js').LeaseManager} manager
 * @param {object} lease
 */
function viewOf(manager, lease) {
  const planName = manager.store.plan.getByPrefix(lease.plan)?.name;
  const extra = { planName };
  if (lease.status === 'pending') extra.queueAhead = manager.queuePosition(lease.id);
  return leaseView(lease, extra);
}

/** SSE 事件构造：状态更新（pending 进度亦经此推送最新 queueAhead） */
const sseMessage = (manager, lease) => ({
  event: 'message',
  data: JSON.stringify(viewOf(manager, lease)),
});
/** SSE 事件构造：终态收尾（附最终状态 + 整封邮件） */
const sseDone = (manager, lease) => ({
  event: 'done',
  data: JSON.stringify(viewOf(manager, lease)),
});

/**
 * 租约事件流（SSE 数据源，async generator）。**先订阅再查库**：订阅早于读取，
 * 期间到达的事件必进队列，杜绝「订阅前已收码 → 漏推」（§3.6）。排队进度（queueAhead
 * 变化）经 message 持续推送，pending→active→received 同一条流不收尾直至终态。
 * @param {import('./sse-hub.js').SseHub} sseHub
 * @param {import('../lease/lease-manager.js').LeaseManager} manager
 * @param {string} leaseId
 * @param {string|null} accessCode
 */
async function* leaseEventStream(sseHub, manager, leaseId, accessCode) {
  const sub = sseHub.subscribe(leaseId, accessCode);
  try {
    const snap = manager.getLease(leaseId);
    if (!snap) return;
    yield sseMessage(manager, snap); // 先回显当前快照（前端立即同步）
    if (isLeaseTerminal(snap.status)) {
      yield sseDone(manager, snap);
      return;
    }
    for await (const ev of sub) {
      const cur = manager.getLease(leaseId) ?? snap;
      if (TERMINAL_EVENTS.has(ev.type) || isLeaseTerminal(cur.status)) {
        yield sseDone(manager, cur);
        return;
      }
      yield sseMessage(manager, cur);
    }
  } finally {
    sseHub.unsubscribe(sub); // 覆盖终态结束与客户端断开两种路径
  }
}

/**
 * 把 createLease/renew 结果（active/pending 或 used 回看）转为统一响应。
 * @param {import('fastify').FastifyReply} reply
 * @param {import('../lease/lease-manager.js').LeaseManager} manager
 * @param {object} result
 */
function sendLeaseResult(reply, manager, result) {
  if (result.status === 'used') {
    return ok(reply, { status: 'used', results: result.results, retainUntil: result.retainUntil });
  }
  return ok(reply, viewOf(manager, result.lease)); // 含 status:'active' 或 'pending'
}

export default async function publicRoutes(app, opts) {
  const { services, sseHub } = opts;
  const { manager, accessService } = services;

  // activate 限流：按 IP+code（keyGenerator 依赖 body，故全局 rate-limit 用 preHandler hook）
  const activateRateLimit = {
    max: config.rateLimit.activateMax,
    timeWindow: config.rateLimit.windowSec * 1000,
    keyGenerator: (req) => req.ip, // 按真实客户端 IP（依赖 trustProxy）；不含 code，杜绝"换 code 绕过 IP 限流"
  };

  // 申请邮箱（FR-6.1：用户点「申请邮箱」才调用）。分流 active / pending 排队 / used 回看；错误 → 错误码
  app.post('/activate', { config: { rateLimit: activateRateLimit } }, async (req, reply) => {
    const code = req.body?.code;
    if (typeof code !== 'string' || !code) {
      return sendError(reply, 400, 'BAD_REQUEST', '缺少 code');
    }
    // 自验证前置：伪造/枚举码在进单飞锁与串行执行器、查库之前直接拒（防 DoS 放大）
    if (!verifyCodeShape(code)) {
      return sendError(reply, 404, ErrorCode.CODE_NOT_FOUND, '唯一码不存在');
    }
    try {
      const result = await manager.createLease(code);
      return sendLeaseResult(reply, manager, result);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 用户确认「我已发送邮件」→ 开始连 IMAP 收码（延后连接，FR-6）
  app.post('/leases/:id/confirm', async (req, reply) => {
    try {
      const result = await manager.confirmReceiving(req.params.id);
      return ok(reply, viewOf(manager, result.lease));
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 查询租约状态（轮询）。pending 含 queueAhead/enqueuedAt
  app.get('/leases/:id', async (req, reply) => {
    const lease = manager.getLease(req.params.id);
    if (!lease) return fail(reply, new ApiError(ErrorCode.LEASE_NOT_FOUND, '租约不存在'));
    return ok(reply, viewOf(manager, lease));
  });

  // SSE 实时回显（FR-6.3/6.7）。已终态租约的重连 → 204，使前端彻底停止
  app.get('/leases/:id/stream', (req, reply) => {
    const lease = manager.getLease(req.params.id);
    if (!lease) return sendError(reply, 404, ErrorCode.LEASE_NOT_FOUND, '租约不存在');
    if (isLeaseTerminal(lease.status)) return reply.code(204).send();
    reply.sse(leaseEventStream(sseHub, manager, lease.id, lease.accessCode));
  });

  // 超时后重申请（FR-3.5/6.5）
  app.post('/leases/:id/renew', async (req, reply) => {
    try {
      const result = await manager.renew(req.params.id);
      return sendLeaseResult(reply, manager, result);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 提前释放（FR-3.6）
  app.post('/leases/:id/cancel', async (req, reply) => {
    try {
      const result = await manager.cancel(req.params.id);
      return ok(reply, { status: result.status });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 收码结果回看（FR-2.7/6.9）：保留期内返回历史整封邮件
  app.get('/codes/:code/results', async (req, reply) => {
    const code = req.params.code;
    // 自验证前置：伪造/枚举码直接拒，不进查库路径
    if (!verifyCodeShape(code)) {
      return sendError(reply, 404, ErrorCode.CODE_NOT_FOUND, '唯一码不存在');
    }
    try {
      const verdict = accessService.classify(code); // used→results；error→抛对应码
      if (verdict.kind === 'used') {
        return ok(reply, { results: verdict.results, retainUntil: verdict.retainUntil });
      }
      // unused / active：尚无成功收码，返回空列表
      return ok(reply, { results: accessService.getResults(code), retainUntil: null });
    } catch (err) {
      return fail(reply, err);
    }
  });
}

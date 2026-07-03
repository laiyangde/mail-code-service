import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApiHarness } from '../helpers/api-harness.js';

/** 自用 API：X-API-Key 鉴权 + 按套餐取码（内部签发临时码复用闭环）。流程与取码页一致：取→confirm→收 */
describe('v1 自用 API', () => {
  let h;
  beforeEach(async () => {
    vi.stubEnv('API_KEY', 'k1');
    h = await createApiHarness({ accounts: 1 });
  });
  afterEach(async () => {
    await h.app.close();
    vi.unstubAllEnvs();
  });

  const KEY = { 'x-api-key': 'k1' };
  const acquire = (payload) =>
    h.app.inject({ method: 'POST', url: '/api/v1/leases', headers: KEY, payload });
  const confirm = (id) =>
    h.app.inject({ method: 'POST', url: `/api/v1/leases/${id}/confirm`, headers: KEY });

  it('缺 API Key → 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/leases',
      payload: { plan: 'gh' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('服务端未配置 API_KEY → 503', async () => {
    vi.stubEnv('API_KEY', '');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/leases',
      headers: { 'x-api-key': 'whatever' },
      payload: { plan: 'gh' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('缺 plan → 400', async () => {
    const res = await acquire({});
    expect(res.statusCode).toBe(400);
  });

  it('不存在的 plan → 409 PLAN_DISABLED', async () => {
    const res = await acquire({ plan: 'nope' });
    expect(res.statusCode).toBe(409);
    expect(res.json().errCode).toBe('PLAN_DISABLED');
  });

  it('按 plan 取码 → 别名 + leaseId（active 待确认，receiving=false）', async () => {
    const res = await acquire({ plan: 'gh' });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.status).toBe('active');
    expect(d.alias).toMatch(/@swpu\.edu\.cn$/);
    expect(d.leaseId).toBeTruthy();
    expect(d.code).toMatch(/^gh-/);
    expect(d.receiving).toBe(false); // 未 confirm 前不收码
  });

  it('自定义别名 → 精确生效', async () => {
    const res = await acquire({ plan: 'gh', alias: 'myname' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.alias).toBe('myname@swpu.edu.cn');
  });

  it('自定义别名已被占用 → 409 ALIAS_TAKEN', async () => {
    // 模拟 provider 在 exact 模式返回冲突
    h.providers.acc1.setAlias = async (alias, opts) =>
      opts?.exact
        ? { ok: false, conflict: true, finalAlias: alias }
        : { ok: true, finalAlias: alias };
    const res = await acquire({ plan: 'gh', alias: 'taken' });
    expect(res.statusCode).toBe(409);
    expect(res.json().errCode).toBe('ALIAS_TAKEN');
  });

  it('池满 → pending 排队 + queueAhead（与取码页一致，不再报错）', async () => {
    await acquire({ plan: 'gh' }); // 占满唯一账号
    const res = await acquire({ plan: 'gh' });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.status).toBe('pending');
    expect(d.queueAhead).toBe(1);
    expect(d.leaseId).toBeTruthy();
  });

  it('取号 → confirm → 收码 → GET 拿到整封邮件', async () => {
    const r = await acquire({ plan: 'gh' });
    const { leaseId } = r.json().data;
    await confirm(leaseId); // 必须先「我已发送」才连 IMAP 收码
    const lease = h.manager.getLease(leaseId);
    h.providers.acc1.emit(h.mailFor(201, lease));
    await h.flush();
    const got = await h.app.inject({
      method: 'GET',
      url: `/api/v1/leases/${leaseId}`,
      headers: KEY,
    });
    expect(got.json().data.status).toBe('received');
    expect(got.json().data.mail.subject).toBe('code');
  });

  it('未 confirm 时不收码（GET 仍 active）', async () => {
    const r = await acquire({ plan: 'gh' });
    const { leaseId } = r.json().data;
    const lease = h.manager.getLease(leaseId);
    h.providers.acc1.emit(h.mailFor(205, lease)); // 未 confirm，不应交付
    await h.flush();
    const got = await h.app.inject({
      method: 'GET',
      url: `/api/v1/leases/${leaseId}`,
      headers: KEY,
    });
    expect(got.json().data.status).toBe('active');
  });

  it('webhook：confirm 后收码回调 callbackUrl（带整封邮件）', async () => {
    const calls = [];
    h.webhook._dispatch = async (leaseId, url, payload) => {
      calls.push({ leaseId, url, payload });
    };
    const r = await acquire({ plan: 'gh', callbackUrl: 'https://example.com/cb' });
    const { leaseId } = r.json().data;
    await confirm(leaseId);
    const lease = h.manager.getLease(leaseId);
    h.providers.acc1.emit(h.mailFor(202, lease));
    await h.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/cb');
    expect(calls[0].payload.mail.uid).toBe(202);
  });

  it('DELETE 提前释放', async () => {
    const r = await acquire({ plan: 'gh' });
    const { leaseId } = r.json().data;
    const d = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/leases/${leaseId}`,
      headers: KEY,
    });
    expect(d.statusCode).toBe(200);
    expect(d.json().data.status).toBe('cancelled');
  });
});

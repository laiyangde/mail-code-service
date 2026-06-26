import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApiHarness } from '../helpers/api-harness.js';

/** 公开入口：activate / 轮询 / SSE / renew / cancel / results 回看 */
describe('public 路由', () => {
  let h;
  beforeEach(async () => {
    h = await createApiHarness({ accounts: 1 });
  });
  afterEach(async () => {
    await h.app.close();
  });

  const activate = (code) =>
    h.app.inject({ method: 'POST', url: '/api/public/activate', payload: { code } });

  it('缺 code → 400', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/public/activate', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('不存在的 code → 404 CODE_NOT_FOUND', async () => {
    const res = await activate('gh-nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().errCode).toBe('CODE_NOT_FOUND');
  });

  it('有效 code → active + 别名', async () => {
    const code = h.issueCode('gh-1');
    const res = await activate(code);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.status).toBe('active');
    expect(d.alias).toMatch(/@swpu\.edu\.cn$/);
    expect(d.leaseId).toBeTruthy();
    expect(d.expiresAt).toBeGreaterThan(0);
  });

  it('同 code 并发/重复 activate → 复用同一活跃租约（单飞，INV-1）', async () => {
    const code = h.issueCode('gh-dup');
    const [a, b] = await Promise.all([activate(code), activate(code)]);
    expect(a.json().data.leaseId).toBe(b.json().data.leaseId);
  });

  it('收码后租约 received，含整封邮件与便利码', async () => {
    const code = h.issueCode('gh-2');
    const r = await activate(code);
    const lease = h.manager.getLease(r.json().data.leaseId);
    h.providers.acc1.emit(h.mailFor(101, lease));
    await h.flush();
    const got = await h.app.inject({ method: 'GET', url: `/api/public/leases/${lease.id}` });
    const d = got.json().data;
    expect(d.status).toBe('received');
    expect(d.mail.from).toContain('github.com');
    expect(d.code).toBe('123456');
  });

  it('配额耗尽后再 activate → used 回看（不新建租约）', async () => {
    const code = h.issueCode('gh-3');
    const r1 = await activate(code);
    const lease = h.manager.getLease(r1.json().data.leaseId);
    h.providers.acc1.emit(h.mailFor(102, lease));
    await h.flush();
    const r2 = await activate(code);
    expect(r2.statusCode).toBe(200);
    const d = r2.json().data;
    expect(d.status).toBe('used');
    expect(d.results).toHaveLength(1);
    expect(d.retainUntil).toBeGreaterThan(Date.now());
  });

  it('leases/:id 不存在 → 404', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/public/leases/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('cancel 释放租约', async () => {
    const code = h.issueCode('gh-4');
    const r = await activate(code);
    const { leaseId } = r.json().data;
    const c = await h.app.inject({ method: 'POST', url: `/api/public/leases/${leaseId}/cancel` });
    expect(c.statusCode).toBe(200);
    expect(c.json().data.status).toBe('cancelled');
  });

  it('终态后 renew 重新取号', async () => {
    const code = h.issueCode('gh-5');
    const r = await activate(code);
    const { leaseId } = r.json().data;
    await h.app.inject({ method: 'POST', url: `/api/public/leases/${leaseId}/cancel` });
    const rn = await h.app.inject({ method: 'POST', url: `/api/public/leases/${leaseId}/renew` });
    expect(rn.statusCode).toBe(200);
    expect(rn.json().data.status).toBe('active');
  });

  it('results 回看（保留期内）', async () => {
    const code = h.issueCode('gh-6');
    const r = await activate(code);
    const lease = h.manager.getLease(r.json().data.leaseId);
    h.providers.acc1.emit(h.mailFor(103, lease));
    await h.flush();
    const res = await h.app.inject({ method: 'GET', url: `/api/public/codes/${code}/results` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.results).toHaveLength(1);
  });

  it('已终态租约 stream → 204（前端停止重连）', async () => {
    const code = h.issueCode('gh-sse204');
    const r = await activate(code);
    const { leaseId } = r.json().data;
    await h.app.inject({ method: 'POST', url: `/api/public/leases/${leaseId}/cancel` });
    const s = await h.app.inject({ method: 'GET', url: `/api/public/leases/${leaseId}/stream` });
    expect(s.statusCode).toBe(204);
  });

  it('SSE 流推送 message 快照与 done 终态', async () => {
    const code = h.issueCode('gh-sse');
    const r = await activate(code);
    const lease = h.manager.getLease(r.json().data.leaseId);
    const streamP = h.app.inject({
      method: 'GET',
      url: `/api/public/leases/${lease.id}/stream`,
    });
    // 等订阅建立后再 emit 收码，触发 received → done
    await new Promise((res) => setTimeout(res, 60));
    h.providers.acc1.emit(h.mailFor(301, lease));
    const res = await streamP;
    expect(res.payload).toContain('event: message');
    expect(res.payload).toContain('event: done');
    expect(res.payload).toContain('received');
  });
});

/** 限流：注入小阈值，同 code+IP 超阈值 → 429 */
describe('public activate 限流', () => {
  let h;
  beforeEach(async () => {
    vi.stubEnv('RATE_LIMIT_ACTIVATE_MAX', '3');
    h = await createApiHarness({ accounts: 1 });
  });
  afterEach(async () => {
    await h.app.close();
    vi.unstubAllEnvs();
  });

  it('同 code 超过 3 次 → 429', async () => {
    const code = h.issueCode('gh-rl');
    let last;
    for (let i = 0; i < 5; i++) {
      last = await h.app.inject({ method: 'POST', url: '/api/public/activate', payload: { code } });
    }
    expect(last.statusCode).toBe(429);
  });
});

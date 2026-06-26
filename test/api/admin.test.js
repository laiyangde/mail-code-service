import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApiHarness } from '../helpers/api-harness.js';

/** 管理后台：Admin Token 鉴权 + 账号 / 套餐 / 唯一码 / 监控 */
describe('admin 路由', () => {
  let h;
  beforeEach(async () => {
    vi.stubEnv('ADMIN_TOKEN', 'adm');
    h = await createApiHarness({ accounts: 1 });
  });
  afterEach(async () => {
    await h.app.close();
    vi.unstubAllEnvs();
  });

  const AUTH = { authorization: 'Bearer adm' };

  it('无 token → 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/stats' });
    expect(res.statusCode).toBe(401);
  });

  it('未配置 ADMIN_TOKEN → 503', async () => {
    vi.stubEnv('ADMIN_TOKEN', '');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('stats 返回池水位与队列/SSE', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/stats', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.pool.total).toBeGreaterThanOrEqual(1);
    expect(d.queue).toBe(0);
    expect(d.leases).toBeDefined();
  });

  it('账号列表（脱敏，不含 credsRef）', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/accounts', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const list = res.json().data;
    expect(list[0].id).toBe('acc1');
    expect(list[0]).not.toHaveProperty('credsRef');
  });

  it('plans upsert + 查询', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/admin/plans',
      headers: AUTH,
      payload: {
        prefix: 'tw',
        name: 'Twitter',
        allowedGroups: ['swpu'],
        targetSenders: ['@x.com'],
      },
    });
    expect(res.statusCode).toBe(200);
    const list = await h.app.inject({ method: 'GET', url: '/api/admin/plans', headers: AUTH });
    expect(list.json().data.find((p) => p.prefix === 'tw')).toBeTruthy();
  });

  it('codes 批量生成', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/admin/codes',
      headers: AUTH,
      payload: { prefix: 'gh', count: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.codes).toHaveLength(3);
    expect(res.json().data.codes[0]).toMatch(/^gh-/);
  });

  it('codes 不存在前缀 → 409', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/admin/codes',
      headers: AUTH,
      payload: { prefix: 'nope', count: 1 },
    });
    expect(res.statusCode).toBe(409);
  });

  it('账号禁用 / 启用', async () => {
    const off = await h.app.inject({
      method: 'POST',
      url: '/api/admin/accounts/acc1/disable',
      headers: AUTH,
    });
    expect(off.json().data.disabled).toBe(true);
    const on = await h.app.inject({
      method: 'POST',
      url: '/api/admin/accounts/acc1/enable',
      headers: AUTH,
    });
    expect(on.json().data.disabled).toBe(false);
  });

  it('吊销唯一码 → revoked', async () => {
    const code = h.issueCode('gh-rev');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/admin/codes/${code}/revoke`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('revoked');
    // 吊销后 activate 该码 → CODE_REVOKED
    const act = await h.app.inject({
      method: 'POST',
      url: '/api/public/activate',
      payload: { code },
    });
    expect(act.json().errCode).toBe('CODE_REVOKED');
  });
});

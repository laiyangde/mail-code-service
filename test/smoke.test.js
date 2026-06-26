import { describe, it, expect, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { createHarness } from './helpers/harness.js';

/** 健康检查：装配完整服务并响应 /healthz（含池水位） */
describe('健康检查', () => {
  const h = createHarness();
  let app;

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET /healthz 返回 200，含 ok 与池水位', async () => {
    app = await buildServer(h.services);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.pool).toMatchObject({ total: expect.any(Number), free: expect.any(Number) });
  });
});

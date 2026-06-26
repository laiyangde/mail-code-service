/**
 * API 测试 harness：在 {@link createHarness}（内存 DB + fake provider）之上接好事件桥并装配
 * fastify app，供 `app.inject()` 测试三组路由与 SSE。返回 harness 全部辅助 + app/sseHub/webhook。
 */
import { createHarness } from './harness.js';
import { buildServer } from '../../src/index.js';
import { SseHub } from '../../src/api/sse-hub.js';
import { WebhookDispatcher } from '../../src/api/webhook.js';

/**
 * @param {Parameters<typeof createHarness>[0]} [opts]
 * @returns {Promise<ReturnType<typeof createHarness> & { app: import('fastify').FastifyInstance, sseHub: SseHub, webhook: WebhookDispatcher }>}
 */
export async function createApiHarness(opts = {}) {
  const h = createHarness(opts);
  const sseHub = new SseHub();
  const webhook = new WebhookDispatcher({});
  h.manager.setEventHandler((type, leaseId, payload) => {
    sseHub.publish(type, leaseId, payload);
    webhook.onEvent(type, leaseId, payload);
  });
  const app = await buildServer(h.services, { sseHub, webhook });
  await app.ready();
  return { ...h, app, sseHub, webhook };
}

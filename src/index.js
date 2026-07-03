/**
 * 服务装配与启动入口（M6/M8）：装配核心调度栈 + 注册 public/v1/admin 路由 + SSE + 限流 +
 * 静态托管前端；接好「LeaseManager 事件 → SSE/Webhook」事件桥；启动期重启恢复（C-6）、
 * 删信/GC 定时任务（FR-9/10），并做优雅停机（NFR-9）。
 */
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import { config } from './config.js';
import { logger } from './logger.js';
import { getDb } from './store/db.js';
import { buildServices } from './services.js';
import { createProviderForAccount } from './provider/factory.js';
import { SseHub } from './api/sse-hub.js';
import { WebhookDispatcher } from './api/webhook.js';
import { startCleaner } from './cleaner/cleaner.js';
import { startGc } from './cleaner/gc.js';
import publicRoutes from './api/public.js';
import v1Routes from './api/v1.js';
import adminRoutes from './api/admin.js';

/**
 * 构建 fastify 实例（不监听端口），注册插件与全部路由。便于测试 `app.inject()`。
 * @param {import('./services.js').Services} services 已装配的核心栈
 * @param {object} [deps]
 * @param {SseHub} [deps.sseHub] 事件桥（缺省自建，测试可注入以断言推送）
 * @param {WebhookDispatcher} [deps.webhook] webhook 派发器（缺省自建）
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildServer(services, deps = {}) {
  // trustProxy：配了反代来源才取 X-Forwarded-For 的真实客户端 IP（限流按真实 IP 的前提）
  const app = Fastify({ loggerInstance: logger, trustProxy: config.trustProxy || false });
  const sseHub = deps.sseHub ?? new SseHub();
  const webhook = deps.webhook ?? new WebhookDispatcher(config.webhook);

  // 限流：global:false（仅显式配 config.rateLimit 的路由生效）；preHandler hook 让 keyGenerator 可读 body
  await app.register(fastifyRateLimit, {
    global: false,
    hook: 'preHandler',
    max: config.rateLimit.activateMax,
    timeWindow: config.rateLimit.windowSec * 1000,
  });
  await app.register(FastifySSEPlugin);

  // 健康检查（NFR-6）：池水位 + IMAP 健康账号数 + 排队数 + SSE 连接数
  app.get('/healthz', async () => {
    const pool = services.pool.stats();
    return {
      ok: true,
      pool,
      imap: { active: services.hub.bindings.size }, // 按需连：当前活跃 IMAP 连接数 = 活跃绑定数
      queue: services.queue.size,
      sse: sseHub.size,
    };
  });

  await app.register(publicRoutes, { prefix: '/api/public', services, sseHub });
  await app.register(v1Routes, { prefix: '/api/v1', services, webhook });
  await app.register(adminRoutes, { prefix: '/api/admin', services, sseHub });

  // 静态托管 Web 前端（M7）：仅当已构建产物存在才挂载，避免未构建时启动失败。
  // SPA fallback——非 /api 的 GET 落回 index.html，支持 `/r/:code` 刷新直达。
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
  if (existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ errCode: 'NOT_FOUND', errMsg: '资源不存在', data: null });
    });
  } else {
    logger.warn({ webDist }, 'web/dist 未构建，前端页面不可用（执行 npm run web:build 生成）');
  }

  // 关闭时停 IMAP 常驻连接、清超时定时器（M8 补全持久化在途租约）
  app.addHook('onClose', async () => {
    try {
      await services.hub.stopAll();
    } catch {
      /* 忽略关闭异常 */
    }
    services.timer.clear();
  });

  return app;
}

/** 启动 HTTP 服务并监听配置端口。 */
async function start() {
  // 关键签名密钥 fail-fast：缺失则拒绝启动（而非等首个 activate 才 500），部署自检即暴露
  try {
    void config.auth.codeSigningSecret;
  } catch (err) {
    logger.error({ err: err.message }, '缺少 CODE_SIGNING_SECRET，拒绝启动');
    process.exit(1);
  }

  const db = getDb();

  // 真实 providerFactory：onHealthy/onUnhealthy 是延迟回调，运行时 services 已就绪
  let services;
  const providerFactory = (account) =>
    createProviderForAccount(account, {
      onHealthy: () => services?.pool.setHealthy(account.id),
      onUnhealthy: () => services?.pool.setUnhealthy(account.id),
      headless: false, // 登录用有头，降风控（cloakbrowser 文档 §7.2）
    });
  services = buildServices({
    db,
    providerFactory,
    leaseConfig: {
      queueTimeoutSec: config.lease.queueTimeoutSec,
      retentionSec: config.lease.retentionSec,
    },
  });

  // 加载持久化会话（命中则免开浏览器，C-5）
  for (const acc of services.store.account.listEnabled()) {
    try {
      await services.pool.getProvider(acc.id)?.loadSession?.();
    } catch (err) {
      logger.warn({ accountId: acc.id, err: err.message }, '加载会话失败（首次别名请求时重登）');
    }
  }
  // 按需连模式：IMAP 不在启动时常驻，改由 LeaseManager 绑定租约时按需建连（见 ReceiverHub.bindLease）

  // 事件桥：LeaseManager 事件 → SSE + Webhook 共用同一事件源
  const sseHub = new SseHub();
  const webhook = new WebhookDispatcher(config.webhook);
  services.manager.setEventHandler((type, leaseId, payload) => {
    sseHub.publish(type, leaseId, payload);
    webhook.onEvent(type, leaseId, payload);
  });

  // 重启恢复（C-6）：须在事件桥之后，按需重连 IMAP 重建在途租约运行态
  try {
    await services.manager.recoverActiveLeases();
  } catch (err) {
    logger.error({ err: err.message }, '重启恢复失败（继续启动）');
  }

  // 删信 / GC 定时任务（FR-9/10）
  const cleaner = startCleaner(services, {
    intervalMs: config.maintenance.cleanupIntervalMs,
    beforeDays: config.maintenance.cleanupBeforeDays,
  });
  const gc = startGc(services, { intervalMs: config.maintenance.gcIntervalMs });

  const app = await buildServer(services, { sseHub, webhook });

  // 优雅停机（NFR-9）：停接收 → 停调度器 → app.close 触发 onClose 停 IMAP/定时器
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, '收到停机信号，开始优雅停机');
    // grace 兜底：无论 close/flush 是否卡住，最多 10s 强制退出（防被 SIGKILL）
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref?.();
    cleaner.stop();
    gc.stop();
    try {
      await app.close();
    } catch (err) {
      logger.error({ err: err.message }, 'app.close 异常');
    }
    logger.info('优雅停机完成');
    // pino 异步刷盘：先 flush 再退出，避免停机日志丢失
    await new Promise((resolve) => {
      if (typeof logger.flush === 'function') logger.flush(() => resolve());
      else resolve();
    });
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    logger.error(err, '服务启动失败');
    process.exit(1);
  }
}

// 仅当作为入口直接运行时才启动（被测试 import 时不自动监听）
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  start();
}

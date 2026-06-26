/**
 * 接入层鉴权钩子（M6，FR-7.1/FR-8.5）：自用 API 与 Admin 各一套独立密钥，互相隔离。
 *
 * 约定：服务端**未配置**对应密钥时返回 503「未启用」，而非放行——避免把「忘了配 key」
 * 误当成「公开入口」。密钥比较用 {@link timingSafeEqual} 防时序侧信道。
 */
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { sendError } from './response.js';

/**
 * 定长安全比较两个字符串（先比长度，避免 timingSafeEqual 因长度不等抛错）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 自用 API 鉴权（preHandler）：校验请求头 `X-API-Key`。
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 */
export async function apiKeyHook(req, reply) {
  const expected = config.auth.apiKey;
  if (!expected) {
    return sendError(reply, 503, 'API_DISABLED', '自用 API 未启用（未配置 API_KEY）');
  }
  const got = req.headers['x-api-key'];
  if (typeof got !== 'string' || !safeEqual(got, expected)) {
    return sendError(reply, 401, 'UNAUTHORIZED', '无效的 API Key');
  }
}

/**
 * Admin 鉴权（preHandler）：校验请求头 `Authorization: Bearer <ADMIN_TOKEN>`。
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 */
export async function adminHook(req, reply) {
  const expected = config.auth.adminToken;
  if (!expected) {
    return sendError(reply, 503, 'ADMIN_DISABLED', 'Admin 未启用（未配置 ADMIN_TOKEN）');
  }
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, expected)) {
    return sendError(reply, 401, 'UNAUTHORIZED', '无效的 Admin Token');
  }
}

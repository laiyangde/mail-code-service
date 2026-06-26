/**
 * 统一 HTTP 响应包装（M6，需求 §9）：响应体恒为 `{ errCode, errMsg, data }`，
 * 与 register-factory 的 `handleApiResponse()` 兼容——成功 `errCode:0`，失败为字符串错误码。
 *
 * {@link fail} 把调度层抛出的 {@link ApiError} 映射为合适的 HTTP 状态码；非业务错误
 * 一律 500 且不外泄内部细节（仅落日志）。
 */
import { ApiError, ErrorCode } from '../errors.js';

/** ApiError 错误码 → HTTP 状态码映射（未列出的业务错误兜底 400） */
const STATUS_BY_CODE = Object.freeze({
  [ErrorCode.CODE_NOT_FOUND]: 404,
  [ErrorCode.LEASE_NOT_FOUND]: 404,
  [ErrorCode.CODE_EXPIRED]: 410, // Gone：回看期满，资源已失效
  [ErrorCode.CODE_EXHAUSTED]: 409,
  [ErrorCode.CODE_REVOKED]: 409,
  [ErrorCode.PLAN_DISABLED]: 409,
  [ErrorCode.LEASE_NOT_TERMINAL]: 409,
  [ErrorCode.RENEW_LIMIT]: 409,
  [ErrorCode.POOL_BUSY]: 503,
});

/**
 * 底层错误响应（鉴权 / 限流等非 ApiError 场景直接调用）。
 * @param {import('fastify').FastifyReply} reply
 * @param {number} status HTTP 状态码
 * @param {string} errCode 业务错误码
 * @param {string} errMsg 中文描述
 * @returns {import('fastify').FastifyReply}
 */
export function sendError(reply, status, errCode, errMsg) {
  return reply.code(status).send({ errCode, errMsg, data: null });
}

/**
 * 成功响应。
 * @param {import('fastify').FastifyReply} reply
 * @param {unknown} [data] 业务数据
 * @returns {import('fastify').FastifyReply}
 */
export function ok(reply, data = null) {
  return reply.code(200).send({ errCode: 0, errMsg: 'ok', data });
}

/**
 * 失败响应：ApiError → 映射状态码；其它 → 500（脱敏，仅落日志）。
 * @param {import('fastify').FastifyReply} reply
 * @param {unknown} err
 * @returns {import('fastify').FastifyReply}
 */
export function fail(reply, err) {
  if (err instanceof ApiError) {
    const status = STATUS_BY_CODE[err.code] ?? 400;
    return sendError(reply, status, err.code, err.message);
  }
  reply.log.error({ err: err?.message ?? String(err) }, 'API 未预期错误');
  return sendError(reply, 500, 'INTERNAL', '服务内部错误');
}

/**
 * 统一业务错误码与 ApiError（需求 §9）。调度层抛 ApiError，API 层映射为 `{errCode,errMsg,data}`。
 */

/** 业务错误码 */
export const ErrorCode = Object.freeze({
  CODE_NOT_FOUND: 'CODE_NOT_FOUND', // 唯一码不存在
  CODE_EXPIRED: 'CODE_EXPIRED', // 已失效（回看期满）
  CODE_EXHAUSTED: 'CODE_EXHAUSTED', // 配额耗尽（已使用）
  CODE_REVOKED: 'CODE_REVOKED', // 已吊销
  PLAN_DISABLED: 'PLAN_DISABLED', // 套餐停用 / 不存在
  POOL_BUSY: 'POOL_BUSY', // 池满排队超时
  LEASE_NOT_FOUND: 'LEASE_NOT_FOUND', // 租约不存在
  LEASE_NOT_TERMINAL: 'LEASE_NOT_TERMINAL', // 当前租约非终态（不能 renew）
  RENEW_LIMIT: 'RENEW_LIMIT', // 超过最大重申请次数
});

/**
 * 业务错误：携带稳定错误码，供 API 层统一映射。
 */
export class ApiError extends Error {
  /**
   * @param {string} code {@link ErrorCode} 之一
   * @param {string} [message] 给人看的中文描述
   */
  constructor(code, message) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
  }
}

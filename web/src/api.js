/**
 * 公开接口客户端（M7 / 对接 src/api/public.js）。
 *
 * 后端响应恒为 `{ errCode, errMsg, data }`：成功 `errCode:0`，失败为字符串错误码。
 * 这里统一解析：成功返回 `data`；失败抛 {@link ApiError}（携带 errCode/errMsg），
 * 供视图按 errCode 渲染中文文案（errorText.js）。
 */

/** 业务错误：携带后端错误码，视图据此映射文案 */
export class ApiError extends Error {
  /**
   * @param {string} errCode 后端错误码（如 CODE_NOT_FOUND）
   * @param {string} errMsg 后端中文描述
   * @param {number} status HTTP 状态码
   */
  constructor(errCode, errMsg, status) {
    super(errMsg || errCode);
    this.name = 'ApiError';
    this.errCode = errCode;
    this.status = status;
  }
}

/**
 * 统一请求：解析 `{errCode,errMsg,data}`，失败抛 ApiError。
 * @param {string} path 以 /api 开头的同源路径
 * @param {RequestInit} [init]
 * @returns {Promise<any>} 成功时的 data
 */
async function request(path, init) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch {
    // 网络层失败（断网/服务不可达）
    throw new ApiError('NETWORK', '网络异常，请稍后重试', 0);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应（理论上不应发生）→ 落入下方状态判断 */
  }

  if (body && body.errCode === 0) return body.data;
  const errCode = body?.errCode ?? 'INTERNAL';
  const errMsg = body?.errMsg ?? '服务内部错误';
  throw new ApiError(String(errCode), errMsg, res.status);
}

/**
 * 申请邮箱（FR-6.1）。返回 active 租约视图，或 `{status:'used', results, retainUntil}` 回看。
 * @param {string} code 唯一码
 */
export const activate = (code) =>
  request('/api/public/activate', { method: 'POST', body: JSON.stringify({ code }) });

/**
 * 查询租约状态（SSE 不可用时轮询回退）。
 * @param {string} leaseId
 */
export const getLease = (leaseId) => request(`/api/public/leases/${encodeURIComponent(leaseId)}`);

/**
 * 超时后重申请（FR-3.5/6.5）。返回同 activate。
 * @param {string} leaseId
 */
export const renewLease = (leaseId) =>
  request(`/api/public/leases/${encodeURIComponent(leaseId)}/renew`, { method: 'POST' });

/**
 * 提前释放（FR-3.6）。
 * @param {string} leaseId
 */
export const cancelLease = (leaseId) =>
  request(`/api/public/leases/${encodeURIComponent(leaseId)}/cancel`, { method: 'POST' });

/**
 * 收码结果回看（FR-2.7/6.9）。
 * @param {string} code 唯一码
 * @returns {Promise<{results:object[], retainUntil:number|null}>}
 */
export const getResults = (code) =>
  request(`/api/public/codes/${encodeURIComponent(code)}/results`);

/** SSE 事件流地址 */
export const streamUrl = (leaseId) => `/api/public/leases/${encodeURIComponent(leaseId)}/stream`;

/**
 * 管理后台请求层（B2）：自动带 `Authorization: Bearer <ADMIN_TOKEN>`，统一解析
 * `{errCode,errMsg,data}`；401 抛出供上层登出。token 存 localStorage（固定密钥，无会话）。
 *
 * 注意：本模块非组件，**不弹 message**——只抛 {@link AdminError}，由调用组件用 App.useApp() 弹出。
 */
const TOKEN_KEY = 'mcs_admin_token';

/** @returns {string} 当前 token（未设为空串） */
export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
/** @param {string} t 写入 token */
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
/** 清除 token（登出 / 401） */
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/** 管理接口错误：携带后端错误码与 HTTP 状态码 */
export class AdminError extends Error {
  /**
   * @param {string} errCode 错误码
   * @param {string} errMsg 中文描述
   * @param {number} status HTTP 状态码
   */
  constructor(errCode, errMsg, status) {
    super(errMsg || errCode);
    this.name = 'AdminError';
    this.errCode = errCode;
    this.status = status;
  }
}

/**
 * 统一请求：带 Bearer 头；成功返回 data，失败抛 AdminError；401 单独标记。
 * @param {string} path /api/admin 开头的同源路径
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function request(path, init = {}) {
  let res;
  try {
    // 仅在有 body 时声明 JSON content-type：无 body 的 POST（如 revoke/relogin/disable）若仍带该头，
    // Fastify 会因空 body 抛 FST_ERR_CTP_EMPTY_JSON_BODY（400）。
    const headers = { Authorization: `Bearer ${getToken()}`, ...init.headers };
    if (init.body) headers['Content-Type'] = 'application/json';
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new AdminError('NETWORK', '网络异常，请稍后重试', 0);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON */
  }

  if (res.status === 401) throw new AdminError('UNAUTHORIZED', '密钥无效或已变更', 401);
  if (body && body.errCode === 0) return body.data;
  throw new AdminError(
    String(body?.errCode ?? 'INTERNAL'),
    body?.errMsg ?? '服务内部错误',
    res.status,
  );
}

/** 管理接口集合（对应 src/api/admin.js 的 9 个端点） */
export const adminApi = {
  stats: () => request('/api/admin/stats'),
  accounts: () => request('/api/admin/accounts'),
  addAccount: (b) => request('/api/admin/accounts', { method: 'POST', body: JSON.stringify(b) }),
  setAccountDisabled: (id, off) =>
    request(`/api/admin/accounts/${encodeURIComponent(id)}/${off ? 'disable' : 'enable'}`, {
      method: 'POST',
    }),
  relogin: (id) =>
    request(`/api/admin/accounts/${encodeURIComponent(id)}/relogin`, { method: 'POST' }),
  plans: () => request('/api/admin/plans'),
  upsertPlan: (b) => request('/api/admin/plans', { method: 'POST', body: JSON.stringify(b) }),
  genCodes: (prefix, count) =>
    request('/api/admin/codes', { method: 'POST', body: JSON.stringify({ prefix, count }) }),
  codesQuery: ({ status = '', prefix = '' } = {}) =>
    request(
      `/api/admin/codes?status=${encodeURIComponent(status)}&prefix=${encodeURIComponent(prefix)}`,
    ),
  revokeCode: (code) =>
    request(`/api/admin/codes/${encodeURIComponent(code)}/revoke`, { method: 'POST' }),
  deleteAccount: (id) =>
    request(`/api/admin/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  deletePlan: (prefix) =>
    request(`/api/admin/plans/${encodeURIComponent(prefix)}`, { method: 'DELETE' }),
  deleteCodes: (codes) =>
    request('/api/admin/codes', { method: 'DELETE', body: JSON.stringify({ codes }) }),
};

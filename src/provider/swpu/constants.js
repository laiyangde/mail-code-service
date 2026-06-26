/**
 * SWPU 邮箱站点常量。集中此处，避免散落各文件。
 */

/** 站点根（无尾斜杠，用于拼接 query） */
export const SWPU_BASE_URL = 'https://mail.swpu.edu.cn';

/** 登录页（浏览器 goto 的地址） */
export const SWPU_LOGIN_URL = 'https://mail.swpu.edu.cn/';

/**
 * 登录态探针 / zid 刷新路径（基座 FR-1.8 实测）。
 * ⚠️ 必须用 `?q=base`，不可用根路径 `/`——根路径无论 cookie 是否有效都回登录页。
 */
export const SWPU_PROBE_URL = 'https://mail.swpu.edu.cn/?q=base';

/** 登录成功判定：跳转后的 URL 含此片段 */
export const SWPU_LOGIN_SUCCESS_HINT = '?q=base';

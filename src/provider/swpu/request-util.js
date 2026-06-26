/**
 * 别名 HTTP 请求的 L1 拟真工具（NFR-8）：把登录浏览器的会话环境复刻到 axios 请求，
 * 让服务端难以区分「浏览器 XHR」与「脚本请求」。session 刷 zid 与 http 别名调用共用。
 *
 * 纯函数、无副作用，便于单测；不依赖 axios / 浏览器。
 */
import { SWPU_BASE_URL } from './constants.js';

/**
 * 把 cookie 数组拼成 `Cookie` 请求头（全量携带，非只挑会话 cookie，NFR-6）。
 * @param {Array<{name:string,value:string}>} cookies
 * @returns {string}
 */
export function cookieHeader(cookies) {
  return (cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * 构造一组「像浏览器」的请求头：复用登录时抓取的 UA / sec-ch-ua 等，叠加固定 Accept 系列、
 * Referer / Origin / X-Requested-With，并带全量 Cookie。
 * @param {import('../email-provider.js').Session} session 当前会话凭证
 * @param {Record<string,string>} [extra] 追加 / 覆盖的头（如 Content-Type）
 * @returns {Record<string,string>}
 */
export function buildHeaders(session, extra = {}) {
  return {
    'User-Agent': session.ua || '',
    Accept: 'text/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${SWPU_BASE_URL}/`,
    Origin: SWPU_BASE_URL,
    // 登录时抓取的 sec-ch-ua 等环境头（若有），作为基础再被 extra 覆盖
    ...(session.headers || {}),
    Cookie: cookieHeader(session.cookies),
    ...extra,
  };
}

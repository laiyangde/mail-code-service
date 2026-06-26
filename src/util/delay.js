/**
 * 通用延迟工具。
 */

/**
 * 原生 sleep。
 * ⚠️ 不要用 Playwright 的 `page.waitForTimeout()`——它会发 CDP 命令，可能被反 bot
 * 系统（如 reCAPTCHA）检测（cloakbrowser 文档 §10.1）；登录等场景一律用本函数。
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在 [min, max) 区间内随机延迟，用于拟人化操作节奏。
 * @param {number} min 下限（毫秒）
 * @param {number} max 上限（毫秒）
 * @returns {Promise<void>}
 */
export function randomDelay(min, max) {
  const span = Math.max(0, max - min);
  return sleep(min + Math.floor(Math.random() * span));
}

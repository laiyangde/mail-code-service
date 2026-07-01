/**
 * 前端导出工具（B3）：把文本作为文件触发浏览器下载（唯一码 txt / 取码链接 csv）。
 */

/**
 * 触发浏览器下载一段文本。
 * @param {string} filename 文件名
 * @param {string} text 文本内容
 * @param {string} [mime] MIME 类型
 */
export function download(filename, text, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 兼容后端返回的码为字符串或 `{code}` 对象，统一取码文本。
 * @param {string|{code:string}} c
 * @returns {string}
 */
export const codeText = (c) => (typeof c === 'string' ? c : c.code);

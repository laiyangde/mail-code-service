/**
 * 结构化日志（NFR-6）+ 脱敏（NFR-1：严禁明文凭据/cookie/IMAP 密码入日志）。
 *
 * 两层防护：
 * 1. pino `redact` 按路径抹除常见字段（fastify 也复用同一实例，请求日志一并脱敏）；
 * 2. {@link redactSecrets} 递归按 key 名子串匹配，兜底处理结构不确定的对象
 *    （如 Provider 会话、HTTP 头），塞进日志前先过它。
 */
import pino from 'pino';

/** 敏感字段名片段（小写子串匹配）：key 命中其一即脱敏 */
const SECRET_KEY_HINTS = [
  'password',
  'pass',
  'cookie',
  'token',
  'secret',
  'authorization',
  'creds',
  'apikey',
];

/** 脱敏后的占位文本 */
const CENSOR = '[已脱敏]';

/** pino redact 路径：精确名 + 单层通配，覆盖常见嵌套结构 */
const REDACT_PATHS = [
  'password',
  '*.password',
  'pass',
  '*.pass',
  'imapPass',
  '*.imapPass',
  'cookie',
  '*.cookie',
  'cookies',
  '*.cookies',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  'adminToken',
  '*.adminToken',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
  'headers.cookie',
  'headers.authorization',
];

/** 应用级 logger 实例；fastify 通过 loggerInstance 复用它，全链路脱敏一致 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: REDACT_PATHS, censor: CENSOR },
  // 去掉 pid/hostname，日志更干净；时间用 ISO 便于排查
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * 判断字段名是否疑似敏感。
 * @param {string} key
 * @returns {boolean}
 */
function isSecretKey(key) {
  const lower = String(key).toLowerCase();
  return SECRET_KEY_HINTS.some((hint) => lower.includes(hint));
}

/**
 * 递归脱敏任意对象/数组：命中敏感 key 的值替换为占位符，原对象不被修改。
 * 带循环引用保护。基本类型原样返回。
 * @param {unknown} input 待脱敏的值
 * @param {WeakSet<object>} [seen] 内部用于防环
 * @returns {unknown} 脱敏后的副本
 */
export function redactSecrets(input, seen = new WeakSet()) {
  if (input === null || typeof input !== 'object') return input;
  if (seen.has(input)) return '[循环引用]';
  seen.add(input);

  if (Array.isArray(input)) {
    return input.map((item) => redactSecrets(item, seen));
  }

  const out = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = isSecretKey(key) ? CENSOR : redactSecrets(value, seen);
  }
  return out;
}

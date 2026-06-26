/**
 * SWPU 账号凭据解析：把 email_account.creds_ref（如 'SWPU_ACCT_1'）映射到 .env 中的
 * 一组键，**凭据明文只存在于 .env，DB 仅存引用**（NFR-1）。
 *
 * 约定的 .env 键（见 .env.example）：
 *   <ref>_NAME       登录用户名（完整邮箱或登录页要求的账号名）
 *   <ref>_PASS       登录密码
 *   <ref>_IMAP_PASS  IMAP 客户端独立密码（非登录密码）
 *   <ref>_GROUP      分组（默认 swpu）
 */
import { requireEnv, optionalEnv } from '../../config.js';

/**
 * @typedef {Object} SwpuCredentials
 * @property {string} loginUser 登录页 #user 填入的账号（用户按登录页要求填）
 * @property {string} email 完整邮箱地址（IMAP user、别名地址的域基准）
 * @property {string} pass 登录密码
 * @property {string} imapPass IMAP 独立密码
 * @property {string} group 分组
 */

/**
 * 从 creds_ref 解析单账号凭据。任一必填键缺失即抛错（fail-fast）。
 * @param {string} credsRef 凭据引用前缀（如 'SWPU_ACCT_1'）
 * @param {string} [domain] 邮箱域名，用于在 NAME 不含 '@' 时补全完整邮箱
 * @returns {SwpuCredentials}
 */
export function resolveSwpuCredentials(credsRef, domain = 'swpu.edu.cn') {
  const name = requireEnv(`${credsRef}_NAME`);
  // NAME 已是完整邮箱则直接用；否则按域名补全，供 IMAP 登录与别名拼接
  const email = name.includes('@') ? name : `${name}@${domain}`;
  return {
    loginUser: name,
    email,
    pass: requireEnv(`${credsRef}_PASS`),
    imapPass: requireEnv(`${credsRef}_IMAP_PASS`),
    group: optionalEnv(`${credsRef}_GROUP`, 'swpu'),
  };
}

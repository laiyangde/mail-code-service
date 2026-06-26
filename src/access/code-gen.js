/**
 * 唯一码生成（FR-2.2/2.3）：`<prefix>-<128bit 随机 hex>`，不可枚举（NFR-1）。
 */
import { randomBytes } from 'node:crypto';

/**
 * 生成一个唯一码。
 * @param {string} prefix 套餐前缀
 * @returns {string} `<prefix>-<32位 hex>`（128 bit 随机）
 */
export function generateCode(prefix) {
  return `${prefix}-${randomBytes(16).toString('hex')}`;
}

/**
 * 按套餐批量生成唯一码并入库（管理员用，FR-2.3）。
 * 初始 `quota_left = plan.quota`、`status = unused`（永久有效，retain_until = NULL）。
 * @param {object} store
 * @param {string} prefix 套餐前缀（须已存在）
 * @param {number} count 数量
 * @param {number} [issuedAt] 签发时间戳（ms）
 * @returns {string[]} 生成的唯一码
 */
export function batchGenerate(store, prefix, count, issuedAt = Date.now()) {
  const plan = store.plan.getByPrefix(prefix);
  if (!plan) throw new Error(`套餐前缀不存在：${prefix}`);
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = generateCode(prefix);
    store.accessCode.insert({ code, prefix, status: 'unused', quotaLeft: plan.quota, issuedAt });
    codes.push(code);
  }
  return codes;
}

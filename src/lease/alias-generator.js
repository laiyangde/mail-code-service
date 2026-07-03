/**
 * 别名生成（FR-3.3）：在 provider 的 aliasRule 约束内生成一个拟真的姓名式别名（本地部分，不含域名）。
 * 域内唯一与冲突重试由 provider.setAlias 加后缀负责；本模块只产出一个合规候选。
 *
 * 策略：按持久化游标顺序取「姓拼音 + 名拼音」（字典见 alias-dict.js），再补 1~2 位随机数字。
 * 姓拼音天然字母开头，满足多数平台「首字符为字母」约束；超 maxLen 时截断姓名基串，不足 minLen 时补随机数字。
 */
import { randomBytes } from 'node:crypto';
import { SURNAMES, GIVEN_NAMES } from './alias-dict.js';

/**
 * 生成 [min,max] 内的随机整数（含端点），用 crypto 保证不可预测。
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randomInt(min, max) {
  return min + (randomBytes(1)[0] % (max - min + 1));
}

/**
 * 生成指定位数的随机数字串。
 * @param {number} length
 * @returns {string}
 */
function randomDigits(length) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String(bytes[i] % 10);
  }
  return out;
}

/**
 * 按游标生成一个合规别名候选。
 * @param {import('../provider/email-provider.js').AliasRule} [aliasRule]
 * @param {{ surnameIndex?: number, givenNameIndex?: number }} [cursor] 由 store.aliasIndex.advance() 提供的顺序游标
 * @returns {string} 别名本地部分（含可选 prefix/suffix）
 */
export function generateAlias(aliasRule = {}, cursor = {}) {
  const min = aliasRule.minLen ?? 8;
  const max = aliasRule.maxLen ?? 14;

  const surname = SURNAMES[(cursor.surnameIndex ?? 0) % SURNAMES.length];
  const givenName = GIVEN_NAMES[(cursor.givenNameIndex ?? 0) % GIVEN_NAMES.length];

  // 随机 1~2 位数字后缀
  const digitCount = randomInt(1, 2);
  // 截断姓名基串：保证「基串 + 数字」不超过 maxLen（至少保留 1 字符，维持字母开头）
  const maxBase = Math.max(1, max - digitCount);
  let base = `${surname}${givenName}`;
  if (base.length > maxBase) {
    base = base.slice(0, maxBase);
  }

  let body = `${base}${randomDigits(digitCount)}`;
  // 兜底 minLen：过短则继续补随机数字（仍不越 maxLen）
  while (body.length < min && body.length < max) {
    body += randomDigits(1);
  }

  return `${aliasRule.prefix ?? ''}${body}${aliasRule.suffix ?? ''}`;
}

/**
 * 别名生成（FR-3.3）：在 provider 的 aliasRule 约束内生成一个候选别名（本地部分，不含域名）。
 * 域内唯一与冲突重试由 provider.setAlias 加后缀负责；本模块只产出一个合规候选。
 *
 * 策略：首字符取字母（多数平台要求字母开头），其余字母 + 数字，随机不可读但合规。
 */
import { randomBytes } from 'node:crypto';

const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * @param {import('../provider/email-provider.js').AliasRule} [aliasRule]
 * @returns {string} 别名本地部分（含可选 prefix/suffix）
 */
export function generateAlias(aliasRule = {}) {
  const min = aliasRule.minLen ?? 8;
  const max = aliasRule.maxLen ?? 14;
  // 取一个落在 [min,max] 的目标长度（偏向 10）
  const targetLen = Math.min(max, Math.max(min, 10));
  const bytes = randomBytes(targetLen);
  let body = ALPHA[bytes[0] % ALPHA.length];
  for (let i = 1; i < targetLen; i++) {
    body += ALNUM[bytes[i] % ALNUM.length];
  }
  return `${aliasRule.prefix ?? ''}${body}${aliasRule.suffix ?? ''}`;
}

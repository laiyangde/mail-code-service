/**
 * SWPU 能力与规则声明（ProviderCaps）。
 * 调度核心据此驱动别名生成、收码默认正则、删信能力开关。
 */

/**
 * @returns {import('../email-provider.js').ProviderCaps}
 */
export function swpuCapabilities() {
  return {
    // 别名规则：保守默认（小写字母 + 数字，6–18 长度）。
    // 注意：SWPU 实际字符集 / 长度上限需用真实账号在「设置别名」处验证后校正。
    aliasRule: {
      charset: 'a-z0-9',
      minLen: 6,
      maxLen: 18,
      domain: 'swpu.edu.cn',
    },
    receiveChannel: 'imap',
    supportsImapDelete: true,
    // 便利字段：默认 4–8 位数字；抽取失败不影响「成功收码」判定（交付整封邮件）
    codeRegex: /\b(\d{4,8})\b/,
  };
}

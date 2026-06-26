/**
 * 测试用 fake EmailProvider：实现 §0.1 接口形状，收码可手动 emit() 触发，
 * 别名 / 会话等返回可控结果。用于在不连真实 SWPU 的前提下测试 Pool / Hub / LeaseManager。
 */
import { assertEmailProvider } from '../../src/provider/email-provider.js';

/**
 * @param {string} accountId
 * @param {object} [opts]
 * @param {string} [opts.group]
 * @param {string} [opts.domain]
 * @param {(alias:string)=>Promise<{ok:boolean,finalAlias:string}>} [opts.setAliasImpl] 覆盖 setAlias 行为
 * @returns {object} fake provider（含测试辅助 emit/match/hasSub）
 */
export function createFakeProvider(accountId, opts = {}) {
  const { group = 'swpu', domain = 'swpu.edu.cn', setAliasImpl } = opts;
  let handler = null;
  let currentMatch = null;

  const fake = {
    accountId,
    domain,
    group,
    capabilities: () => ({
      aliasRule: { charset: 'a-z0-9', minLen: 6, maxLen: 18, domain },
      receiveChannel: 'imap',
      supportsImapDelete: true,
      codeRegex: /\b(\d{4,8})\b/,
    }),
    login: async () => ({}),
    isSessionValid: () => true,
    ensureSession: async () => ({}),
    getCurrentAlias: async () => 'old-alias',
    setAlias: setAliasImpl || (async (alias) => ({ ok: true, finalAlias: alias })),
    subscribeMail: (match, onMail) => {
      currentMatch = match;
      handler = onMail;
      return () => {
        handler = null;
        currentMatch = null;
      };
    },
    cleanup: async () => ({ deleted: 0 }),
    // 生命周期（非接口）
    startReceiver: async () => {},
    stopReceiver: async () => {},
    loadSession: async () => {},
    // 测试辅助
    emit: (mail) => handler?.(mail),
    get match() {
      return currentMatch;
    },
    get hasSub() {
      return !!handler;
    },
  };
  assertEmailProvider(fake); // 确保 fake 仍是合法 provider 形状
  return fake;
}

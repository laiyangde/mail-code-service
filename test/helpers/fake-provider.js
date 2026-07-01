/**
 * 测试用 fake EmailProvider：实现 §0.1 接口形状，收码可手动 emit() 触发，
 * 别名 / 会话等返回可控结果。用于在不连真实 SWPU 的前提下测试 Pool / Hub / LeaseManager。
 *
 * **按需连**：startReceiver/stopReceiver 记录连接状态（started/startCount/stopCount）供断言，
 * 并支持 setFailStart() 运行时模拟「按需建连失败」，用于 LeaseManager 回滚用例。
 */
import { assertEmailProvider } from '../../src/provider/email-provider.js';

/**
 * @param {string} accountId
 * @param {object} [opts]
 * @param {string} [opts.group]
 * @param {string} [opts.domain]
 * @param {boolean} [opts.failStart] 初始是否模拟 startReceiver 失败
 * @param {(alias:string)=>Promise<{ok:boolean,finalAlias:string}>} [opts.setAliasImpl] 覆盖 setAlias 行为
 * @returns {object} fake provider（含测试辅助 emit/match/hasSub/started/setFailStart）
 */
export function createFakeProvider(accountId, opts = {}) {
  const { group = 'swpu', domain = 'swpu.edu.cn', setAliasImpl } = opts;
  let handler = null;
  let currentMatch = null;
  let started = false;
  let startCount = 0;
  let stopCount = 0;
  let failStart = opts.failStart ?? false;

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
    // 生命周期（非接口）：按需连——记录连接状态，可模拟连接失败
    startReceiver: async () => {
      startCount++;
      if (failStart) throw new Error('fake IMAP 连接失败');
      started = true;
    },
    stopReceiver: async () => {
      stopCount++;
      started = false;
    },
    loadSession: async () => {},
    // 测试辅助
    emit: (mail) => handler?.(mail),
    setFailStart: (v) => {
      failStart = v;
    },
    get match() {
      return currentMatch;
    },
    get hasSub() {
      return !!handler;
    },
    get started() {
      return started;
    },
    get startCount() {
      return startCount;
    },
    get stopCount() {
      return stopCount;
    },
  };
  assertEmailProvider(fake); // 确保 fake 仍是合法 provider 形状
  return fake;
}

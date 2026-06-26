/**
 * Provider 工厂：按账号的大学 / 域名选择对应的 EmailProvider 实现（§0.3 多大学扩展点）。
 * 新增大学 = 在此登记一个分支 + 实现 `src/provider/<school>/`，**调度核心零改动**。
 */
import { createSwpuProvider } from './swpu/index.js';

/**
 * 为一个账号创建 EmailProvider 实例。
 * @param {object} account email_account 行（含 id/university/domain/groupName/credsRef）
 * @param {object} [callbacks]
 * @param {() => void} [callbacks.onHealthy] IMAP 恢复回调
 * @param {(err: Error) => void} [callbacks.onUnhealthy] IMAP 连续失败回调
 * @param {boolean} [callbacks.headless] 登录是否无头
 * @returns {import('./email-provider.js').EmailProvider}
 */
export function createProviderForAccount(account, callbacks = {}) {
  const university = (account.university || '').toUpperCase();
  if (university === 'SWPU' || account.domain === 'swpu.edu.cn') {
    return createSwpuProvider({
      accountId: account.id,
      credsRef: account.credsRef,
      group: account.groupName,
      headless: callbacks.headless,
      onHealthy: callbacks.onHealthy,
      onUnhealthy: callbacks.onUnhealthy,
    });
  }
  throw new Error(
    `暂不支持的大学 / 域名：${account.university} / ${account.domain}` +
      `（§0.3：新增大学需在 provider/factory.js 登记并实现 provider/<school>/）`,
  );
}

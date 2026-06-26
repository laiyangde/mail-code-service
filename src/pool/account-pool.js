/**
 * 资源层 AccountPool（M3 / FR-1）：维护账号清单与健康态，原子分配 / 释放账号。
 *
 * 两个维度分开管理：
 * - **占用**（free / leased / disabled）：落 DB `email_account.status`，**重启可恢复占用关系**（C-6）；
 * - **IMAP 健康度**：纯内存态（连通性，重启后重连重新评估），由 ReceiverHub 的 onHealthy/onUnhealthy 驱动。
 *
 * 所有占用变更经**单写串行执行器**（INV-2/NFR-3：杜绝并发把同一账号分给两个租约）。
 */
export class AccountPool {
  /**
   * @param {object} opts
   * @param {object} opts.store Store（含 account repo）
   * @param {import('../core/serial-executor.js').SerialExecutor} opts.serialExecutor
   * @param {number} [opts.cooldownMs] 释放后冷却时长（给 IMAP/别名状态稳定，FR-1.4），默认 0
   */
  constructor({ store, serialExecutor, cooldownMs = 0 }) {
    this.store = store;
    this.exec = serialExecutor;
    this.cooldownMs = cooldownMs;
    /** @type {Map<string, import('../provider/email-provider.js').EmailProvider>} */
    this.providers = new Map();
    /** @type {Map<string, boolean>} accountId → IMAP 是否健康（缺省视为健康） */
    this.healthy = new Map();
    /** @type {Map<string, number>} accountId → 冷却截止时间戳 */
    this.cooldownUntil = new Map();
  }

  /**
   * 登记账号的 provider 实例（装配期调用）。
   * @param {string} accountId
   * @param {import('../provider/email-provider.js').EmailProvider} provider
   */
  registerProvider(accountId, provider) {
    this.providers.set(accountId, provider);
  }

  /**
   * @param {string} accountId
   * @returns {import('../provider/email-provider.js').EmailProvider | undefined}
   */
  getProvider(accountId) {
    return this.providers.get(accountId);
  }

  /** 标记 IMAP 健康（onHealthy 回调）。 */
  setHealthy(accountId) {
    this.healthy.set(accountId, true);
  }

  /** 标记 IMAP 不健康（onUnhealthy 回调）→ 暂不参与分配（FR-1.2）。 */
  setUnhealthy(accountId) {
    this.healthy.set(accountId, false);
  }

  /**
   * 账号是否可参与分配的健康判定（缺省/未知视为健康，乐观）。
   * @param {string} accountId
   * @returns {boolean}
   */
  _isHealthy(accountId) {
    return this.healthy.get(accountId) !== false;
  }

  /**
   * 原子获取一个空闲账号（经串行执行器，杜绝并发双占）。
   * @param {string[]} allowedGroups 允许的分组（来自 plan）
   * @returns {Promise<object|null>} 选中的账号行，或 null（无空闲）
   */
  async acquire(allowedGroups) {
    return this.exec.submit(() => this._acquireSync(allowedGroups));
  }

  /**
   * acquire 的同步体（在串行执行器内运行，天然无竞态）。
   * @param {string[]} allowedGroups
   * @returns {object|null}
   */
  _acquireSync(allowedGroups) {
    const now = Date.now();
    const groups = new Set(allowedGroups);
    const account = this.store.account
      .listEnabled()
      .find(
        (a) =>
          a.status === 'free' &&
          groups.has(a.groupName) &&
          this._isHealthy(a.id) &&
          (this.cooldownUntil.get(a.id) ?? 0) <= now,
      );
    if (!account) return null;
    this.store.account.updateStatus(account.id, 'leased', now);
    return account;
  }

  /**
   * 同步释放（在串行执行器上下文内调用，如收码交付 / 超时的副作用，避免嵌套 submit）。
   * @param {string} accountId
   */
  releaseSync(accountId) {
    const now = Date.now();
    this.store.account.updateStatus(accountId, 'free', now);
    if (this.cooldownMs > 0) {
      this.cooldownUntil.set(accountId, now + this.cooldownMs);
    }
  }

  /**
   * 释放账号置回 free（经串行执行器），可选进入冷却期。
   * @param {string} accountId
   * @returns {Promise<void>}
   */
  async release(accountId) {
    return this.exec.submit(() => this.releaseSync(accountId));
  }

  /**
   * 池水位统计（healthz / 监控，NFR-6）。
   * @returns {{ total:number, free:number, leased:number, unhealthy:number, disabled:number }}
   */
  stats() {
    const all = this.store.account.list();
    const out = { total: all.length, free: 0, leased: 0, unhealthy: 0, disabled: 0 };
    for (const a of all) {
      if (a.disabled) out.disabled++;
      else if (a.status === 'leased') out.leased++;
      else if (!this._isHealthy(a.id)) out.unhealthy++;
      else out.free++;
    }
    return out;
  }
}

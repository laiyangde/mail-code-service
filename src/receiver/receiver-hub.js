/**
 * 收码聚合 ReceiverHub（M4 / FR-4）：**按需**为活跃租约建 IMAP 订阅——绑定租约时连接 + 订阅、
 * 解绑时取消订阅并后台断连；命中邮件按 C-4 路由到该账号**当前活跃租约**，交给 LeaseManager 做原子交付。
 *
 * 幂等分两层：
 * - **预检**（本层，优化）：`processed_mail.exists` 命中直接丢弃，省一次交付事务；
 * - **权威**（M5 deliver 的原子事务内 `INSERT processed_mail`）：崩溃也原子，是真正的护栏（FR-0 M5）。
 *
 * 因 C-1「每账号至多一个活跃租约」，一个账号同一时刻仅一条绑定（也仅一条 IMAP 连接）。
 */
import { logger } from '../logger.js';

export class ReceiverHub {
  /**
   * @param {object} opts
   * @param {import('../pool/account-pool.js').AccountPool} opts.pool
   * @param {object} opts.store
   * @param {import('../core/serial-executor.js').SerialExecutor} opts.serialExecutor
   */
  constructor({ pool, store, serialExecutor }) {
    this.pool = pool;
    this.store = store;
    this.exec = serialExecutor;
    /** @type {((payload: {accountId:string, lease:object, mail:object}) => void) | null} */
    this.onDeliver = null;
    /** @type {Map<string, { leaseId: string, unsub: () => void }>} accountId → 当前绑定 */
    this.bindings = new Map();
  }

  /**
   * 注入交付处理器（LeaseManager 的原子交付入口）。
   * 约定：**在串行执行器上下文内被同步调用**，内部不得再 submit（直接操作 store）。
   * @param {(payload: {accountId:string, lease:object, mail:object}) => void} fn
   */
  setDeliverHandler(fn) {
    this.onDeliver = fn;
  }

  /**
   * 把某账号的收码绑定到一个活跃租约：**按需建 IMAP 连接** + 订阅（createLease 置 active 后调用）。
   * 连接失败会抛出，由 LeaseManager 回滚本次申请（释放账号、租约置终态、唯一码退回 unused）。
   * @param {string} accountId
   * @param {object} lease 活跃租约（至少含 id、accessCode）
   * @param {import('../provider/email-provider.js').MailMatch} match
   * @returns {Promise<void>}
   */
  async bindLease(accountId, lease, match) {
    const provider = this.pool.getProvider(accountId);
    if (!provider) throw new Error(`账号 ${accountId} 无 provider，无法绑定收码`);
    this.unbindLease(accountId); // 防泄漏：先解绑旧订阅（同步 + 后台断旧连）
    await provider.startReceiver(); // 按需建连（失败抛错 → LeaseManager 回滚）
    const unsub = provider.subscribeMail(match, (mail) => this._onMail(accountId, lease, mail));
    this.bindings.set(accountId, { leaseId: lease.id, unsub });
    logger.info({ accountId, leaseId: lease.id, to: match.to }, 'ReceiverHub：绑定收码到租约');
  }

  /**
   * 解绑某账号的收码（租约终态：received/expired/cancelled 后调用）。
   * **同步**取消订阅（在串行执行器上下文内被调用），随后**后台断连**（fire-and-forget）。
   * @param {string} accountId
   */
  unbindLease(accountId) {
    const binding = this.bindings.get(accountId);
    if (!binding) return;
    try {
      binding.unsub?.();
    } catch {
      /* 忽略取消订阅异常 */
    }
    this.bindings.delete(accountId);
    // 后台断连（fire-and-forget）：断连成败不影响 FR-0（交付已在原子事务内完成），不阻塞同步交付路径
    this.pool
      .getProvider(accountId)
      ?.stopReceiver?.()
      .catch((err) =>
        logger.warn({ accountId, err: err.message }, 'ReceiverHub：IMAP 后台断连失败（忽略）'),
      );
  }

  /**
   * 命中邮件回调：经串行执行器 → 预检幂等 → 交给 LeaseManager 原子交付。
   * @param {string} accountId
   * @param {object} lease 绑定时的租约
   * @param {import('../provider/email-provider.js').MailMeta} mail
   */
  _onMail(accountId, lease, mail) {
    this.exec.submit(() => {
      if (this.store.processedMail.exists(accountId, mail.uid)) {
        logger.info({ accountId, uid: mail.uid }, 'ReceiverHub：重复邮件，预检丢弃');
        return;
      }
      if (!this.onDeliver) {
        logger.warn({ accountId, uid: mail.uid }, 'ReceiverHub：未设置交付处理器，邮件丢弃');
        return;
      }
      // 同步交付（M5 原子事务：权威幂等 + active→received + 扣配额）
      this.onDeliver({ accountId, lease, mail });
    });
  }

  /** 停止全部订阅与连接（优雅停机）。 */
  async stopAll() {
    for (const accountId of [...this.bindings.keys()]) {
      this.unbindLease(accountId);
    }
    for (const acc of this.store.account.listEnabled()) {
      const provider = this.pool.getProvider(acc.id);
      try {
        await provider?.stopReceiver?.();
      } catch {
        /* 忽略关闭异常 */
      }
    }
  }
}

/**
 * 收码聚合 ReceiverHub（M4 / FR-4）：为每启用账号建常驻 IMAP 订阅，命中邮件按 C-4 路由到
 * 该账号**当前活跃租约**，交给 LeaseManager 做原子交付。
 *
 * 幂等分两层：
 * - **预检**（本层，优化）：`processed_mail.exists` 命中直接丢弃，省一次交付事务；
 * - **权威**（M5 deliver 的原子事务内 `INSERT processed_mail`）：崩溃也原子，是真正的护栏（FR-0 M5）。
 *
 * 因 C-1「每账号至多一个活跃租约」，一个账号同一时刻仅一条绑定。
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

  /** 启动所有启用账号的常驻 IMAP 连接（warmup / 启动序列调用，FR-1.5）。 */
  async start() {
    for (const acc of this.store.account.listEnabled()) {
      const provider = this.pool.getProvider(acc.id);
      if (!provider) continue;
      try {
        await provider.startReceiver();
        this.pool.setHealthy(acc.id);
        logger.info({ accountId: acc.id }, 'ReceiverHub：账号 IMAP 常驻就绪');
      } catch (err) {
        this.pool.setUnhealthy(acc.id);
        logger.warn({ accountId: acc.id, err: err.message }, 'ReceiverHub：账号 IMAP 启动失败');
      }
    }
  }

  /**
   * 把某账号的收码绑定到一个活跃租约（createLease 置 active 后调用）。
   * @param {string} accountId
   * @param {object} lease 活跃租约（至少含 id、accessCode）
   * @param {import('../provider/email-provider.js').MailMatch} match
   */
  bindLease(accountId, lease, match) {
    const provider = this.pool.getProvider(accountId);
    if (!provider) throw new Error(`账号 ${accountId} 无 provider，无法绑定收码`);
    this.unbindLease(accountId); // 防泄漏：先解绑旧订阅
    const unsub = provider.subscribeMail(match, (mail) => this._onMail(accountId, lease, mail));
    this.bindings.set(accountId, { leaseId: lease.id, unsub });
    logger.info({ accountId, leaseId: lease.id, to: match.to }, 'ReceiverHub：绑定收码到租约');
  }

  /**
   * 解绑某账号的收码（租约终态：received/expired/cancelled 后调用）。
   * @param {string} accountId
   */
  unbindLease(accountId) {
    const binding = this.bindings.get(accountId);
    if (binding) {
      try {
        binding.unsub?.();
      } catch {
        /* 忽略取消订阅异常 */
      }
      this.bindings.delete(accountId);
    }
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

  /** 停止全部订阅与常驻连接（优雅停机）。 */
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

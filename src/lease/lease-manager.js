/**
 * 调度核心 LeaseManager（C 层 / M5）：取码闭环 + FR-0 全护栏。
 *
 * 并发模型（关键）：
 * - **状态变更**（DB 写）一律经 SerialExecutor，短小同步，消 TOCTOU（INV-6）；
 * - **慢 I/O**（provider.setAlias，可能开浏览器）放在执行器**外**，不阻塞其它账号（C-2 跨账号并行）；
 * - **单飞锁**（LockPort）：同一 accessCode 的 activate 串行，第二个进入即复用首个的活跃租约（封堵路径 A，配合 INV-1）；
 * - **收码交付**：在执行器内的**同步原子事务**（权威幂等 + active→received + 扣配额，INV-3/4/5）。
 */
import { randomUUID } from 'node:crypto';
import { immediateTx } from '../store/tx.js';
import { generateAlias } from './alias-generator.js';
import { ApiError, ErrorCode } from '../errors.js';
import { isLeaseTerminal } from '../core/state-machine.js';
import { logger } from '../logger.js';

const nowSec = () => Math.floor(Date.now() / 1000);

export class LeaseManager {
  /**
   * @param {object} opts
   * @param {object} opts.store
   * @param {import('../core/serial-executor.js').SerialExecutor} opts.serialExecutor
   * @param {import('../pool/account-pool.js').AccountPool} opts.pool
   * @param {import('../receiver/receiver-hub.js').ReceiverHub} opts.hub
   * @param {import('../access/access-service.js').AccessService} opts.accessService
   * @param {import('./ports/lock.js').MemoryLock} opts.lock
   * @param {import('./ports/queue.js').MemoryWaitQueue} opts.queue
   * @param {import('./timer.js').LeaseTimer} opts.timer
   * @param {{ acquireTimeoutSec?: number, retentionSec?: number }} [opts.config]
   */
  constructor({
    store,
    serialExecutor,
    pool,
    hub,
    accessService,
    lock,
    queue,
    timer,
    config = {},
  }) {
    this.store = store;
    this.exec = serialExecutor;
    this.pool = pool;
    this.hub = hub;
    this.accessService = accessService;
    this.lock = lock;
    this.queue = queue;
    this.timer = timer;
    this.acquireTimeoutMs = (config.acquireTimeoutSec ?? 60) * 1000;
    this.defaultRetentionSec = config.retentionSec ?? 604800;
    /** @type {((type:string, leaseId:string, payload:object)=>void) | null} */
    this.onEvent = null;

    // 收码交付的原子事务（构造一次，复用）。返回 { delivered, quotaExhausted? }
    this._deliverTx = immediateTx(
      this.store.db,
      (leaseId, accessCode, accountId, mail, code, now) => {
        // 权威幂等（INSERT processed_mail）：重复邮件 changes=0 → 丢弃（路径 F）
        const first = this.store.processedMail.markProcessed({
          accountId,
          uid: mail.uid,
          leaseId,
          processedAt: now,
        });
        if (!first) return { delivered: false };
        // ① active→received（非 active：路径 C/G → changes=0 → COMMIT 保留 processed 标记并丢弃）
        const r1 = this.store.lease.markReceived({
          id: leaseId,
          mailUid: mail.uid,
          mailMeta: mail,
          code,
        });
        if (r1 === 0) return { delivered: false };
        // ② 同事务扣配额（路径 B：条件 UPDATE，永不为负）
        const r2 = this.store.accessCode.decrementQuota(accessCode);
        if (r2 !== 1) throw new Error('QUOTA_INCONSISTENT'); // 配额已 0 却交付 → ROLLBACK + 告警
        const left = this.store.accessCode.getByCode(accessCode)?.quotaLeft ?? 0;
        return { delivered: true, quotaExhausted: left === 0 };
      },
    );

    // 把收码交付入口装配到 ReceiverHub（在其 _onMail 的串行执行器上下文内被同步调用）
    this.hub.setDeliverHandler((payload) => this._deliver(payload));
  }

  /** 注入事件处理器（M6 SSE 用）：(type, leaseId, payload) → void。 */
  setEventHandler(fn) {
    this.onEvent = fn;
  }

  _emit(type, leaseId, payload) {
    try {
      this.onEvent?.(type, leaseId, payload);
    } catch (err) {
      logger.warn({ type, leaseId, err: err.message }, '事件回调异常');
    }
  }

  /**
   * 申请租约（activate）。单飞：同码并发共享同一活跃租约。
   * @param {string} accessCode
   * @param {{ renews?: number }} [opts]
   * @returns {Promise<{status:'active', lease:object} | {status:'used', results:object[], retainUntil:number}>}
   */
  async createLease(accessCode, { renews = 0 } = {}) {
    return this.lock.runExclusive(accessCode, async () => {
      // 1. 复用已有活跃租约（路径 A：同码并发只一个 active）
      const existing = await this.exec.submit(() => this.store.lease.getActiveByCode(accessCode));
      if (existing) return { status: 'active', lease: existing };

      // 2. 校验分流（执行器内）；error 分支由 classify 抛 ApiError
      const verdict = await this.exec.submit(() => this.accessService.classify(accessCode));
      if (verdict.kind === 'used') {
        return { status: 'used', results: verdict.results, retainUntil: verdict.retainUntil };
      }
      const plan = verdict.plan;

      // 3. 取账号：原子 acquire，无空闲则入分组 FIFO 队列等待（超时 POOL_BUSY）
      let account = await this.pool.acquire(plan.allowedGroups);
      if (!account) {
        account = await this.queue.wait(
          plan.allowedGroups,
          this.acquireTimeoutMs,
          () => new ApiError(ErrorCode.POOL_BUSY, '账号繁忙，请稍后再试'),
        );
      }

      // 4. setAlias（I/O，执行器外，不阻塞其它账号）
      const provider = this.pool.getProvider(account.id);
      const since = nowSec();
      let setResult;
      try {
        setResult = await provider.setAlias(generateAlias(provider.capabilities().aliasRule));
      } catch (err) {
        await this.exec.submit(() => this._releaseAccountSync(account.id));
        throw err;
      }
      if (!setResult?.ok) {
        await this.exec.submit(() => this._releaseAccountSync(account.id));
        throw new Error('设置别名失败');
      }
      const address = `${setResult.finalAlias}@${provider.domain}`;

      // 5. 建 active 租约 + 置 access_code active（执行器内原子；INV-1/INV-2 DB 护栏兜底）
      const lease = await this.exec.submit(() => {
        const l = {
          id: randomUUID(),
          accessCode,
          plan: plan.prefix,
          accountId: account.id,
          alias: address,
          status: 'active',
          startTime: since,
          expiresAt: since + plan.leaseTtlSec,
          renews,
          createdAt: Date.now(),
        };
        this.store.lease.insert(l);
        this.store.account.updateAlias(account.id, setResult.finalAlias, Date.now());
        this.accessService.markActiveSync(accessCode, l.id);
        return l;
      });

      // 6. 绑定收码 + 登记超时
      this.hub.bindLease(account.id, lease, {
        to: address,
        fromSenders: plan.targetSenders,
        since,
      });
      this.timer.arm(lease.id, plan.leaseTtlSec * 1000, () => this._onTimeout(lease.id));
      this._emit('active', lease.id, { lease });

      return { status: 'active', lease };
    });
  }

  /**
   * 收码交付（ReceiverHub 注入入口；在其 _onMail 的串行执行器上下文内被同步调用）。
   * @param {{ accountId:string, lease:object, mail:object }} payload
   */
  _deliver({ accountId, lease, mail }) {
    const code = this._extractCode(mail, lease);
    let result;
    try {
      result = this._deliverTx(lease.id, lease.accessCode, accountId, mail, code, Date.now());
    } catch (err) {
      // 严重不一致（配额已 0 却交付）：事务已回滚，记审计告警
      this.store.auditLog.insert({
        ts: Date.now(),
        action: 'quota_inconsistent',
        target: lease.accessCode,
        detail: err.message,
      });
      logger.error({ accessCode: lease.accessCode }, '收码交付严重不一致，已回滚告警');
      return;
    }
    if (!result.delivered) return; // 重复 / 非 active → 丢弃（路径 C/F/G）

    // 交付成功的同步副作用（执行器内，不嵌套 submit）
    this.timer.cancel(lease.id);
    this.hub.unbindLease(accountId);
    this._releaseAccountSync(accountId);
    const retainUntil = Date.now() + this._retentionSec(lease.plan) * 1000;
    if (result.quotaExhausted) {
      this.accessService.markUsedSync(lease.accessCode, retainUntil); // 配额尽 → used + 回看期
    } else {
      this.accessService.markBackToUnusedSync(lease.accessCode); // quota>1 余额 → 可继续 activate
    }
    this._emit('received', lease.id, { lease: this.store.lease.getById(lease.id), mail });
  }

  /**
   * 超时释放（FR-3.4/5.1）：到期仍 active → expired → 释放；**配额不扣**，access_code 回 unused 可 renew。
   * @param {string} leaseId
   */
  _onTimeout(leaseId) {
    this.exec.submit(() => {
      const lease = this.store.lease.getById(leaseId);
      if (!lease || lease.status !== 'active') return; // 已终态，无视
      this.store.lease.updateStatus(leaseId, 'expired');
      if (lease.accountId) {
        this.hub.unbindLease(lease.accountId);
        this._releaseAccountSync(lease.accountId);
      }
      this.accessService.markBackToUnusedSync(lease.accessCode);
      this._emit('expired', leaseId, { lease: this.store.lease.getById(leaseId) });
    });
  }

  /**
   * 提前释放（FR-3.6）。
   * @param {string} leaseId
   * @returns {Promise<{status:string}>}
   */
  async cancel(leaseId) {
    return this.exec.submit(() => {
      const lease = this.store.lease.getById(leaseId);
      if (!lease) throw new ApiError(ErrorCode.LEASE_NOT_FOUND, '租约不存在');
      if (lease.status !== 'active' && lease.status !== 'pending') {
        return { status: lease.status }; // 已终态，幂等
      }
      this.store.lease.updateStatus(leaseId, 'cancelled');
      this.timer.cancel(leaseId);
      if (lease.accountId) {
        this.hub.unbindLease(lease.accountId);
        this._releaseAccountSync(lease.accountId);
      }
      this.accessService.markBackToUnusedSync(lease.accessCode);
      this._emit('cancelled', leaseId, { lease: this.store.lease.getById(leaseId) });
      return { status: 'cancelled' };
    });
  }

  /**
   * 重申请（FR-3.5）：当前租约终态且 quota>0、未超 maxRenews → 再 createLease。
   * @param {string} leaseId
   * @returns {Promise<object>} createLease 结果
   */
  async renew(leaseId) {
    const old = await this.exec.submit(() => this.store.lease.getById(leaseId));
    if (!old) throw new ApiError(ErrorCode.LEASE_NOT_FOUND, '租约不存在');
    if (!isLeaseTerminal(old.status)) {
      throw new ApiError(ErrorCode.LEASE_NOT_TERMINAL, '当前租约未结束，不能重申请');
    }
    const code = await this.exec.submit(() => this.store.accessCode.getByCode(old.accessCode));
    if (!code || code.quotaLeft <= 0) throw new ApiError(ErrorCode.CODE_EXHAUSTED, '配额已用尽');
    const plan = this.store.plan.getByPrefix(old.plan);
    if (old.renews >= (plan?.maxRenews ?? 5)) {
      throw new ApiError(ErrorCode.RENEW_LIMIT, '超过最大重申请次数');
    }
    return this.createLease(old.accessCode, { renews: old.renews + 1 });
  }

  /**
   * 查询租约（API 轮询用）。
   * @param {string} leaseId
   * @returns {object|undefined}
   */
  getLease(leaseId) {
    return this.store.lease.getById(leaseId);
  }

  /**
   * 重启恢复（C-6 / §3.5）：进程重启后按 DB 重建在途租约的运行态。
   * **必须在 `hub.start()`（IMAP 常驻连接就绪）之后调用**，否则 bindLease 无连接可订阅。
   *
   * - active 且已过期 → 立即走超时流程（EXPIRED→release）；
   * - active 且未过期 → 重建收码绑定 + 按剩余时间重登记超时定时器；
   * - pending（崩溃残留）→ 置 rejected 并把 access_code 回 unused（首版不恢复排队，FR-3.8）；
   * - 账号占用对账：`leased` 但无对应 active 租约的账号 → 释放（清崩溃残留占用）。
   * @returns {Promise<{recovered:number, expired:number, rejected:number, reconciled:number}>}
   */
  async recoverActiveLeases() {
    const nowS = nowSec();
    let recovered = 0;
    let expired = 0;
    let rejected = 0;

    // 1. active 租约
    for (const lease of this.store.lease.listByStatus('active')) {
      if (!lease.accountId) continue;
      if (nowS >= lease.expiresAt) {
        this._onTimeout(lease.id); // 立即超时（提交执行器）
        expired++;
        continue;
      }
      const plan = this.store.plan.getByPrefix(lease.plan);
      try {
        this.hub.bindLease(lease.accountId, lease, {
          to: lease.alias,
          fromSenders: plan?.targetSenders ?? [],
          since: lease.startTime,
        });
        this.timer.arm(lease.id, (lease.expiresAt - nowS) * 1000, () => this._onTimeout(lease.id));
        recovered++;
      } catch (err) {
        logger.warn({ leaseId: lease.id, err: err.message }, '恢复 active 租约绑定失败');
      }
    }

    // 2. pending 残留 → rejected（不恢复排队）
    for (const lease of this.store.lease.listByStatus('pending')) {
      await this.exec.submit(() => {
        this.store.lease.updateStatus(lease.id, 'rejected');
        if (lease.accessCode) this.accessService.markBackToUnusedSync(lease.accessCode);
      });
      rejected++;
    }

    // 3. 账号占用对账：leased 但无 active 租约 → 释放（在上述超时处理排空后执行）
    const reconciled = await this.exec.submit(() => {
      const activeAccountIds = new Set(
        this.store.lease
          .listByStatus('active')
          .map((l) => l.accountId)
          .filter(Boolean),
      );
      let n = 0;
      for (const acc of this.store.account.listEnabled()) {
        if (acc.status === 'leased' && !activeAccountIds.has(acc.id)) {
          this.pool.releaseSync(acc.id);
          n++;
        }
      }
      return n;
    });

    logger.info({ recovered, expired, rejected, reconciled }, '重启恢复完成');
    return { recovered, expired, rejected, reconciled };
  }

  /**
   * 释放账号（同步）：若有等待者要该分组则**直接转交**（不经 free/冷却），否则置 free。
   * @param {string} accountId
   */
  _releaseAccountSync(accountId) {
    const account = this.store.account.getById(accountId);
    if (!account) return;
    const waiter = this.queue.takeFor(account.groupName);
    if (waiter) {
      this.store.account.updateStatus(accountId, 'leased', Date.now()); // 直接转交给等待者
      waiter.resolve(account);
    } else {
      this.pool.releaseSync(accountId);
    }
  }

  /** 套餐回看保留秒数（plan 覆盖默认）。 */
  _retentionSec(prefix) {
    return this.store.plan.getByPrefix(prefix)?.retentionSec ?? this.defaultRetentionSec;
  }

  /**
   * 便利码尽力提取（不影响成功判定，FR-4.3）。
   * @param {object} mail
   * @param {object} lease
   * @returns {string|null}
   */
  _extractCode(mail, lease) {
    try {
      const plan = this.store.plan.getByPrefix(lease.plan);
      const re = plan?.codeRegex ? new RegExp(plan.codeRegex) : /\b(\d{4,8})\b/;
      const m = (mail.text || '').match(re);
      return m ? (m[1] ?? m[0]) : null;
    } catch {
      return null;
    }
  }
}

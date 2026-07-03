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
   * @param {{ queueTimeoutSec?: number, retentionSec?: number }} [opts.config]
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
    this.queueTimeoutMs = (config.queueTimeoutSec ?? 1800) * 1000;
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
   * 申请租约（activate）。单飞：同码并发共享同一 active 或 pending 租约（INV-1′）。
   * 有空闲账号 → 直接 active；池满 → 建 pending 租约入队，立即返回供前端显示排队位次与已等待时长。
   * @param {string} accessCode
   * @param {{ renews?: number }} [opts]
   * @returns {Promise<{status:'active', lease:object} | {status:'pending', lease:object} | {status:'used', results:object[], retainUntil:number}>}
   */
  async createLease(accessCode, { renews = 0, alias = null } = {}) {
    return this.lock.runExclusive(accessCode, async () => {
      // 1. 复用已有活跃租约（路径 A：同码并发只一个 active）
      const existing = await this.exec.submit(() => this.store.lease.getActiveByCode(accessCode));
      if (existing) return { status: 'active', lease: existing };

      // 1.5 复用已有 pending 租约（排队中同码再 activate / 刷新 → 复用，不新开；INV-1′）
      const pending = await this.exec.submit(() => this.store.lease.getPendingByCode(accessCode));
      if (pending) return { status: 'pending', lease: pending };

      // 2. 校验分流（执行器内）；error 分支由 classify 抛 ApiError
      const verdict = await this.exec.submit(() => this.accessService.classify(accessCode));
      if (verdict.kind === 'used') {
        return { status: 'used', results: verdict.results, retainUntil: verdict.retainUntil };
      }
      const plan = verdict.plan;

      // 3. 取账号：原子 acquire。有空闲 → 直接激活
      const account = await this.pool.acquire(plan.allowedGroups);
      if (account) {
        const lease = await this._activateWithAccount({
          accessCode,
          plan,
          account,
          renews,
          requestedAlias: alias,
        });
        return { status: 'active', lease };
      }

      // 3′. 无空闲 → 建 pending 租约入队（异步排队，立即返回；账号释放时由 _promotePending 推进为 active）
      const lease = await this.exec.submit(() => {
        const l = {
          id: randomUUID(),
          accessCode,
          plan: plan.prefix,
          accountId: null,
          alias: null,
          status: 'pending',
          startTime: null,
          expiresAt: null,
          renews,
          createdAt: Date.now(), // 入队时刻 = 前端「已排队时长」起点
        };
        this.store.lease.insert(l);
        this.accessService.markActiveSync(accessCode, l.id); // 占位：unused→active + 绑定 pending 租约
        return l;
      });
      this.queue.enqueue({
        leaseId: lease.id,
        accessCode,
        groups: plan.allowedGroups,
        enqueuedAt: lease.createdAt,
        requestedAlias: alias,
      });
      // 兜底：超 queueTimeout 仍未轮到 → rejected（产品不设硬超时，此为防泄漏）
      this.timer.arm(lease.id, this.queueTimeoutMs, () => this._onQueueTimeout(lease.id));
      this._emit('pending', lease.id, { lease });
      return { status: 'pending', lease };
    });
  }

  /**
   * 用已取得的账号完成激活：setAlias（执行器外）→ 建/提升 active 租约（执行器内原子）→ 按需连收码 →
   * 登记超时 + 推送。两入口共用：createLease 直接取到账号（insert 新 active）、_promotePending 队列推进
   * （pendingLeaseId → pending→active 条件提升）。慢 I/O 全在执行器外；失败按既有策略原子回滚并抛出。
   * @param {{ accessCode:string, plan:object, account:object, renews?:number, pendingLeaseId?:string|null }} args
   * @returns {Promise<object>} active 租约
   */
  async _activateWithAccount({
    accessCode,
    plan,
    account,
    renews = 0,
    pendingLeaseId = null,
    requestedAlias = null,
  }) {
    const provider = this.pool.getProvider(account.id);
    const since = nowSec();

    // 1. setAlias（I/O，执行器外，不阻塞其它账号）。自用指定别名 → 精确设置（冲突报 ALIAS_TAKEN，不加后缀）；
    //    否则按顺序游标生成拟真姓名式别名。
    let setResult;
    try {
      if (requestedAlias) {
        setResult = await provider.setAlias(requestedAlias, { exact: true });
      } else {
        // 顺序游标由 store 原子推进（同步单连接，无 TOCTOU）；据此生成拟真姓名式别名
        const cursor = this.store.aliasIndex.advance();
        setResult = await provider.setAlias(
          generateAlias(provider.capabilities().aliasRule, cursor),
        );
      }
    } catch (err) {
      await this.exec.submit(() => this._abortActivation(account.id, pendingLeaseId, accessCode));
      throw err;
    }
    if (setResult?.conflict) {
      // 指定别名已被占用：回滚本次申请并报 ALIAS_TAKEN（自用 exact 模式）
      await this.exec.submit(() => this._abortActivation(account.id, pendingLeaseId, accessCode));
      throw new ApiError(ErrorCode.ALIAS_TAKEN, '指定的别名已被占用，请换一个');
    }
    if (!setResult?.ok) {
      await this.exec.submit(() => this._abortActivation(account.id, pendingLeaseId, accessCode));
      throw new Error('设置别名失败');
    }
    const address = `${setResult.finalAlias}@${provider.domain}`;

    // 2. 建 active 租约 / pending→active 条件提升（执行器内原子；INV-1/INV-2 DB 护栏兜底）
    const lease = await this.exec.submit(() => {
      const expiresAt = since + plan.leaseTtlSec;
      let l;
      if (pendingLeaseId) {
        // 条件提升：WHERE status='pending'；changes=0 → 已被 cancel/超时置终态 → 放弃激活
        const changed = this.store.lease.promoteToActive({
          id: pendingLeaseId,
          accountId: account.id,
          alias: address,
          startTime: since,
          expiresAt,
        });
        if (changed === 0) throw new ApiError(ErrorCode.LEASE_NOT_FOUND, 'pending 租约已失效');
        l = this.store.lease.getById(pendingLeaseId);
      } else {
        l = {
          id: randomUUID(),
          accessCode,
          plan: plan.prefix,
          accountId: account.id,
          alias: address,
          status: 'active',
          startTime: since,
          expiresAt,
          renews,
          createdAt: Date.now(),
        };
        this.store.lease.insert(l);
      }
      this.store.account.updateAlias(account.id, setResult.finalAlias, Date.now());
      this.accessService.markActiveSync(accessCode, l.id);
      return l;
    });

    // 3. 登记超时 + 推送。**不在此连 IMAP**：收码连接延后到用户点「我已发送邮件」（confirmReceiving）。
    //    超时从 setAlias 起算（leaseTtlSec）：无论用户是否确认，到期即释放，避免占着账号空等。
    this.timer.arm(lease.id, plan.leaseTtlSec * 1000, () => this._onTimeout(lease.id));
    this._emit('active', lease.id, { lease });
    return lease;
  }

  /**
   * 激活前段（setAlias）失败的回滚（执行器内同步）：释放账号；若来自队列推进（pendingLeaseId），
   * 把 pending 租约转 rejected 并把唯一码退回 unused。
   * @param {string} accountId
   * @param {string|null} pendingLeaseId
   * @param {string} accessCode
   */
  _abortActivation(accountId, pendingLeaseId, accessCode) {
    this._releaseAccountSync(accountId);
    if (!pendingLeaseId) return; // createLease 直接激活：access_code 未变，仅释放账号
    const l = this.store.lease.getById(pendingLeaseId);
    if (l && l.status === 'pending') {
      this.store.lease.updateStatus(pendingLeaseId, 'rejected');
      this.timer.cancel(pendingLeaseId);
      this.accessService.markBackToUnusedSync(accessCode);
      this._emit('rejected', pendingLeaseId, { lease: this.store.lease.getById(pendingLeaseId) });
    }
  }

  /**
   * 队列推进（执行器外，异步 fire-and-forget）：把一个排队中的 pending 租约用预占账号激活。
   * 走单飞锁与 createLease/cancel 对同码串行；租约已非 pending（被 cancel/超时）→ 归还账号推进下一个。
   * @param {{ leaseId:string, accessCode:string }} entry
   * @param {string} accountId 已预占（leased）的账号
   */
  async _promotePending(entry, accountId) {
    const { leaseId, accessCode, requestedAlias } = entry;
    try {
      await this.lock.runExclusive(accessCode, async () => {
        const lease = await this.exec.submit(() => this.store.lease.getById(leaseId));
        if (!lease || lease.status !== 'pending') {
          // 已被 cancel/超时：归还预占账号（会 takeFor 下一个 pending，链式推进）
          await this.exec.submit(() => this._releaseAccountSync(accountId));
          return;
        }
        const account = await this.exec.submit(() => this.store.account.getById(accountId));
        const plan = this.store.plan.getByPrefix(lease.plan);
        await this._activateWithAccount({
          accessCode,
          plan,
          account,
          pendingLeaseId: leaseId,
          requestedAlias,
        });
      });
    } catch (err) {
      // _activateWithAccount 内部已对 setAlias/bind 失败原子回滚（释放账号、pending→终态、码退 unused）；
      // 此处兜底记录，避免未捕获的 promise 异常。
      logger.warn({ leaseId, accessCode, err: err.message }, '队列推进 promote 失败');
    }
  }

  /**
   * 排队兜底超时（防泄漏；产品上不设硬超时）：pending 仍未轮到 → rejected + 出队 + 码退 unused。
   * @param {string} leaseId
   */
  _onQueueTimeout(leaseId) {
    const snap = this.store.lease.getById(leaseId);
    if (!snap) return;
    this.lock.runExclusive(snap.accessCode, () =>
      this.exec.submit(() => {
        const l = this.store.lease.getById(leaseId);
        if (!l || l.status !== 'pending') return; // 已推进 / 已取消
        this.store.lease.updateStatus(leaseId, 'rejected');
        this.queue.remove(leaseId);
        this.accessService.markBackToUnusedSync(l.accessCode);
        this._emit('rejected', leaseId, { lease: this.store.lease.getById(leaseId) });
      }),
    );
  }

  /**
   * 某排队租约「前面还有几人」（供 API 展示）：= **被占用（leased）的可用分组账号数**
   * + **队列中排在它前面（分组有交集）的等待者数**。用账号占用态而非 active 租约数，
   * 使 promote 中间态（账号已预占、租约尚未转 active）也稳定计入，不会短暂跳 0。
   * @param {string} leaseId
   * @returns {number}
   */
  queuePosition(leaseId) {
    const lease = this.store.lease.getById(leaseId);
    if (!lease || lease.status !== 'pending') return 0;
    const plan = this.store.plan.getByPrefix(lease.plan);
    const groups = new Set(plan?.allowedGroups ?? []);
    // 被占用（leased）的可用分组账号数：含正在用的、以及刚释放后预占给前面排队者的（promote 中间态）
    const busyAccounts = this.store.account
      .list()
      .filter((a) => a.status === 'leased' && groups.has(a.groupName)).length;
    // 加上队列中排在你前面的等待者
    return busyAccounts + this.queue.positionOf(leaseId);
  }

  /**
   * 用户确认「我已发送邮件」→ 按需连 IMAP 并绑定收码（延后连接，避免一设别名就空连）。
   * 幂等：已在收码（receiving=1）直接返回；仅 active 且 receiving=0 才连。走单飞锁与同码其它操作串行。
   * 连接失败按既有策略回滚本次申请（释放账号、租约终态、码退 unused）。
   * @param {string} leaseId
   * @returns {Promise<{status:string, lease:object|null}>}
   */
  async confirmReceiving(leaseId) {
    const snap = await this.exec.submit(() => this.store.lease.getById(leaseId));
    if (!snap) throw new ApiError(ErrorCode.LEASE_NOT_FOUND, '租约不存在');
    return this.lock.runExclusive(snap.accessCode, async () => {
      const cur = await this.exec.submit(() => this.store.lease.getById(leaseId));
      if (!cur) throw new ApiError(ErrorCode.LEASE_NOT_FOUND, '租约不存在');
      if (cur.status !== 'active') return { status: cur.status, lease: cur }; // 已终态，前端按状态收尾
      if (cur.receiving) return { status: 'active', lease: cur }; // 幂等：已在收码

      const plan = this.store.plan.getByPrefix(cur.plan);
      try {
        await this.hub.bindLease(cur.accountId, cur, {
          to: cur.alias,
          fromSenders: plan?.targetSenders ?? [],
          since: cur.startTime, // 收码窗口仍从 setAlias 时刻起，能扫到用户确认前已到达的邮件
        });
      } catch (err) {
        await this.exec.submit(() => {
          this.store.lease.updateStatus(cur.id, 'cancelled');
          this.hub.unbindLease(cur.accountId);
          this._releaseAccountSync(cur.accountId);
          this.accessService.markBackToUnusedSync(cur.accessCode);
          this.timer.cancel(cur.id);
        });
        logger.warn(
          { leaseId, err: err.message },
          '确认收码：按需建 IMAP 连接失败，已回滚本次申请',
        );
        throw new ApiError(ErrorCode.RECEIVER_UNAVAILABLE, '收码通道暂不可用，请稍后重试');
      }

      const updated = await this.exec.submit(() => {
        this.store.lease.markReceiving(cur.id);
        return this.store.lease.getById(cur.id);
      });
      this._emit('active', cur.id, { lease: updated }); // 推送 receiving=true，前端切到「监听中」
      return { status: 'active', lease: updated };
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
   * 提前释放（FR-3.6）。走单飞锁与同码 activate/_promotePending 串行，避免取消与队列推进交错。
   * @param {string} leaseId
   * @returns {Promise<{status:string}>}
   */
  async cancel(leaseId) {
    const snap = await this.exec.submit(() => this.store.lease.getById(leaseId));
    if (!snap) throw new ApiError(ErrorCode.LEASE_NOT_FOUND, '租约不存在');
    return this.lock.runExclusive(snap.accessCode, () =>
      this.exec.submit(() => {
        const lease = this.store.lease.getById(leaseId);
        if (!lease) throw new ApiError(ErrorCode.LEASE_NOT_FOUND, '租约不存在');
        if (lease.status !== 'active' && lease.status !== 'pending') {
          return { status: lease.status }; // 已终态，幂等
        }
        this.store.lease.updateStatus(leaseId, 'cancelled');
        this.timer.cancel(leaseId);
        this.queue.remove(leaseId); // pending 出队（active 不在队列，remove 无害）
        if (lease.accountId) {
          this.hub.unbindLease(lease.accountId);
          this._releaseAccountSync(lease.accountId);
        }
        this.accessService.markBackToUnusedSync(lease.accessCode);
        this._emit('cancelled', leaseId, { lease: this.store.lease.getById(leaseId) });
        return { status: 'cancelled' };
      }),
    );
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
   * **按需连模式**：对 active 未过期租约**即时重连 IMAP** 并重绑收码（不再依赖 hub.start() 预连）。
   *
   * - active 且已过期 → 立即走超时流程（EXPIRED→release）；
   * - active 且未过期 → 重连 IMAP + 重建收码绑定 + 按剩余时间重登记超时定时器；**连接失败 → 转超时释放**；
   * - pending（崩溃残留）→ 置 rejected 并把 access_code 回 unused（首版不恢复排队，FR-3.8）；
   * - 账号占用对账：`leased` 但无对应 active 租约的账号 → 释放（清崩溃残留占用）。
   * @returns {Promise<{recovered:number, expired:number, rejected:number, reconciled:number}>}
   */
  async recoverActiveLeases() {
    const nowS = nowSec();
    let recovered = 0;
    let expired = 0;
    let rejected = 0;

    // 1. active 租约：按需重连 IMAP + 重绑收码（仅收码中的 receiving=1；待确认的只续超时不连）
    for (const lease of this.store.lease.listByStatus('active')) {
      if (!lease.accountId) continue;
      if (nowS >= lease.expiresAt) {
        this._onTimeout(lease.id); // 立即超时（提交执行器）
        expired++;
        continue;
      }
      // 待确认（receiving=0）：别名已设、账号已占，但用户未确认，重启后不连 IMAP，只续超时
      if (!lease.receiving) {
        this.timer.arm(lease.id, (lease.expiresAt - nowS) * 1000, () => this._onTimeout(lease.id));
        recovered++;
        continue;
      }
      const plan = this.store.plan.getByPrefix(lease.plan);
      try {
        await this.hub.bindLease(lease.accountId, lease, {
          to: lease.alias,
          fromSenders: plan?.targetSenders ?? [],
          since: lease.startTime,
        });
        this.timer.arm(lease.id, (lease.expiresAt - nowS) * 1000, () => this._onTimeout(lease.id));
        recovered++;
      } catch (err) {
        // 连接失败：该租约转超时释放，不阻塞整体恢复
        logger.warn(
          { leaseId: lease.id, err: err.message },
          '恢复 active 租约：IMAP 重连失败，转超时释放',
        );
        this._onTimeout(lease.id);
        expired++;
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
   * 释放账号（同步，执行器内）：若有排队者要该分组则**预占并异步 promote**（不经 free），否则置 free。
   * @param {string} accountId
   */
  _releaseAccountSync(accountId) {
    const account = this.store.account.getById(accountId);
    if (!account) return;
    const entry = this.queue.takeFor(account.groupName);
    if (entry) {
      // 有排队者：账号预占（leased），异步 promote（setAlias+bind 在执行器外，不阻塞本执行器）
      this.store.account.updateStatus(accountId, 'leased', Date.now());
      this._promotePending(entry, accountId); // fire-and-forget（内部自带单飞锁与回滚）
      // 取走一个 → 其余 pending 位次前移，逐个推送刷新前端 queueAhead
      for (const p of this.queue.listPending()) this._emit('pending', p.leaseId, {});
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

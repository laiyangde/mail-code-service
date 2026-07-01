/**
 * QueuePort 内存实现（FR-3.7/3.8 异步排队）：账号池满时 `createLease` 建 **pending 租约**并把它
 * 登记入队；有账号释放时按分组 FIFO 取出队首 pending 租约、异步 promote 为 active。
 *
 * 与首版「阻塞等待 Promise」不同：本队列只存放**已落库 pending 租约**的引用
 * （leaseId/accessCode/分组/入队时刻），不再持有 resolve/reject。`positionOf` 供前端显示
 * 「前面还有几人」；不同分组互不阻塞（FR-3.7）。多进程时换 Redis 队列，不改业务（§10.5）。
 */
export class MemoryWaitQueue {
  /** @type {Array<{ leaseId:string, accessCode:string, groups:Set<string>, enqueuedAt:number }>} 入队顺序即 FIFO */
  #entries = [];

  /**
   * 入队一个 pending 租约（createLease 池满时调用）。
   * @param {{ leaseId:string, accessCode:string, groups:string[], enqueuedAt:number }} entry
   */
  enqueue({ leaseId, accessCode, groups, enqueuedAt }) {
    this.#entries.push({ leaseId, accessCode, groups: new Set(groups), enqueuedAt });
  }

  /**
   * 取出第一个可用该分组的队首条目（FIFO）并移除（账号释放时调用）。
   * @param {string} groupName 刚释放账号的分组
   * @returns {{ leaseId:string, accessCode:string, groups:Set<string>, enqueuedAt:number } | null}
   */
  takeFor(groupName) {
    const idx = this.#entries.findIndex((e) => e.groups.has(groupName));
    if (idx < 0) return null;
    const [entry] = this.#entries.splice(idx, 1);
    return entry;
  }

  /**
   * 某租约前面有多少个「分组有交集」的等待者（= queueAhead）。
   * 不同分组互不阻塞（FR-3.7），故只计前面与本条目分组有交集者。
   * @param {string} leaseId
   * @returns {number} 前面的人数；不在队列返回 0
   */
  positionOf(leaseId) {
    const idx = this.#entries.findIndex((e) => e.leaseId === leaseId);
    if (idx < 0) return 0;
    const mine = this.#entries[idx].groups;
    let ahead = 0;
    for (let i = 0; i < idx; i++) {
      if (hasIntersection(this.#entries[i].groups, mine)) ahead++;
    }
    return ahead;
  }

  /**
   * 移除某租约的排队登记（cancel / 超时兜底时调用）。
   * @param {string} leaseId
   * @returns {boolean} 是否移除了
   */
  remove(leaseId) {
    const idx = this.#entries.findIndex((e) => e.leaseId === leaseId);
    if (idx < 0) return false;
    this.#entries.splice(idx, 1);
    return true;
  }

  /** 当前队列快照（供释放后给剩余 pending 刷新位次推送）。 */
  listPending() {
    return this.#entries.map((e) => ({ leaseId: e.leaseId, accessCode: e.accessCode }));
  }

  /** 当前排队人数（监控用）。 */
  get size() {
    return this.#entries.length;
  }
}

/**
 * 两个分组集合是否有交集。
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {boolean}
 */
function hasIntersection(a, b) {
  for (const g of a) if (b.has(g)) return true;
  return false;
}

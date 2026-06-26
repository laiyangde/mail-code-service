/**
 * QueuePort 内存实现（FR-3.7/3.8 首版极简排队）：池满时 createLease 入队等待，
 * 有账号释放时按分组 FIFO 取出等待者并下发账号；超 acquireTimeout 未轮到则 POOL_BUSY。
 *
 * 首版**不做位次 / ETA**（列为 v2）。多进程时换 Redis 队列，不改业务（§10.5）。
 */
export class MemoryWaitQueue {
  /** @type {Array<{ groups: Set<string>, resolve: (acc:object)=>void, reject:(e:Error)=>void, timer: any }>} */
  #waiters = [];

  /**
   * 入队等待一个可用账号；超时调用 onTimeout() 产生错误并 reject。
   * @param {string[]} allowedGroups 可接受的分组
   * @param {number} timeoutMs 等待上限
   * @param {() => Error} onTimeout 超时错误工厂
   * @returns {Promise<object>} 轮到时 resolve 账号
   */
  wait(allowedGroups, timeoutMs, onTimeout) {
    return new Promise((resolve, reject) => {
      const waiter = { groups: new Set(allowedGroups), resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.#remove(waiter);
        reject(onTimeout());
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  /**
   * 取出第一个接受该分组的等待者（FIFO），并清其超时定时器。
   * @param {string} groupName 刚释放账号的分组
   * @returns {{ resolve:(acc:object)=>void } | null}
   */
  takeFor(groupName) {
    const idx = this.#waiters.findIndex((w) => w.groups.has(groupName));
    if (idx < 0) return null;
    const [waiter] = this.#waiters.splice(idx, 1);
    clearTimeout(waiter.timer);
    return waiter;
  }

  #remove(waiter) {
    const i = this.#waiters.indexOf(waiter);
    if (i >= 0) this.#waiters.splice(i, 1);
  }

  /** 当前排队人数（监控用）。 */
  get size() {
    return this.#waiters.length;
  }
}

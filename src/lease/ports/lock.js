/**
 * LockPort 内存实现（FR-0 M4 单飞）：按 key 的互斥锁，同 key 串行、不同 key 并行。
 *
 * 用途：同一 accessCode 的并发 activate 串行化——第二个进入临界区时，第一个已建好活跃租约，
 * 于是复用而非新开（配合 INV-1 DB 唯一索引双保险，杜绝「一码多租约」）。
 *
 * 首版进程内实现；多进程 / 多实例时换 Redis 分布式锁，**不改业务逻辑**（§10.5）。
 */
export class MemoryLock {
  /** @type {Map<string, Promise<unknown>>} key → 链尾 promise（前驱完成后才轮到下一个） */
  #tail = new Map();

  /**
   * 在 key 的互斥临界区内执行 fn。
   * @template R
   * @param {string} key
   * @param {() => R | Promise<R>} fn
   * @returns {Promise<R>}
   */
  async runExclusive(key, fn) {
    const prev = this.#tail.get(key) ?? Promise.resolve();
    let resolveDone;
    const done = new Promise((r) => {
      resolveDone = r;
    });
    // 同步排到链尾，保证 FIFO；entry 完成 = 等前驱完成后再等本次 done
    const entry = prev.then(() => done);
    this.#tail.set(key, entry);

    await prev; // 等前驱释放
    try {
      return await fn();
    } finally {
      resolveDone(); // 唤醒后继
      // 若本次是最后一个（无后继入队），清理 Map 避免泄漏
      if (this.#tail.get(key) === entry) this.#tail.delete(key);
    }
  }
}

/**
 * 租约超时定时器登记 / 取消（进程内内存态；重启由 M8 恢复巡检按 expires_at 重建）。
 */
export class LeaseTimer {
  /** @type {Map<string, ReturnType<typeof setTimeout>>} leaseId → handle */
  #timers = new Map();

  /**
   * 为租约登记一个超时回调（重复 arm 同一 leaseId 会覆盖旧的）。
   * @param {string} leaseId
   * @param {number} delayMs 距超时的毫秒数
   * @param {() => void} onTimeout 到点回调
   */
  arm(leaseId, delayMs, onTimeout) {
    this.cancel(leaseId);
    const handle = setTimeout(() => {
      this.#timers.delete(leaseId);
      onTimeout();
    }, delayMs);
    this.#timers.set(leaseId, handle);
  }

  /**
   * 取消某租约的超时定时器（收码成功 / 取消时调用）。
   * @param {string} leaseId
   */
  cancel(leaseId) {
    const handle = this.#timers.get(leaseId);
    if (handle) {
      clearTimeout(handle);
      this.#timers.delete(leaseId);
    }
  }

  /** 清空所有定时器（优雅停机）。 */
  clear() {
    for (const handle of this.#timers.values()) clearTimeout(handle);
    this.#timers.clear();
  }
}

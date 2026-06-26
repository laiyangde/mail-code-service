/**
 * 单写串行执行器（FR-0 M1）：把所有「读—判断—写」状态变更收敛为一条串行队列，
 * 单进程内天生串行，消除 TOCTOU（INV-6）。低并发场景零性能损失，却根除竞态。
 *
 * 语义保证：
 * - submit(fn) 返回的 Promise 如实反映 fn 的结果（resolve / reject）；
 * - 任一任务失败**不阻断**后续任务（队列继续推进）；
 * - 任务严格按提交顺序执行，前一个 settle 之后才启动下一个，任意时刻至多一个在跑。
 */
export class SerialExecutor {
  /** @type {Promise<unknown>} 队尾哨兵：下一个任务在它 settle 后才启动 */
  #tail = Promise.resolve();

  /**
   * 提交一个任务到串行队列。
   * @template R
   * @param {() => R | Promise<R>} fn 任务体（同步或异步均可）
   * @returns {Promise<R>} fn 的执行结果
   */
  submit(fn) {
    const result = this.#tail.then(() => fn());
    // 队尾吞掉成功/失败信号，保证一个任务失败不影响后续调度；
    // 调用方拿到的 result 仍保留真实的 resolve/reject。
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

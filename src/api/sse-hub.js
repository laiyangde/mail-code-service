/**
 * SSE 事件桥（M6 / FR-6.3/6.7/6.8、§3.6）：把 LeaseManager 的进程内事件
 * （active/received/expired/cancelled）路由到订阅了对应租约的 SSE 连接。
 *
 * 两个映射：
 * - `byLease`：leaseId → 一组订阅者（推事件用）；
 * - `byCode`：accessCode → 当前唯一订阅者（**单活跃订阅**：同码新连接建立即关旧，FR-6.8 首版极简）。
 *
 * 每个订阅者是一个 **async 事件队列**，直接作为 `reply.sse(asyncIterable)` 的数据源——
 * 事件到达即推进迭代器；`close()` 让迭代自然结束、连接收尾。
 *
 * 正确性（防一码多码）不依赖本层，由 FR-0 的 DB 护栏与单活跃租约保证；本层仅负责实时回显。
 */

/**
 * 单个 SSE 订阅者：一个可被外部 push 的 async 可迭代队列。
 */
class SseSubscriber {
  /**
   * @param {string} leaseId
   * @param {string|null} accessCode
   */
  constructor(leaseId, accessCode) {
    this.leaseId = leaseId;
    this.accessCode = accessCode;
    /** @type {object[]} 未被消费的事件缓冲 */
    this._buffer = [];
    /** @type {((r:{value:any,done:boolean})=>void)|null} 迭代器等待中的 resolve */
    this._resolveNext = null;
    this._closed = false;
  }

  /**
   * 投递一个事件（已关闭则忽略）。
   * @param {object} event
   */
  push(event) {
    if (this._closed) return;
    if (this._resolveNext) {
      const resolve = this._resolveNext;
      this._resolveNext = null;
      resolve({ value: event, done: false });
    } else {
      this._buffer.push(event);
    }
  }

  /** 关闭队列：迭代器随即结束（done），SSE 连接收尾。 */
  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._resolveNext) {
      const resolve = this._resolveNext;
      this._resolveNext = null;
      resolve({ value: undefined, done: true });
    }
  }

  /** async 迭代协议：缓冲有则立即出队，否则挂起等待 push/close。 */
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this._buffer.length) {
          return Promise.resolve({ value: this._buffer.shift(), done: false });
        }
        if (this._closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this._resolveNext = resolve;
        });
      },
      // 客户端断开 / generator 提前结束时被调用 → 关闭本订阅者
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export class SseHub {
  constructor() {
    /** @type {Map<string, Set<SseSubscriber>>} leaseId → 订阅者集合 */
    this.byLease = new Map();
    /** @type {Map<string, SseSubscriber>} accessCode → 当前唯一订阅者（单活跃） */
    this.byCode = new Map();
  }

  /**
   * 发布一个租约事件给其全部订阅者（接 `manager.setEventHandler`）。
   * @param {string} type active|received|expired|cancelled
   * @param {string} leaseId
   * @param {object} payload 事件载荷（含 lease，可能含 mail）
   */
  publish(type, leaseId, payload) {
    const subs = this.byLease.get(leaseId);
    if (!subs) return;
    const event = { type, leaseId, payload };
    for (const sub of subs) sub.push(event);
  }

  /**
   * 订阅某租约的事件流。同 `accessCode` 已有订阅者则**先关旧再建新**（单活跃）。
   * @param {string} leaseId
   * @param {string|null} [accessCode] 唯一码（公开入口有；自用内部码可传或不传）
   * @returns {SseSubscriber} 作为 reply.sse 的 asyncIterable 数据源
   */
  subscribe(leaseId, accessCode = null) {
    const sub = new SseSubscriber(leaseId, accessCode);
    if (accessCode) {
      const old = this.byCode.get(accessCode);
      if (old) this.unsubscribe(old); // 关旧连接，避免重复推送
      this.byCode.set(accessCode, sub);
    }
    let set = this.byLease.get(leaseId);
    if (!set) {
      set = new Set();
      this.byLease.set(leaseId, set);
    }
    set.add(sub);
    return sub;
  }

  /**
   * 注销一个订阅者并关闭其队列（路由 finally 调用，覆盖终态结束与客户端断开两种路径）。
   * @param {SseSubscriber} sub
   */
  unsubscribe(sub) {
    const set = this.byLease.get(sub.leaseId);
    if (set) {
      set.delete(sub);
      if (!set.size) this.byLease.delete(sub.leaseId);
    }
    if (sub.accessCode && this.byCode.get(sub.accessCode) === sub) {
      this.byCode.delete(sub.accessCode);
    }
    sub.close();
  }

  /** 当前活跃连接数（监控用）。 */
  get size() {
    let n = 0;
    for (const set of this.byLease.values()) n += set.size;
    return n;
  }
}

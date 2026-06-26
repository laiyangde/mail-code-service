/**
 * 租约事件流 hook（M7 / FR-6.3、6.7）：用 EventSource 订阅 `/leases/:id/stream`，
 * 把 `message`（状态更新）与 `done`（终态，附整封邮件）回调给视图。
 *
 * 收尾（FR-6.7）：收到 `done` 主动关闭、不再重连。SSE 不可用或连接中断时
 * **降级为轮询** `getLease`（3s），直至租约进入终态，保证弱网/无 SSE 环境也能拿到结果。
 */
import { useEffect, useRef } from 'react';
import { getLease, streamUrl } from '../api.js';

/** 租约终态集合（与后端状态机一致） */
const TERMINAL = new Set(['received', 'expired', 'cancelled', 'rejected']);

/**
 * @param {string|null} leaseId 租约 id；falsy 则不订阅
 * @param {object} opts
 * @param {(lease:object)=>void} opts.onUpdate 每次状态更新
 * @param {(lease:object)=>void} opts.onDone 终态（收到 done 或轮询到终态）
 * @param {boolean} [opts.enabled=true] 是否启用订阅
 */
export function useLeaseStream(leaseId, { onUpdate, onDone, enabled = true }) {
  const onUpdateRef = useRef(onUpdate);
  const onDoneRef = useRef(onDone);
  onUpdateRef.current = onUpdate;
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!enabled || !leaseId) return undefined;

    let closed = false;
    let es = null;
    let pollTimer = null;

    const cleanup = () => {
      if (es) {
        es.close();
        es = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const finish = (lease) => {
      if (closed) return;
      closed = true;
      cleanup();
      onDoneRef.current?.(lease);
    };

    // 降级轮询兜底（SSE 不可用或中断时）
    const startPolling = () => {
      if (closed || pollTimer) return;
      pollTimer = setInterval(async () => {
        try {
          const lease = await getLease(leaseId);
          if (closed) return;
          onUpdateRef.current?.(lease);
          if (TERMINAL.has(lease.status)) finish(lease);
        } catch (err) {
          // 租约不存在等 → 停止轮询（上层已处理过初始态）
          if (err?.status === 404) {
            closed = true;
            cleanup();
          }
        }
      }, 3000);
    };

    const connect = () => {
      if (typeof EventSource === 'undefined') {
        startPolling();
        return;
      }
      es = new EventSource(streamUrl(leaseId));
      es.addEventListener('message', (e) => {
        try {
          onUpdateRef.current?.(JSON.parse(e.data));
        } catch {
          /* 忽略坏帧 */
        }
      });
      es.addEventListener('done', (e) => {
        try {
          finish(JSON.parse(e.data));
        } catch {
          closed = true;
          cleanup();
        }
      });
      es.onerror = () => {
        // done 后服务端 end() 也会触发，此时已 closed → 忽略；
        // 否则视为网络中断/终态重连(204)，关闭 SSE 转轮询兜底
        if (closed) return;
        if (es) {
          es.close();
          es = null;
        }
        startPolling();
      };
    };

    connect();
    return () => {
      closed = true;
      cleanup();
    };
  }, [leaseId, enabled]);
}

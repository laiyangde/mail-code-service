import { describe, it, expect } from 'vitest';
import { SseHub } from '../../src/api/sse-hub.js';

/** 取订阅者下一个事件（已关闭则 done） */
const next = (sub) => sub[Symbol.asyncIterator]().next();

describe('SseHub 事件桥', () => {
  it('publish 把事件投递给该 leaseId 的订阅者', async () => {
    const hub = new SseHub();
    const sub = hub.subscribe('l1', 'c1');
    hub.publish('active', 'l1', { x: 1 });
    const r = await next(sub);
    expect(r.done).toBe(false);
    expect(r.value).toMatchObject({ type: 'active', leaseId: 'l1' });
    hub.unsubscribe(sub);
  });

  it('单活跃：同 accessCode 新订阅建立即关旧', async () => {
    const hub = new SseHub();
    const s1 = hub.subscribe('l1', 'c1');
    const s2 = hub.subscribe('l2', 'c1'); // 同 code → 关 s1
    const r1 = await next(s1);
    expect(r1.done).toBe(true); // s1 已被关闭
    expect(hub.byCode.get('c1')).toBe(s2);
    hub.unsubscribe(s2);
  });

  it('publish 在 push 前缓冲，迭代时按序取出', async () => {
    const hub = new SseHub();
    const sub = hub.subscribe('l1', null);
    hub.publish('active', 'l1', { n: 1 });
    hub.publish('active', 'l1', { n: 2 });
    expect((await next(sub)).value.payload.n).toBe(1);
    expect((await next(sub)).value.payload.n).toBe(2);
    hub.unsubscribe(sub);
  });

  it('终态事件后 unsubscribe → 迭代结束', async () => {
    const hub = new SseHub();
    const sub = hub.subscribe('l1', 'c1');
    hub.publish('received', 'l1', { done: true });
    expect((await next(sub)).value.type).toBe('received');
    hub.unsubscribe(sub);
    expect((await next(sub)).done).toBe(true);
  });

  it('unsubscribe 后 publish 不投递；size 归零', () => {
    const hub = new SseHub();
    const sub = hub.subscribe('l1', 'c1');
    expect(hub.size).toBe(1);
    hub.unsubscribe(sub);
    hub.publish('active', 'l1', {}); // 无订阅者
    expect(hub.size).toBe(0);
    expect(hub.byCode.has('c1')).toBe(false);
  });

  it('迭代器 return（客户端断开）会关闭订阅者', async () => {
    const hub = new SseHub();
    const sub = hub.subscribe('l1', 'c1');
    const it = sub[Symbol.asyncIterator]();
    await it.return();
    // 关闭后再 next 直接 done
    expect((await it.next()).done).toBe(true);
    hub.unsubscribe(sub);
  });
});

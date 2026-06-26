import { describe, it, expect } from 'vitest';
import { SerialExecutor } from '../../src/core/serial-executor.js';

describe('M1 单写串行执行器（INV-6 消 TOCTOU）', () => {
  it('100 个并发 submit 严格串行、任意时刻至多一个在跑、按序完成', async () => {
    const ex = new SerialExecutor();
    let active = 0;
    let maxActive = 0;
    const order = [];
    const tasks = Array.from({ length: 100 }, (_, i) =>
      ex.submit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        // 让出事件循环，给交叉留机会——若非串行，active 会 >1
        await new Promise((r) => setTimeout(r, 0));
        order.push(i);
        active--;
        return i;
      }),
    );
    const results = await Promise.all(tasks);
    expect(maxActive).toBe(1); // 无交叉
    expect(order).toEqual([...Array(100).keys()]); // 严格按提交顺序执行
    expect(results).toEqual([...Array(100).keys()]);
  });

  it('一个任务失败不阻断后续任务', async () => {
    const ex = new SerialExecutor();
    const p1 = ex.submit(() => Promise.reject(new Error('boom')));
    const p2 = ex.submit(() => 'ok');
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  it('submit 如实反映同步/异步返回值', async () => {
    const ex = new SerialExecutor();
    await expect(ex.submit(() => 42)).resolves.toBe(42);
    await expect(ex.submit(async () => 43)).resolves.toBe(43);
  });
});

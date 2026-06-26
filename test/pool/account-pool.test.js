import { describe, it, expect } from 'vitest';
import { openDb, applySchema } from '../../src/store/db.js';
import { createStore } from '../../src/store/index.js';
import { SerialExecutor } from '../../src/core/serial-executor.js';
import { AccountPool } from '../../src/pool/account-pool.js';

/** 建内存库 + N 个 swpu 账号 + 一个 pool */
function setup({ accounts = 1, cooldownMs = 0 } = {}) {
  const db = openDb(':memory:');
  applySchema(db);
  const store = createStore(db);
  const now = Date.now();
  for (let i = 1; i <= accounts; i++) {
    store.account.insert({
      id: `acc${i}`,
      university: 'SWPU',
      domain: 'swpu.edu.cn',
      groupName: 'swpu',
      credsRef: `SWPU_ACCT_${i}`,
      updatedAt: now,
    });
  }
  const pool = new AccountPool({ store, serialExecutor: new SerialExecutor(), cooldownMs });
  return { store, pool };
}

describe('M3 AccountPool', () => {
  it('acquire 返回 free 账号并置 leased', async () => {
    const { store, pool } = setup({ accounts: 2 });
    const acc = await pool.acquire(['swpu']);
    expect(acc).toBeTruthy();
    expect(store.account.getById(acc.id).status).toBe('leased');
  });

  it('并发 acquire 不双占：3 账号并发 10 次，恰好 3 个成功且互不相同（INV-2/NFR-3）', async () => {
    const { pool } = setup({ accounts: 3 });
    const results = await Promise.all(Array.from({ length: 10 }, () => pool.acquire(['swpu'])));
    const got = results.filter(Boolean);
    expect(got.length).toBe(3); // 容量 = 账号数
    expect(new Set(got.map((a) => a.id)).size).toBe(3); // 无双占
    expect(results.filter((r) => r === null).length).toBe(7); // 其余落空
  });

  it('分组过滤：allowedGroups 不含账号分组 → null', async () => {
    const { pool } = setup({ accounts: 1 });
    expect(await pool.acquire(['other'])).toBeNull();
  });

  it('release 置回 free 后可再次 acquire', async () => {
    const { pool } = setup({ accounts: 1 });
    const a = await pool.acquire(['swpu']);
    await pool.release(a.id);
    const b = await pool.acquire(['swpu']);
    expect(b.id).toBe(a.id);
  });

  it('冷却期内不可再分配', async () => {
    const { pool } = setup({ accounts: 1, cooldownMs: 10000 });
    const a = await pool.acquire(['swpu']);
    await pool.release(a.id);
    expect(await pool.acquire(['swpu'])).toBeNull(); // 冷却中
  });

  it('不健康账号跳过分配，恢复后可分配', async () => {
    const { pool } = setup({ accounts: 1 });
    pool.setUnhealthy('acc1');
    expect(await pool.acquire(['swpu'])).toBeNull();
    pool.setHealthy('acc1');
    expect(await pool.acquire(['swpu'])).toBeTruthy();
  });

  it('stats 池水位统计', async () => {
    const { pool } = setup({ accounts: 3 });
    await pool.acquire(['swpu']); // acc1 leased
    pool.setUnhealthy('acc3'); // acc3 free 但不健康
    const s = pool.stats();
    expect(s).toMatchObject({ total: 3, leased: 1, unhealthy: 1, free: 1, disabled: 0 });
  });
});

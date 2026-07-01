import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, applySchema } from '../../src/store/db.js';
import { createStore } from '../../src/store/index.js';

/** 每个用例用独立的内存库，护栏（index/CHECK/外键）均在 :memory: 生效 */
function freshStore() {
  const db = openDb(':memory:');
  applySchema(db);
  return createStore(db);
}

describe('M1 DB 护栏（FR-0 兜底防线）', () => {
  let store;
  beforeEach(() => {
    store = freshStore();
  });

  /** 准备满足外键的 account / plan / access_code */
  function seed() {
    const now = Date.now();
    store.account.insert({
      id: 'acc1',
      university: 'SWPU',
      domain: 'swpu.edu.cn',
      groupName: 'swpu',
      credsRef: 'SWPU_ACCT_1',
      updatedAt: now,
    });
    store.account.insert({
      id: 'acc2',
      university: 'SWPU',
      domain: 'swpu.edu.cn',
      groupName: 'swpu',
      credsRef: 'SWPU_ACCT_2',
      updatedAt: now,
    });
    store.plan.upsert({
      prefix: 'gh',
      name: 'GitHub',
      allowedGroups: ['swpu'],
      targetSenders: ['@github.com'],
    });
    store.accessCode.insert({ code: 'gh-aaa', prefix: 'gh', quotaLeft: 1, issuedAt: now });
    store.accessCode.insert({ code: 'gh-bbb', prefix: 'gh', quotaLeft: 1, issuedAt: now });
    return now;
  }

  it('同一 access_code 至多一个 active 租约（INV-1）', () => {
    const now = seed();
    store.lease.insert({
      id: 'l1',
      accessCode: 'gh-aaa',
      plan: 'gh',
      accountId: 'acc1',
      status: 'active',
      createdAt: now,
    });
    expect(() =>
      store.lease.insert({
        id: 'l2',
        accessCode: 'gh-aaa',
        plan: 'gh',
        accountId: 'acc2',
        status: 'active',
        createdAt: now,
      }),
    ).toThrow();
  });

  it('同一 access_code 至多一个 pending 租约（INV-1′）', () => {
    const now = seed();
    store.lease.insert({
      id: 'p1',
      accessCode: 'gh-aaa',
      plan: 'gh',
      accountId: null,
      status: 'pending',
      createdAt: now,
    });
    expect(() =>
      store.lease.insert({
        id: 'p2',
        accessCode: 'gh-aaa',
        plan: 'gh',
        accountId: null,
        status: 'pending',
        createdAt: now,
      }),
    ).toThrow();
  });

  it('同一 account 至多一个 active 租约（INV-2）', () => {
    const now = seed();
    store.lease.insert({
      id: 'l1',
      accessCode: 'gh-aaa',
      plan: 'gh',
      accountId: 'acc1',
      status: 'active',
      createdAt: now,
    });
    expect(() =>
      store.lease.insert({
        id: 'l2',
        accessCode: 'gh-bbb',
        plan: 'gh',
        accountId: 'acc1',
        status: 'active',
        createdAt: now,
      }),
    ).toThrow();
  });

  it('终态租约不占用约束：旧租约 expired 后同码可再建 active', () => {
    const now = seed();
    store.lease.insert({
      id: 'l1',
      accessCode: 'gh-aaa',
      plan: 'gh',
      accountId: 'acc1',
      status: 'active',
      createdAt: now,
    });
    store.lease.updateStatus('l1', 'expired'); // 释放
    expect(() =>
      store.lease.insert({
        id: 'l2',
        accessCode: 'gh-aaa',
        plan: 'gh',
        accountId: 'acc1',
        status: 'active',
        createdAt: now,
      }),
    ).not.toThrow();
  });

  it('quota_left 减到 0 后再无条件减触发 CHECK（INV-3）', () => {
    seed(); // gh-aaa quotaLeft=1
    expect(store.accessCode.decrementQuota('gh-aaa')).toBe(1); // 1→0
    expect(store.accessCode.getByCode('gh-aaa').quotaLeft).toBe(0);
    // 条件扣减再来：WHERE quota_left>0 不匹配，changes=0，不触发 CHECK（生产安全）
    expect(store.accessCode.decrementQuota('gh-aaa')).toBe(0);
    // 模拟 bug：无条件强减 0→-1，CHECK 兜底拒绝
    expect(() =>
      store.db
        .prepare('UPDATE access_code SET quota_left = quota_left - 1 WHERE code = ?')
        .run('gh-aaa'),
    ).toThrow();
  });

  it('quota_left 不可插入负值（CHECK）', () => {
    seed();
    expect(() =>
      store.accessCode.insert({
        code: 'gh-neg',
        prefix: 'gh',
        quotaLeft: -1,
        issuedAt: Date.now(),
      }),
    ).toThrow();
  });

  it('收码幂等：同 (account,uid) 二次记录被拦（M5）', () => {
    const now = seed();
    expect(
      store.processedMail.markProcessed({
        accountId: 'acc1',
        uid: 100,
        leaseId: 'l1',
        processedAt: now,
      }),
    ).toBe(true);
    expect(
      store.processedMail.markProcessed({
        accountId: 'acc1',
        uid: 100,
        leaseId: 'l1',
        processedAt: now,
      }),
    ).toBe(false);
    expect(store.processedMail.exists('acc1', 100)).toBe(true);
  });

  it('外键约束生效：租约引用不存在的账号被拒', () => {
    const now = seed();
    expect(() =>
      store.lease.insert({
        id: 'lx',
        accessCode: 'gh-aaa',
        plan: 'gh',
        accountId: 'ghost',
        status: 'active',
        createdAt: now,
      }),
    ).toThrow();
  });
});

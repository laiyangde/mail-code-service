/**
 * M8 运维任务测试：删信（FR-9）与回看期满 GC（FR-10）。复用内存 harness + fake provider。
 */
import { describe, it, expect } from 'vitest';
import { createHarness } from '../helpers/harness.js';
import { runCleanup } from '../../src/cleaner/cleaner.js';
import { runGc } from '../../src/cleaner/gc.js';

describe('Cleaner（FR-9 删信）', () => {
  it('遍历启用账号汇总删除数；单账号失败不影响其它', async () => {
    const h = createHarness({ accounts: 2 });
    h.providers.acc1.cleanup = async () => ({ deleted: 3 });
    h.providers.acc2.cleanup = async () => {
      throw new Error('IMAP 断连');
    };
    const r = await runCleanup(h.services, { beforeDays: 3 });
    expect(r.accounts).toBe(2);
    expect(r.deleted).toBe(3); // acc2 失败被跳过
  });
});

describe('GC（FR-10 回看期满清理）', () => {
  const now = Date.now();

  /** 造一个已收码、回看期满的码及其关联数据 */
  function seedExpired(h, code) {
    h.store.accessCode.insert({
      code,
      prefix: 'gh',
      status: 'used',
      quotaLeft: 0,
      issuedAt: now,
      retainUntil: now - 1000, // 已过回看期
    });
    h.store.lease.insert({
      id: `L-${code}`,
      accessCode: code,
      plan: 'gh',
      accountId: 'acc1',
      alias: 'x@swpu.edu.cn',
      status: 'received',
      mailUid: 5,
      mailMeta: { from: 'a@github.com' },
      code: '123456',
      renews: 0,
      createdAt: now,
    });
    h.store.processedMail.markProcessed({
      accountId: 'acc1',
      uid: 5,
      leaseId: `L-${code}`,
      processedAt: now,
    });
  }

  it('物理删除码及关联 lease/processed_mail，记审计；保留 unused', async () => {
    const h = createHarness();
    seedExpired(h, 'gh-used');
    // 未使用的码（永久保留，不应被清理）
    h.store.accessCode.insert({
      code: 'gh-unused',
      prefix: 'gh',
      status: 'unused',
      quotaLeft: 1,
      issuedAt: now,
    });

    const r = await runGc(h.services);

    expect(r.purgedCodes).toBe(1);
    expect(r.purgedLeases).toBe(1);
    expect(h.store.accessCode.getByCode('gh-used')).toBeUndefined();
    expect(h.store.lease.getById('L-gh-used')).toBeUndefined();
    expect(h.store.processedMail.exists('acc1', 5)).toBe(false);
    // unused 永久保留
    expect(h.store.accessCode.getByCode('gh-unused')?.status).toBe('unused');
    // 审计摘要落库
    const audits = h.db.prepare(`SELECT * FROM audit_log WHERE action='purge_expired'`).all();
    expect(audits).toHaveLength(1);
    expect(audits[0].target).toBe('gh-used');
  });

  it('回看期未满的 used 码不清理', async () => {
    const h = createHarness();
    h.store.accessCode.insert({
      code: 'gh-fresh',
      prefix: 'gh',
      status: 'used',
      quotaLeft: 0,
      issuedAt: now,
      retainUntil: now + 60_000, // 仍在回看期
    });
    const r = await runGc(h.services);
    expect(r.purgedCodes).toBe(0);
    expect(h.store.accessCode.getByCode('gh-fresh')?.status).toBe('used');
  });
});

import { describe, it, expect } from 'vitest';
import { createHarness } from '../helpers/harness.js';

/**
 * FR-0 头号安全不变量：杜绝「一码多码」。需求 §12 #9 的六个竞态用例必须全过。
 * fake provider 不做三重匹配，故 emit 的邮件直达 Hub→deliver，用于专测调度层护栏。
 */
describe('M5 FR-0 杜绝一码多码（竞态验收 §12 #9）', () => {
  it('① 同码并发 10 次 activate → 只产生 1 个 active 租约（单飞 + INV-1）', async () => {
    const h = createHarness({ accounts: 3 });
    const code = h.issueCode();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => h.manager.createLease(code)),
    );
    // 全部 active 且复用同一租约
    expect(results.every((r) => r.status === 'active')).toBe(true);
    expect(new Set(results.map((r) => r.lease.id)).size).toBe(1);
    // DB 中该码只有 1 个 active；只占用 1 个账号
    expect(h.store.lease.listByStatus('active')).toHaveLength(1);
    expect(h.store.account.list().filter((a) => a.status === 'leased')).toHaveLength(1);
  });

  it('② 同封邮件重复投递 / 双触发 → 只交付 1 次、配额只扣 1（幂等 + 事务①）', async () => {
    const h = createHarness({ accounts: 1 });
    const code = h.issueCode('gh-x', 1);
    const { lease } = await h.manager.createLease(code);
    const mail = h.mailFor(100, lease);
    h.providers.acc1.emit(mail);
    h.providers.acc1.emit(mail); // 同一封重复
    await h.flush();
    expect(h.store.lease.getById(lease.id).status).toBe('received');
    expect(h.store.accessCode.getByCode(code).quotaLeft).toBe(0); // 只扣 1
    expect(h.store.accessCode.getByCode(code).status).toBe('used');
  });

  it('③ 超时重申请后旧别名迟到来码 → 旧租约不交付、配额不扣（事务①affected=0）', async () => {
    const h = createHarness({ accounts: 1 });
    const code = h.issueCode('gh-y', 1);
    const r1 = await h.manager.createLease(code);
    const oldLease = r1.lease;

    // 超时 → expired → 释放
    h.manager._onTimeout(oldLease.id);
    await h.flush();
    expect(h.store.lease.getById(oldLease.id).status).toBe('expired');

    // 重申请 → 新租约
    const r2 = await h.manager.renew(oldLease.id);
    expect(r2.lease.id).not.toBe(oldLease.id);

    // 旧别名迟到来码，喂给旧（已终态）租约
    await h.exec.submit(() =>
      h.manager._deliver({
        accountId: oldLease.accountId,
        lease: oldLease,
        mail: h.mailFor(200, oldLease),
      }),
    );
    expect(h.store.lease.getById(oldLease.id).status).toBe('expired'); // 旧租约不复活
    expect(h.store.accessCode.getByCode(code).quotaLeft).toBe(1); // 配额未扣
  });

  it('④ 两封邮件几乎同时命中 quota=1 → 仅 1 封交付，quota_left→0 不为负（条件 UPDATE）', async () => {
    const h = createHarness({ accounts: 1 });
    const code = h.issueCode('gh-z', 1);
    const { lease } = await h.manager.createLease(code);
    h.providers.acc1.emit(h.mailFor(301, lease));
    h.providers.acc1.emit(h.mailFor(302, lease)); // 不同 uid，几乎同时
    await h.flush();
    expect(h.store.lease.getById(lease.id).status).toBe('received');
    expect(h.store.accessCode.getByCode(code).quotaLeft).toBe(0); // 落到 0，不为负
  });

  it('⑤ 收码扣配额后「重启」→ 码仍 used、不再发码（终态不复活，路径 G）', async () => {
    const h = createHarness({ accounts: 1 });
    const code = h.issueCode('gh-c', 1);
    const { lease } = await h.manager.createLease(code);
    h.providers.acc1.emit(h.mailFor(400, lease));
    await h.flush();
    expect(h.store.accessCode.getByCode(code).status).toBe('used');

    // 「重启」后再 activate 同码：以 DB 为准 → used 回看，不新建租约、不再扣配额
    const r = await h.manager.createLease(code);
    expect(r.status).toBe('used');
    expect(r.results).toHaveLength(1); // 回看到 1 封历史邮件
    expect(h.store.accessCode.getByCode(code).quotaLeft).toBe(0);
    expect(h.store.lease.listByStatus('active')).toHaveLength(0);
  });

  it('⑥ 绕过应用直接写第二个 active 租约 → 被 DB partial unique index 拒绝（INV-1）', async () => {
    const h = createHarness({ accounts: 2 });
    const code = h.issueCode('gh-d', 1);
    await h.manager.createLease(code);
    expect(() =>
      h.store.lease.insert({
        id: 'rogue',
        accessCode: code,
        plan: 'gh',
        accountId: 'acc2',
        status: 'active',
        createdAt: Date.now(),
      }),
    ).toThrow();
  });
});

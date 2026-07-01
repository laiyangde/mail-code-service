import { describe, it, expect, vi } from 'vitest';
import { createHarness } from '../helpers/harness.js';
import { ErrorCode } from '../../src/errors.js';

describe('M5 LeaseManager 功能', () => {
  it('createLease → 收码 → received + 扣配额 + 账号释放', async () => {
    const h = createHarness({ accounts: 1 });
    const code = h.issueCode();
    const { status, lease } = await h.manager.createLease(code);
    expect(status).toBe('active');
    expect(lease.alias).toMatch(/@swpu\.edu\.cn$/);
    expect(h.store.account.getById('acc1').status).toBe('leased');

    await h.manager.confirmReceiving(lease.id); // 确认「我已发送」→ 开始收码
    h.providers.acc1.emit(h.mailFor(1, lease));
    await h.flush();
    const fresh = h.store.lease.getById(lease.id);
    expect(fresh.status).toBe('received');
    expect(fresh.mailMeta.uid).toBe(1);
    expect(h.store.account.getById('acc1').status).toBe('free'); // 已释放
  });

  it('便利码提取：正文数字码写入 lease.code（不影响成功判定）', async () => {
    const h = createHarness({ accounts: 1 });
    const { lease } = await h.manager.createLease(h.issueCode());
    await h.manager.confirmReceiving(lease.id);
    h.providers.acc1.emit(h.mailFor(1, lease, { text: 'Your GitHub code is 482931' }));
    await h.flush();
    expect(h.store.lease.getById(lease.id).code).toBe('482931');
  });

  it('超时 → expired + 释放 + 配额不扣 + 可 renew（新账号/新别名）', async () => {
    const h = createHarness({ accounts: 1 });
    const code = h.issueCode();
    const { lease } = await h.manager.createLease(code);
    h.manager._onTimeout(lease.id);
    await h.flush();
    expect(h.store.lease.getById(lease.id).status).toBe('expired');
    expect(h.store.account.getById('acc1').status).toBe('free');
    expect(h.store.accessCode.getByCode(code).quotaLeft).toBe(1);

    const r = await h.manager.renew(lease.id);
    expect(r.status).toBe('active');
    expect(r.lease.id).not.toBe(lease.id);
    expect(r.lease.renews).toBe(1);
  });

  it('cancel → cancelled + 释放', async () => {
    const h = createHarness({ accounts: 1 });
    const { lease } = await h.manager.createLease(h.issueCode());
    const r = await h.manager.cancel(lease.id);
    expect(r.status).toBe('cancelled');
    expect(h.store.account.getById('acc1').status).toBe('free');
  });

  it('used 回看：成功收码后再 activate 返回历史邮件原文', async () => {
    const h = createHarness({ accounts: 1 });
    const code = h.issueCode();
    const { lease } = await h.manager.createLease(code);
    await h.manager.confirmReceiving(lease.id);
    h.providers.acc1.emit(h.mailFor(1, lease, { subject: '激活', text: 'code 778899' }));
    await h.flush();

    const r = await h.manager.createLease(code);
    expect(r.status).toBe('used');
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ subject: '激活', alias: lease.alias, code: '778899' });
  });

  it('错误码：不存在 / 回看期满', async () => {
    const h = createHarness({ accounts: 1 });
    await expect(h.manager.createLease('nope-xxx')).rejects.toMatchObject({
      code: ErrorCode.CODE_NOT_FOUND,
    });

    const code = h.issueCode();
    const { lease } = await h.manager.createLease(code);
    await h.manager.confirmReceiving(lease.id);
    h.providers.acc1.emit(h.mailFor(1, lease));
    await h.flush();
    h.store.accessCode.setStatusAndRetain(code, 'used', Date.now() - 1000); // 回看期满
    await expect(h.manager.createLease(code)).rejects.toMatchObject({
      code: ErrorCode.CODE_EXPIRED,
    });
  });

  it('池满 → 返回 pending（异步排队，不再同步失败）', async () => {
    const h = createHarness({ accounts: 1 });
    await h.manager.createLease(h.issueCode('gh-a')); // 占用唯一账号
    const r = await h.manager.createLease(h.issueCode('gh-b'));
    expect(r.status).toBe('pending');
    expect(r.lease.accountId).toBeNull();
    expect(h.store.lease.getById(r.lease.id).status).toBe('pending');
  });

  it('排队推进：账号释放后 pending 自动 promote 为 active', async () => {
    const h = createHarness({ accounts: 1 });
    const { lease: l1 } = await h.manager.createLease(h.issueCode('gh-a'));
    const c2 = h.issueCode('gh-b');
    const r2 = await h.manager.createLease(c2); // 池满 → pending
    expect(r2.status).toBe('pending');

    await h.manager.cancel(l1.id); // 释放账号 → 触发异步 promote
    await vi.waitFor(() => {
      expect(h.store.lease.getById(r2.lease.id).status).toBe('active');
    });
    const promoted = h.store.lease.getById(r2.lease.id);
    expect(promoted.accessCode).toBe(c2);
    expect(promoted.alias).toMatch(/@swpu\.edu\.cn$/);
    expect(h.store.account.getById('acc1').status).toBe('leased'); // 账号转给排队者
  });

  it('renew 超 maxRenews → RENEW_LIMIT', async () => {
    const h = createHarness({ accounts: 1, plan: { maxRenews: 1 } });
    const code = h.issueCode();
    const { lease } = await h.manager.createLease(code);
    h.manager._onTimeout(lease.id);
    await h.flush();
    const r1 = await h.manager.renew(lease.id); // renews=1
    h.manager._onTimeout(r1.lease.id);
    await h.flush();
    await expect(h.manager.renew(r1.lease.id)).rejects.toMatchObject({
      code: ErrorCode.RENEW_LIMIT,
    });
  });

  it('确认收码时按需连失败 → 回滚：账号回 free、码回 unused、无 active 残留（RECEIVER_UNAVAILABLE）', async () => {
    const h = createHarness({ accounts: 1 });
    const code = h.issueCode();
    const { lease } = await h.manager.createLease(code); // 设别名成功（此时不连 IMAP）
    h.providers.acc1.setFailStart(true); // 确认时 IMAP 按需建连失败
    await expect(h.manager.confirmReceiving(lease.id)).rejects.toMatchObject({
      code: ErrorCode.RECEIVER_UNAVAILABLE,
    });
    await h.flush();
    expect(h.store.account.getById('acc1').status).toBe('free'); // 账号已释放
    expect(h.store.accessCode.getByCode(code).status).toBe('unused'); // 码退回可重申请
    expect(h.store.lease.listByStatus('active')).toHaveLength(0); // 无 active 残留
  });

  // ── 异步排队（pending 队列 / 位次 / 推进 / 兜底）──
  it('同码并发池满 → 复用同一 pending（不新开，INV-1′）', async () => {
    const h = createHarness({ accounts: 1 });
    await h.manager.createLease(h.issueCode('gh-a')); // 占满唯一账号
    const code = h.issueCode('gh-b');
    const results = await Promise.all(Array.from({ length: 5 }, () => h.manager.createLease(code)));
    expect(results.every((r) => r.status === 'pending')).toBe(true);
    expect(new Set(results.map((r) => r.lease.id)).size).toBe(1); // 同一 pending
    expect(h.store.lease.listByStatus('pending')).toHaveLength(1);
  });

  it('queueAhead：含占用账号的活跃用户 + 队列前面等待者', async () => {
    const h = createHarness({ accounts: 1 });
    await h.manager.createLease(h.issueCode('gh-a')); // 占账号（active）
    const r1 = await h.manager.createLease(h.issueCode('gh-b'));
    const r2 = await h.manager.createLease(h.issueCode('gh-c'));
    // 前面 = 正在占用账号的活跃用户 + 队列中排在前面的等待者
    expect(h.manager.queuePosition(r1.lease.id)).toBe(1); // gh-a 正占着账号
    expect(h.manager.queuePosition(r2.lease.id)).toBe(2); // gh-a 占 + r1 在前面等
  });

  it('promote 后剩余排队者位次正确（占用账号含预占，不跳 0）', async () => {
    const h = createHarness({ accounts: 1 });
    const { lease: l1 } = await h.manager.createLease(h.issueCode('gh-a'));
    const r2 = await h.manager.createLease(h.issueCode('gh-b'));
    const r3 = await h.manager.createLease(h.issueCode('gh-c'));
    expect(h.manager.queuePosition(r3.lease.id)).toBe(2); // gh-a 占 + r2 在前面等

    await h.manager.cancel(l1.id); // 释放 → r2 promote 拿到账号
    await vi.waitFor(() => {
      expect(h.store.lease.getById(r2.lease.id).status).toBe('active');
    });
    // r2 占用账号中 → r3 前面仍有 1 人（r2），不应跳 0
    expect(h.manager.queuePosition(r3.lease.id)).toBe(1);
  });

  it('pending 取消 → 出队 + 码退 unused', async () => {
    const h = createHarness({ accounts: 1 });
    await h.manager.createLease(h.issueCode('gh-a')); // 占满
    const code = h.issueCode('gh-b');
    const r = await h.manager.createLease(code);
    expect(r.status).toBe('pending');
    await h.manager.cancel(r.lease.id);
    expect(h.store.lease.getById(r.lease.id).status).toBe('cancelled');
    expect(h.store.accessCode.getByCode(code).status).toBe('unused'); // 可重申请
    expect(h.manager.queue.size).toBe(0); // 已出队
  });

  it('排队兜底超时 → rejected + 码退 unused', async () => {
    const h = createHarness({ accounts: 1, config: { queueTimeoutSec: 0.05 } });
    await h.manager.createLease(h.issueCode('gh-a')); // 占满
    const code = h.issueCode('gh-b');
    const r = await h.manager.createLease(code);
    expect(r.status).toBe('pending');
    await vi.waitFor(() => {
      expect(h.store.lease.getById(r.lease.id).status).toBe('rejected');
    });
    expect(h.store.accessCode.getByCode(code).status).toBe('unused');
    expect(h.manager.queue.size).toBe(0);
  });

  it('排队者 promote 后确认收码失败 → 转终态、账号释放、码退 unused', async () => {
    const h = createHarness({ accounts: 1 });
    const { lease: l1 } = await h.manager.createLease(h.issueCode('gh-a'));
    const code = h.issueCode('gh-b');
    const r = await h.manager.createLease(code);
    expect(r.status).toBe('pending');

    await h.manager.cancel(l1.id); // 释放 → 触发 promote（待确认，不连 IMAP）
    await vi.waitFor(() => {
      expect(h.store.lease.getById(r.lease.id).status).toBe('active');
    });
    h.providers.acc1.setFailStart(true); // 确认时 IMAP 建连失败 → 回滚
    await expect(h.manager.confirmReceiving(r.lease.id)).rejects.toMatchObject({
      code: ErrorCode.RECEIVER_UNAVAILABLE,
    });
    expect(h.store.accessCode.getByCode(code).status).toBe('unused');
    await vi.waitFor(() => {
      expect(h.store.account.getById('acc1').status).toBe('free');
    });
  });

  it('收码释放后自动推进下一个排队者', async () => {
    const h = createHarness({ accounts: 1 });
    const { lease: l1 } = await h.manager.createLease(h.issueCode('gh-a'));
    await h.manager.confirmReceiving(l1.id); // 开始收码
    const c2 = h.issueCode('gh-b');
    const r2 = await h.manager.createLease(c2); // pending
    expect(r2.status).toBe('pending');

    h.providers.acc1.emit(h.mailFor(1, l1)); // l1 收码 → 释放账号 → 推进 r2
    await vi.waitFor(() => {
      expect(h.store.lease.getById(r2.lease.id).status).toBe('active');
    });
    expect(h.store.lease.getById(l1.id).status).toBe('received');
  });

  it('确认前不连 IMAP、确认后才连并可收码', async () => {
    const h = createHarness({ accounts: 1 });
    const { lease } = await h.manager.createLease(h.issueCode());
    // 设别名后：占着账号，但未连 IMAP（待用户确认）
    expect(h.providers.acc1.started).toBe(false);
    expect(h.store.lease.getById(lease.id).receiving).toBe(0);

    await h.manager.confirmReceiving(lease.id); // 「我已发送邮件」
    expect(h.providers.acc1.started).toBe(true); // 此时才连
    expect(h.store.lease.getById(lease.id).receiving).toBe(1);

    h.providers.acc1.emit(h.mailFor(1, lease));
    await h.flush();
    expect(h.store.lease.getById(lease.id).status).toBe('received');
  });
});

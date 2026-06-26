import { describe, it, expect } from 'vitest';
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
    h.providers.acc1.emit(h.mailFor(1, lease));
    await h.flush();
    h.store.accessCode.setStatusAndRetain(code, 'used', Date.now() - 1000); // 回看期满
    await expect(h.manager.createLease(code)).rejects.toMatchObject({
      code: ErrorCode.CODE_EXPIRED,
    });
  });

  it('POOL_BUSY：账号占满且排队超时', async () => {
    const h = createHarness({ accounts: 1, config: { acquireTimeoutSec: 0.05 } });
    await h.manager.createLease(h.issueCode('gh-a')); // 占用唯一账号
    await expect(h.manager.createLease(h.issueCode('gh-b'))).rejects.toMatchObject({
      code: ErrorCode.POOL_BUSY,
    });
  });

  it('排队转交：账号释放后等待者拿到账号继续 active', async () => {
    const h = createHarness({ accounts: 1, config: { acquireTimeoutSec: 5 } });
    const { lease: l1 } = await h.manager.createLease(h.issueCode('gh-a'));
    const c2 = h.issueCode('gh-b');
    const p2 = h.manager.createLease(c2); // 入队等待
    await h.manager.cancel(l1.id); // 释放账号 → 转交给等待者
    const r2 = await p2;
    expect(r2.status).toBe('active');
    expect(r2.lease.accessCode).toBe(c2);
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
});

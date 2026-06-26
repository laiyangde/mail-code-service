/**
 * M8 重启恢复测试（C-6 / §3.5）：进程重启后按 DB 重建在途租约运行态。
 */
import { describe, it, expect } from 'vitest';
import { createHarness } from '../helpers/harness.js';

const now = Date.now();
const nowSec = Math.floor(now / 1000);

/** 造一条 active 租约 + 标账号 leased */
function seedActive(h, { id, expiresAt }) {
  const code = h.issueCode(`code-${id}`);
  h.store.accessCode.updateStatus(code, 'active');
  h.store.lease.insert({
    id,
    accessCode: code,
    plan: 'gh',
    accountId: 'acc1',
    alias: 'x@swpu.edu.cn',
    status: 'active',
    startTime: nowSec,
    expiresAt,
    renews: 0,
    createdAt: now,
  });
  h.store.account.updateStatus('acc1', 'leased', now);
  return code;
}

describe('recoverActiveLeases', () => {
  it('未过期 active：重建收码绑定，账号保持 leased', async () => {
    const h = createHarness();
    seedActive(h, { id: 'L1', expiresAt: nowSec + 900 });

    const r = await h.manager.recoverActiveLeases();

    expect(r.recovered).toBe(1);
    expect(h.providers.acc1.hasSub).toBe(true); // bindLease 生效
    expect(h.store.account.getById('acc1').status).toBe('leased');
  });

  it('已过期 active：立即超时 → expired + 释放账号', async () => {
    const h = createHarness();
    seedActive(h, { id: 'L1', expiresAt: nowSec - 10 });

    const r = await h.manager.recoverActiveLeases();
    await h.flush();

    expect(r.expired).toBe(1);
    expect(h.store.lease.getById('L1').status).toBe('expired');
    expect(h.store.account.getById('acc1').status).toBe('free');
  });

  it('pending 残留 → rejected', async () => {
    const h = createHarness();
    const code = h.issueCode('code-p');
    h.store.lease.insert({
      id: 'LP',
      accessCode: code,
      plan: 'gh',
      accountId: null,
      alias: null,
      status: 'pending',
      renews: 0,
      createdAt: now,
    });

    const r = await h.manager.recoverActiveLeases();

    expect(r.rejected).toBe(1);
    expect(h.store.lease.getById('LP').status).toBe('rejected');
  });

  it('对账：leased 但无 active 租约的账号被释放', async () => {
    const h = createHarness();
    h.store.account.updateStatus('acc1', 'leased', now); // 崩溃残留占用，无对应 active

    const r = await h.manager.recoverActiveLeases();

    expect(r.reconciled).toBe(1);
    expect(h.store.account.getById('acc1').status).toBe('free');
  });
});

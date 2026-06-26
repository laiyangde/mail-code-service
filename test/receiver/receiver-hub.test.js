import { describe, it, expect } from 'vitest';
import { openDb, applySchema } from '../../src/store/db.js';
import { createStore } from '../../src/store/index.js';
import { SerialExecutor } from '../../src/core/serial-executor.js';
import { AccountPool } from '../../src/pool/account-pool.js';
import { ReceiverHub } from '../../src/receiver/receiver-hub.js';
import { createFakeProvider } from '../helpers/fake-provider.js';

function setup() {
  const db = openDb(':memory:');
  applySchema(db);
  const store = createStore(db);
  const exec = new SerialExecutor();
  const pool = new AccountPool({ store, serialExecutor: exec });
  store.account.insert({
    id: 'acc1',
    university: 'SWPU',
    domain: 'swpu.edu.cn',
    groupName: 'swpu',
    credsRef: 'X',
    updatedAt: Date.now(),
  });
  const provider = createFakeProvider('acc1');
  pool.registerProvider('acc1', provider);
  const hub = new ReceiverHub({ pool, store, serialExecutor: exec });
  return { store, pool, hub, provider, exec };
}

/** 等串行队列排空：尾插一个空任务并 await */
const flush = (exec) => exec.submit(() => {});

const mailTo = (uid, to) => ({
  uid,
  from: 'noreply@github.com',
  to,
  subject: 'x',
  date: 1000,
  text: 'code 123456',
  html: '',
});

describe('M4 ReceiverHub', () => {
  it('bindLease → 命中邮件 → onDeliver 收到 payload', async () => {
    const { hub, provider, exec } = setup();
    const delivered = [];
    hub.setDeliverHandler((p) => delivered.push(p));
    hub.bindLease(
      'acc1',
      { id: 'l1', accessCode: 'gh-a' },
      { to: 'a@swpu.edu.cn', fromSenders: ['@github.com'], since: 0 },
    );
    provider.emit(mailTo(100, 'a@swpu.edu.cn'));
    await flush(exec);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ accountId: 'acc1' });
    expect(delivered[0].lease.id).toBe('l1');
    expect(delivered[0].mail.uid).toBe(100);
  });

  it('已 processed 的邮件预检丢弃，不再 onDeliver（幂等优化）', async () => {
    const { store, hub, provider, exec } = setup();
    store.processedMail.markProcessed({
      accountId: 'acc1',
      uid: 100,
      leaseId: 'l1',
      processedAt: Date.now(),
    });
    const delivered = [];
    hub.setDeliverHandler((p) => delivered.push(p));
    hub.bindLease(
      'acc1',
      { id: 'l1', accessCode: 'gh-a' },
      { to: 'a@swpu.edu.cn', fromSenders: ['@github.com'], since: 0 },
    );
    provider.emit(mailTo(100, 'a@swpu.edu.cn'));
    await flush(exec);
    expect(delivered).toHaveLength(0);
  });

  it('unbindLease 后订阅取消，邮件不再回调', async () => {
    const { hub, provider, exec } = setup();
    const delivered = [];
    hub.setDeliverHandler((p) => delivered.push(p));
    hub.bindLease(
      'acc1',
      { id: 'l1', accessCode: 'gh-a' },
      { to: 'a@swpu.edu.cn', fromSenders: ['@github.com'], since: 0 },
    );
    hub.unbindLease('acc1');
    expect(provider.hasSub).toBe(false);
    provider.emit(mailTo(100, 'a@swpu.edu.cn'));
    await flush(exec);
    expect(delivered).toHaveLength(0);
  });

  it('bindLease 覆盖旧绑定（防订阅泄漏）', () => {
    const { hub, provider } = setup();
    hub.setDeliverHandler(() => {});
    hub.bindLease(
      'acc1',
      { id: 'l1', accessCode: 'gh-a' },
      { to: 'a@swpu.edu.cn', fromSenders: ['@x'], since: 0 },
    );
    hub.bindLease(
      'acc1',
      { id: 'l2', accessCode: 'gh-b' },
      { to: 'b@swpu.edu.cn', fromSenders: ['@x'], since: 0 },
    );
    expect(hub.bindings.get('acc1').leaseId).toBe('l2');
    expect(provider.match.to).toBe('b@swpu.edu.cn');
  });
});

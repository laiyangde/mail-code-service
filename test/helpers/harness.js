/**
 * 测试 harness：用内存 DB + fake provider 装配整个调度栈（Store/Pool/Hub/Access/Lease），
 * 让 LeaseManager 的 FR-0 竞态用例可在不连真实 SWPU 的前提下运行。
 *
 * 装配复用生产路径 {@link buildServices}（注入 fake providerFactory），仅额外提供
 * issueCode/mailFor/flush 等测试辅助——与 index.js 走同一套组装，避免装配漂移。
 */
import { openDb, applySchema } from '../../src/store/db.js';
import { createStore } from '../../src/store/index.js';
import { buildServices } from '../../src/services.js';
import { createFakeProvider } from './fake-provider.js';

/**
 * @param {object} [opts]
 * @param {number} [opts.accounts] 账号数
 * @param {object} [opts.plan] 覆盖默认套餐字段
 * @param {object} [opts.config] LeaseManager 配置（queueTimeoutSec 等）
 */
export function createHarness({ accounts = 1, plan = {}, config = {} } = {}) {
  const db = openDb(':memory:');
  applySchema(db);
  const seed = createStore(db);
  const now = Date.now();

  const p = {
    prefix: 'gh',
    name: 'GitHub',
    allowedGroups: ['swpu'],
    targetSenders: ['@github.com'],
    quota: 1,
    leaseTtlSec: 900,
    retentionSec: 604800,
    maxRenews: 5,
    ...plan,
  };
  seed.plan.upsert(p);
  for (let i = 1; i <= accounts; i++) {
    seed.account.insert({
      id: `acc${i}`,
      university: 'SWPU',
      domain: 'swpu.edu.cn',
      groupName: 'swpu',
      credsRef: `X${i}`,
      updatedAt: now,
    });
  }

  // fake providerFactory：建 fake 的同时记录实例，供测试 emit() 触发收码
  /** @type {Record<string, ReturnType<typeof createFakeProvider>>} */
  const providers = {};
  const providerFactory = (account) => {
    const fp = createFakeProvider(account.id);
    providers[account.id] = fp;
    return fp;
  };

  const services = buildServices({ db, providerFactory, leaseConfig: config });
  const { store, exec, pool, hub, accessService, manager } = services;

  /** 发一个唯一码 */
  function issueCode(code = 'gh-test', quotaLeft = p.quota) {
    store.accessCode.insert({ code, prefix: p.prefix, status: 'unused', quotaLeft, issuedAt: now });
    return code;
  }

  /** 构造一封发往某别名的邮件 */
  function mailFor(uid, lease, extra = {}) {
    return {
      uid,
      from: 'noreply@github.com',
      to: lease.alias,
      subject: 'code',
      date: (lease.startTime ?? 0) + 1,
      text: 'your code 123456',
      html: '',
      ...extra,
    };
  }

  /** 等串行队列排空 */
  const flush = () => exec.submit(() => {});

  return {
    db,
    store,
    exec,
    pool,
    hub,
    accessService,
    manager,
    providers,
    issueCode,
    mailFor,
    flush,
    plan: p,
    services,
  };
}

/**
 * 服务装配（M6）：把核心调度栈（Store / Pool / ReceiverHub / AccessService / LeaseManager
 * + 单写串行执行器 + Ports）组装成一个 `services` 对象，供 `index.js`（真实 provider）与
 * 测试 harness（fake provider）共用，消除装配重复。
 *
 * **provider 来源解耦**：装配只依赖注入的 `providerFactory(account) → EmailProvider`，
 * 真实环境传 {@link createProviderForAccount}，测试传 fake——调度核心对二者无差别（§0.1）。
 */
import { createStore } from './store/index.js';
import { SerialExecutor } from './core/serial-executor.js';
import { AccountPool } from './pool/account-pool.js';
import { ReceiverHub } from './receiver/receiver-hub.js';
import { AccessService } from './access/access-service.js';
import { MemoryLock } from './lease/ports/lock.js';
import { MemoryWaitQueue } from './lease/ports/queue.js';
import { LeaseTimer } from './lease/timer.js';
import { LeaseManager } from './lease/lease-manager.js';

/**
 * @typedef {Object} Services
 * @property {ReturnType<import('./store/index.js').createStore>} store
 * @property {SerialExecutor} exec
 * @property {AccountPool} pool
 * @property {ReceiverHub} hub
 * @property {AccessService} accessService
 * @property {LeaseManager} manager
 * @property {MemoryLock} lock
 * @property {MemoryWaitQueue} queue
 * @property {LeaseTimer} timer
 * @property {(account: object) => import('./provider/email-provider.js').EmailProvider} providerFactory
 */

/**
 * 装配核心调度栈。账号需已在 DB（由 migrate / admin 录入），本函数为每个**启用**账号
 * 经 `providerFactory` 建 provider 并登记到池（不在此启动 IMAP，留给调用方 `hub.start()`）。
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db 已 applySchema 的连接
 * @param {(account: object) => import('./provider/email-provider.js').EmailProvider} opts.providerFactory
 * @param {{ acquireTimeoutSec?: number, retentionSec?: number }} [opts.leaseConfig] LeaseManager 配置
 * @returns {Services}
 */
export function buildServices({ db, providerFactory, leaseConfig = {} }) {
  const store = createStore(db);
  const exec = new SerialExecutor();
  const pool = new AccountPool({ store, serialExecutor: exec });
  const hub = new ReceiverHub({ pool, store, serialExecutor: exec });
  const accessService = new AccessService({ store });
  const lock = new MemoryLock();
  const queue = new MemoryWaitQueue();
  const timer = new LeaseTimer();
  const manager = new LeaseManager({
    store,
    serialExecutor: exec,
    pool,
    hub,
    accessService,
    lock,
    queue,
    timer,
    config: leaseConfig,
  });

  /** @type {Services} */
  const services = {
    store,
    exec,
    pool,
    hub,
    accessService,
    manager,
    lock,
    queue,
    timer,
    providerFactory,
  };

  for (const account of store.account.listEnabled()) {
    registerAccount(services, account);
  }
  return services;
}

/**
 * 动态为一个账号建 provider 并登记到池（admin 新增账号后免重启生效，FR-8.1）。
 * **仅做同步登记**；常驻 IMAP 启动由调用方按需 `await provider.startReceiver?.()`。
 * @param {Services} services
 * @param {object} account email_account 行
 * @returns {import('./provider/email-provider.js').EmailProvider}
 */
export function registerAccount(services, account) {
  const provider = services.providerFactory(account);
  services.pool.registerProvider(account.id, provider);
  return provider;
}

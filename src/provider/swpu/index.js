/**
 * SWPU EmailProvider 装配：把 session / http / imap / cleanup 组合成一个实现 §0.1 接口的实例。
 *
 * 接口方法（调度核心只认这些）：capabilities / login / isSessionValid / ensureSession /
 * getCurrentAlias / setAlias / subscribeMail / cleanup。
 * 另暴露生命周期方法（startReceiver / stopReceiver / loadSession）供 AccountPool / ReceiverHub
 * 管理常驻 IMAP 连接与持久化会话——非接口契约，但实现层需要。
 */
import { resolveSwpuCredentials } from './credentials.js';
import { swpuCapabilities } from './capabilities.js';
import { SwpuSession } from './session.js';
import { SwpuHttpClient } from './http.js';
import { SwpuImap } from './imap.js';
import { swpuCleanup } from './cleanup.js';
import { assertEmailProvider } from '../email-provider.js';
import { config } from '../../config.js';

/** SWPU 域名 */
const SWPU_DOMAIN = 'swpu.edu.cn';

/**
 * 创建一个 SWPU EmailProvider 实例。
 * @param {object} opts
 * @param {string} opts.accountId 账号唯一标识
 * @param {string} opts.credsRef 凭据引用（.env 键前缀，如 'SWPU_ACCT_1'）
 * @param {string} [opts.group] 分组（默认取凭据里的 GROUP）
 * @param {boolean} [opts.headless] 登录是否无头
 * @param {() => void} [opts.onHealthy] IMAP 恢复回调
 * @param {(err: Error) => void} [opts.onUnhealthy] IMAP 连续失败回调
 * @returns {import('../email-provider.js').EmailProvider}
 */
export function createSwpuProvider({
  accountId,
  credsRef,
  group,
  headless,
  onHealthy,
  onUnhealthy,
}) {
  const cred = resolveSwpuCredentials(credsRef, SWPU_DOMAIN);
  const session = new SwpuSession({
    accountId,
    credentials: cred,
    dataDir: config.dataDir,
    headless,
  });
  const http = new SwpuHttpClient({ session });
  const imap = new SwpuImap({
    accountId,
    imapUser: cred.email,
    imapPass: cred.imapPass,
    host: config.imap.host,
    port: config.imap.port,
    onHealthy,
    onUnhealthy,
  });

  const provider = {
    accountId,
    domain: SWPU_DOMAIN,
    group: group || cred.group,

    capabilities: () => swpuCapabilities(),

    // ── 会话 ──
    login: () => session.login(),
    isSessionValid: (probe) => session.isSessionValid(probe),
    ensureSession: () => session.ensureSession(),

    // ── 别名（HTTP）──
    getCurrentAlias: () => http.getCurrentAlias(),
    setAlias: (newAlias) => http.setAlias(newAlias),

    // ── 收码（常驻 IMAP 订阅）──
    subscribeMail: (match, onMail) => imap.subscribeMail(match, onMail),

    // ── 删信（独立 IMAP 连接）──
    cleanup: (criteria) =>
      swpuCleanup(
        {
          accountId,
          imapUser: cred.email,
          imapPass: cred.imapPass,
          host: config.imap.host,
          port: config.imap.port,
        },
        criteria,
      ),

    // ── 生命周期（非 §0.1 接口，供 Pool/Hub 管理）──
    /** 启动常驻 IMAP 连接（订阅前必须先调用） */
    startReceiver: () => imap.start(),
    /** 停止常驻 IMAP 连接 */
    stopReceiver: () => imap.stop(),
    /** 加载持久化会话（启动时调用，命中则免开浏览器） */
    loadSession: () => session.load(),
  };

  return assertEmailProvider(provider);
}

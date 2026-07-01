/**
 * 集中读取环境变量（NFR-4：不硬编码，必填项缺失即报错）。
 *
 * 分两类：
 * - 有合理默认的（端口、调度时长）→ 启动即解析，缺失用默认；
 * - 必填且无默认的（账号密码、API Key）→ 不在此处强制，由使用点调 {@link requireEnv}
 *   惰性校验，避免 M0 起服务即因尚未配置的下游凭据而失败。
 */
import 'dotenv/config';

/**
 * 读取必填环境变量，缺失立即抛错。
 * @param {string} key 环境变量名
 * @returns {string} 变量值（保证非空）
 */
export function requireEnv(key) {
  const v = process.env[key];
  if (v === undefined || v === '') {
    throw new Error(`缺少必需的环境变量：${key}（请在 .env 中配置，参考 .env.example）`);
  }
  return v;
}

/**
 * 读取可选环境变量，缺失返回默认值。
 * @param {string} key 环境变量名
 * @param {string} fallback 默认值
 * @returns {string}
 */
export function optionalEnv(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

/**
 * 解析整数环境变量，非法或缺失时回退默认值。
 * @param {string} key 环境变量名
 * @param {number} fallback 默认值
 * @returns {number}
 */
function intEnv(key, fallback) {
  const n = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isNaN(n) ? fallback : n;
}

/** 启动期即确定的配置（带默认值，不含必填凭据）。 */
export const config = {
  port: intEnv('PORT', 8080),
  /** 运行态数据目录：SQLite 库文件与会话缓存落于此 */
  dataDir: optionalEnv('SESSION_DATA_DIR', './data'),

  /** 调度默认值，单个 plan 可覆盖（lease_ttl_sec 等列） */
  lease: {
    ttlSec: intEnv('LEASE_TTL_SEC', 900),
    /** 排队兜底上限秒数：pending 租约超此仍未轮到 → rejected（产品上不设硬超时，此为防泄漏兜底，默认 30min） */
    queueTimeoutSec: intEnv('QUEUE_TIMEOUT_SEC', 1800),
    retentionSec: intEnv('RETENTION_SEC', 604800),
  },

  imap: {
    host: optionalEnv('IMAP_HOST', 'mailgate.swpu.edu.cn'),
    port: intEnv('IMAP_PORT', 993),
  },

  /** 运维定时任务（M8）：删信（FR-9）与回看期满 GC（FR-10） */
  maintenance: {
    /** 删信周期（毫秒），默认 6 小时 */
    cleanupIntervalMs: intEnv('CLEANUP_INTERVAL_SEC', 21600) * 1000,
    /** 删除多少天前的邮件，默认 3 天 */
    cleanupBeforeDays: intEnv('CLEANUP_BEFORE_DAYS', 3),
    /** GC 周期（毫秒），默认 1 小时 */
    gcIntervalMs: intEnv('GC_INTERVAL_SEC', 3600) * 1000,
  },

  /**
   * 接入层鉴权密钥（M6）。**空字符串视为「该入口未启用」**——鉴权钩子据此返回 503，
   * 避免误把未配置的入口当成「任何请求都放行」。明文只存 .env，不入库（NFR-1）。
   * 用 getter 每次读最新 env：生产启动后 env 不变（无影响），测试可动态注入密钥。
   */
  auth: {
    get apiKey() {
      return optionalEnv('API_KEY', ''); // 自用 API：X-API-Key
    },
    get adminToken() {
      return optionalEnv('ADMIN_TOKEN', ''); // Admin：Authorization: Bearer <token>
    },
  },

  /** activate 限流（NFR-4：防唯一码被刷/滥用），按 code+IP 计数。getter 便于测试注入阈值 */
  rateLimit: {
    get activateMax() {
      return intEnv('RATE_LIMIT_ACTIVATE_MAX', 10);
    },
    get windowSec() {
      return intEnv('RATE_LIMIT_WINDOW_SEC', 60);
    },
  },

  /** 自用 API webhook 回调（FR-7.3）：HMAC 签名 + 超时 + 重试 */
  webhook: {
    secret: optionalEnv('WEBHOOK_SECRET', ''), // 空=不签名（仍可回调，但无 X-Signature 头）
    timeoutMs: intEnv('WEBHOOK_TIMEOUT_MS', 8000),
    maxRetries: intEnv('WEBHOOK_MAX_RETRIES', 3),
  },
};

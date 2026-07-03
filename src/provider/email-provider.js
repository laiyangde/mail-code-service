/**
 * EmailProvider 统一接口（需求 §0.1）。
 *
 * 每个大学 = 一份配置 + 一个本接口实现；**调度核心只依赖本接口**，永不直接
 * 触碰浏览器 / HTTP / IMAP 细节。把「登录取凭证、失效判定、改别名、收码、删信」
 * 等各校差异点显式拆成独立方法，由各校各自实现。SWPU 为首个实现（src/provider/swpu/）。
 *
 * JS 无 interface，故用 JSDoc `@typedef` 描述形状 + {@link assertEmailProvider}
 * 在装配时做运行时校验（fail-fast）。
 */

/**
 * 别名命名规则：驱动别名生成器，约束字符集 / 长度 / 域名（各校不同）。
 * @typedef {Object} AliasRule
 * @property {string} charset 允许字符集（正则字符类片段，如 'a-z0-9'）
 * @property {number} minLen 最小长度（不含域名）
 * @property {number} maxLen 最大长度（不含域名）
 * @property {string} domain 邮箱域名（如 'swpu.edu.cn'），最终地址为 `<alias>@<domain>`
 * @property {string} [prefix] 固定前缀（可选，部分学校强制）
 * @property {string} [suffix] 固定后缀（可选）
 */

/**
 * 能力与规则声明：驱动别名生成、收码默认正则、是否支持 IMAP 删信等。
 * @typedef {Object} ProviderCaps
 * @property {AliasRule} aliasRule 别名规则
 * @property {'imap'|'web'} receiveChannel 收码通道（SWPU 走 imap）
 * @property {boolean} supportsImapDelete 是否支持 IMAP 删信
 * @property {RegExp} codeRegex 默认验证码正则（**便利字段**，抽取失败不影响成功判定）
 */

/**
 * 会话凭证（形态因校而异）。SWPU 依赖网页会话（cookie + zid）发别名 HTTP。
 * @typedef {Object} Session
 * @property {Array<{name:string,value:string,domain?:string,path?:string}>} cookies 全量 cookie（反风控需全量，非只挑会话 cookie）
 * @property {string} zid 会话级令牌（SWPU 取自 `window.gZid`）
 * @property {string} ua 登录浏览器 User-Agent（HTTP 复用以对齐环境）
 * @property {Record<string,string>} headers 关键请求头快照（Referer/Origin/sec-ch-ua 等，NFR-8）
 * @property {number} createdAt 凭证创建时间戳（ms）
 */

/**
 * 收码匹配条件（三重匹配防串号，C-4）。
 * @typedef {Object} MailMatch
 * @property {string} to 收件别名地址（一次性、全域唯一，**主隔离键**）
 * @property {string[]} fromSenders 目标发件人（域名 / 通配，如 ['@github.com','*.sendgrid.net']）
 * @property {number} since 起始时间戳（**秒级**）；只接受 `邮件时间 ≥ since` 的邮件，排除别名复用前的历史邮件
 */

/**
 * 整封邮件（**交付物**；服务端不在此提码，由消费端自行解析）。
 * @typedef {Object} MailMeta
 * @property {number} uid IMAP UID（去重 / 删信用）
 * @property {string} from 发件人原文
 * @property {string} to 收件人（命中的别名）
 * @property {string} subject 主题
 * @property {number} date 邮件时间戳（秒）
 * @property {string} text 纯文本正文
 * @property {string} html HTML 正文
 */

/**
 * 取消订阅句柄。
 * @callback Unsubscribe
 * @returns {void}
 */

/**
 * setAlias 结果。
 * @typedef {Object} SetAliasResult
 * @property {boolean} ok 是否成功
 * @property {string} finalAlias 最终生效别名（冲突自动加后缀后的实际值）
 * @property {boolean} [conflict] exact 模式下别名已被占用（自用 API 指定别名冲突）
 */

/**
 * 删信结果。
 * @typedef {Object} CleanupResult
 * @property {number} deleted 实际删除的邮件数
 */

/**
 * EmailProvider 接口形状（用 @typedef 描述，实现以 plain object 提供）。
 * @typedef {Object} EmailProvider
 * @property {string} accountId 账号唯一标识
 * @property {string} domain 邮箱域名（如 swpu.edu.cn）
 * @property {string} group 分组（按大学 / 平台兼容性，套餐据此选号）
 * @property {() => ProviderCaps} capabilities 能力与规则声明
 * @property {() => Promise<Session>} login 登录取凭证（流程因校而异；**仅失效时调用**）
 * @property {(probe: unknown) => boolean} isSessionValid 失效信号判定（因校而异）
 * @property {() => Promise<Session>} ensureSession single-flight：有效则复用，失效则 login()
 * @property {() => Promise<string>} getCurrentAlias 获取当前别名
 * @property {(newAlias: string, opts?: {exact?: boolean}) => Promise<SetAliasResult>} setAlias 设置别名（默认冲突自动加后缀；exact=true 精确别名，冲突即返回 {ok:false,conflict:true}）
 * @property {(match: MailMatch, onMail: (mail: MailMeta) => void) => Unsubscribe} subscribeMail 常驻订阅：命中邮件主动回调整封邮件
 * @property {(criteria?: object) => Promise<CleanupResult>} cleanup 删信（IMAP 或网页，因校而异）
 */

/** 实现必须提供的字符串属性 */
const REQUIRED_PROPS = Object.freeze(['accountId', 'domain', 'group']);

/** 实现必须提供的方法 */
const REQUIRED_METHODS = Object.freeze([
  'capabilities',
  'login',
  'isSessionValid',
  'ensureSession',
  'getCurrentAlias',
  'setAlias',
  'subscribeMail',
  'cleanup',
]);

/**
 * 运行时校验一个对象是否实现了 EmailProvider 接口。
 * 装配账号池时对每个 provider 调用，缺方法 / 缺属性立即抛错（fail-fast），
 * 避免运行到一半才因 provider 不完整而崩溃。
 * @param {unknown} impl 待校验的实现
 * @returns {EmailProvider} 原样返回（类型收窄为 EmailProvider）
 */
export function assertEmailProvider(impl) {
  if (!impl || typeof impl !== 'object') {
    throw new Error('EmailProvider 实现必须是一个对象');
  }
  for (const prop of REQUIRED_PROPS) {
    if (typeof impl[prop] !== 'string' || impl[prop] === '') {
      throw new Error(`EmailProvider 缺少必需属性「${prop}」（须为非空字符串）`);
    }
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof impl[method] !== 'function') {
      throw new Error(`EmailProvider 缺少必需方法「${method}()」`);
    }
  }
  return /** @type {EmailProvider} */ (impl);
}

/**
 * 收码三重匹配（C-4 防串号）的**纯判定逻辑**，从 IMAP 收发细节中抽离，便于单测。
 *
 * 命中条件：
 * 1. To = 本租约别名地址（一次性、全域唯一，主隔离键，**必须**）；
 * 2. 邮件时间 ≥ since（**秒级精筛**，排除别名复用前的历史邮件，**必须**）；
 * 3. From 命中目标发件人（域名 / 通配；**可选**——套餐未配 targetSenders 时不校验发件人）。
 */

/**
 * 从形如 `"GitHub" <noreply@github.com>` 或 `noreply@github.com` 的字符串里提取纯地址（小写）。
 * @param {string} raw 发件人 / 收件人原文
 * @returns {string} 小写邮箱地址；无法解析时返回原文去空格小写
 */
export function extractAddress(raw) {
  if (!raw) return '';
  const m = String(raw).match(/<([^>]+)>/);
  const addr = m ? m[1] : String(raw);
  return addr.trim().toLowerCase();
}

/**
 * 判断单个发件地址是否命中一条发件人规则。规则三种写法：
 * - `@github.com`     → 地址以该域名结尾（域名匹配，**最常用**）；
 * - `*.sendgrid.net`  → 通配，`*` 匹配任意字符（ESP 动态子域 / 前缀）；
 * - `noreply@x.com`   → 完整地址精确相等。
 * 全部大小写不敏感。
 * @param {string} addr 已提取的小写发件地址
 * @param {string} rule 规则
 * @returns {boolean}
 */
export function senderRuleHits(addr, rule) {
  if (!addr || !rule) return false;
  const r = rule.trim().toLowerCase();
  if (r.startsWith('@')) {
    // 域名匹配：地址须以 '@domain' 或 '.domain'（子域）结尾
    return addr.endsWith(r) || addr.endsWith('.' + r.slice(1));
  }
  if (r.includes('*')) {
    // 通配转正则：转义正则元字符后把 '*' 还原为 '.*'，整串锚定
    const escaped = r.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(addr);
  }
  return addr === r;
}

/**
 * 发件人是否命中任一目标规则。
 * @param {string} fromAddr 已提取的小写发件地址
 * @param {string[]} fromSenders 规则列表
 * @returns {boolean}
 */
export function matchSender(fromAddr, fromSenders) {
  if (!Array.isArray(fromSenders) || fromSenders.length === 0) return false;
  return fromSenders.some((rule) => senderRuleHits(fromAddr, rule));
}

/**
 * 三重匹配判定。输入为**已规范化**的邮件（地址小写、时间为秒级时间戳）。
 * @param {{ fromAddr: string, toAddrs: string[], date: number }} mail 规范化邮件
 * @param {import('../email-provider.js').MailMatch} match 匹配条件
 * @returns {boolean} 是否命中本租约
 */
export function matchMail(mail, match) {
  const targetTo = String(match.to || '')
    .trim()
    .toLowerCase();
  // 1. To 命中：收件人集合里有任一等于本别名
  const toHit = (mail.toAddrs || []).some((to) => to === targetTo);
  if (!toHit) return false;
  // 2. From 命中目标发件人（未配置 targetSenders 则跳过，只按 To + 时间窗匹配）
  if (Array.isArray(match.fromSenders) && match.fromSenders.length > 0) {
    if (!matchSender(mail.fromAddr, match.fromSenders)) return false;
  }
  // 3. 秒级时间窗：邮件时间 ≥ since
  if (!(Number(mail.date) >= Number(match.since))) return false;
  return true;
}

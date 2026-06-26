/**
 * SWPU 会话认证层（基座 FR-1）：浏览器**仅用于登录**，产出 `{ cookies, zid, ua, headers }`，
 * 此后别名走纯 HTTP、收码走 IMAP，常态不开浏览器。
 *
 * 关键机制：
 * - **持久化**：会话落盘 `data/swpu-session.<accountId>.json`，进程启动优先加载，命中则不开浏览器；
 * - **zid 轻量刷新**（FR-1.7）：cookie 有效但缺 zid 时，纯 HTTP `GET /?q=base` 正则提 `gZid`，避免开浏览器；
 * - **登录态探针**（FR-1.8）：以 `?q=base` 响应体**文本特征**判失效（非 HTTP 状态码）；
 * - **single-flight**（FR-1.6）：重登期间并发请求共享同一登录 Promise，绝不并发开多浏览器。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { launch } from 'cloakbrowser';
import axios from 'axios';
import { recognizeCaptcha } from './captcha.js';
import { buildHeaders } from './request-util.js';
import { SWPU_LOGIN_URL, SWPU_PROBE_URL, SWPU_LOGIN_SUCCESS_HINT } from './constants.js';
import { randomDelay } from '../../util/delay.js';
import { logger } from '../../logger.js';

/**
 * 由 accountId 派生稳定的指纹种子（10000–99999），保证同账号跨会话指纹一致（回访用户特征）。
 * @param {string} accountId
 * @returns {number}
 */
function deriveFingerprintSeed(accountId) {
  let hash = 5381;
  for (let i = 0; i < accountId.length; i++) {
    hash = ((hash << 5) + hash + accountId.charCodeAt(i)) >>> 0;
  }
  return 10000 + (hash % 90000);
}

export class SwpuSession {
  /**
   * @param {object} opts
   * @param {string} opts.accountId 账号唯一标识（用于持久化文件名 + 指纹种子）
   * @param {import('./credentials.js').SwpuCredentials} opts.credentials 登录凭据
   * @param {string} opts.dataDir 运行态目录（会话落盘于此）
   * @param {boolean} [opts.headless] 登录是否无头（默认有头，反风控更稳；容器内配 Xvfb）
   */
  constructor({ accountId, credentials, dataDir, headless = false }) {
    this.accountId = accountId;
    this.cred = credentials;
    this.headless = headless;
    this.sessionFile = join(dataDir, `swpu-session.${accountId}.json`);
    /** @type {import('../email-provider.js').Session | null} 当前内存会话 */
    this.session = null;
    /** @type {Promise<import('../email-provider.js').Session> | null} single-flight 登录句柄 */
    this.loginPromise = null;
  }

  /** 启动时加载持久化会话（不校验有效性，失效留待首次 HTTP 调用自愈）。 */
  async load() {
    try {
      this.session = JSON.parse(await readFile(this.sessionFile, 'utf8'));
      logger.info({ accountId: this.accountId }, '已加载持久化会话');
    } catch {
      this.session = null;
    }
  }

  /**
   * 获取一个可用会话（不保证服务端仍认）：
   * 1) 内存会话已含 zid → 直接复用（乐观，不每次探针）；
   * 2) 有 cookie 但缺 zid → 纯 HTTP 刷 zid（轻量）；
   * 3) 否则开浏览器登录（single-flight）。
   * @returns {Promise<import('../email-provider.js').Session>}
   */
  async ensureSession() {
    if (this.session?.zid) return this.session;
    if (this.session?.cookies?.length) {
      const zid = await this._refreshZidViaHttp(this.session);
      if (zid) {
        this.session.zid = zid;
        await this._persist();
        logger.info({ accountId: this.accountId }, '纯 HTTP 刷新 zid 成功，免开浏览器');
        return this.session;
      }
    }
    return this.login();
  }

  /**
   * single-flight 登录：并发调用共享同一次登录，绝不并发开多浏览器（FR-1.6）。
   * @returns {Promise<import('../email-provider.js').Session>}
   */
  login() {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this._doLogin().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  /** 标记会话整体失效（HTTP 调用发现 `_login!==1` 时调用），下次 ensureSession 重登。 */
  invalidate() {
    this.session = null;
  }

  /**
   * 登录态探针判定（FR-1.8）：依据**响应体文本**而非 HTTP 状态码——实测未登录仍回 200。
   * @param {unknown} probeBody `?q=base` 的响应体
   * @returns {boolean} true=已登录
   */
  isSessionValid(probeBody) {
    if (typeof probeBody !== 'string' || !probeBody) return false;
    // 失效特征：跳转登录页 / 失效 alert 文案
    if (probeBody.includes('q=login')) return false;
    if (probeBody.includes('您没有登录') || probeBody.includes('登录已经过期')) return false;
    return true;
  }

  /**
   * 用现有 cookie 纯 HTTP 访问 `?q=base`，兼做「登录态探针 + zid 刷新」（FR-1.7/1.8）。
   * @param {import('../email-provider.js').Session} session
   * @returns {Promise<string|null>} 有效 zid，或 null（cookie 也已失效 / 未提到 zid）
   */
  async _refreshZidViaHttp(session) {
    try {
      const { data } = await axios.get(SWPU_PROBE_URL, {
        headers: buildHeaders(session, { Accept: 'text/html,application/xhtml+xml,*/*' }),
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
        responseType: 'text',
      });
      const body = typeof data === 'string' ? data : JSON.stringify(data);
      if (!this.isSessionValid(body)) return null;
      const m = body.match(/gZid\s*=\s*['"]([^'"]+)['"]/);
      return m ? m[1] : null;
    } catch (err) {
      logger.warn({ accountId: this.accountId, err: err.message }, '纯 HTTP 刷 zid 失败');
      return null;
    }
  }

  /**
   * 实际登录：开 CloakBrowser → 渐进表单 + 打码 → 提取 cookies/zid/ua → 持久化 → 关浏览器。
   * @returns {Promise<import('../email-provider.js').Session>}
   */
  async _doLogin() {
    const seed = deriveFingerprintSeed(this.accountId);
    logger.info({ accountId: this.accountId, headless: this.headless }, '开始 CloakBrowser 登录');
    const browser = await launch({
      headless: this.headless,
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      args: [`--fingerprint=${seed}`],
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        colorScheme: 'light',
      });
      const page = await context.newPage();
      await this._fillLoginFormWithRetry(page);

      // 提取全量 cookie + zid + UA（反风控需全量 cookie，NFR-6）
      const cookies = await context.cookies();
      const zid = await page.evaluate(() => window.gZid || null);
      const ua = await page.evaluate(() => navigator.userAgent);
      if (!zid) throw new Error('登录成功但未取到 zid（window.gZid 为空）');

      const session = { cookies, zid, ua, headers: {}, createdAt: Date.now() };
      this.session = session;
      await this._persist();
      logger.info({ accountId: this.accountId }, 'CloakBrowser 登录成功，凭证已落盘');
      return session;
    } finally {
      await browser.close().catch(() => {});
    }
  }

  /**
   * 登录尝试 + 验证码错误重试（最多 3 次）。
   * @param {import('playwright-core').Page} page
   */
  async _fillLoginFormWithRetry(page) {
    const maxAttempts = 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this._loginAttempt(page);
        return;
      } catch (err) {
        lastErr = err;
        // 仅验证码类错误才重试，其余（账号密码错等）直接抛
        if (attempt < maxAttempts && /验证码/.test(err.message)) {
          logger.warn({ accountId: this.accountId, attempt }, '验证码错误，重试登录');
          await randomDelay(2000, 3000);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  /**
   * 单次登录尝试：复刻 SWPU 渐进式表单顺序（账号→失焦触发密码→触发验证码→打码→提交）。
   * @param {import('playwright-core').Page} page
   */
  async _loginAttempt(page) {
    await page.goto(SWPU_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(2000, 3000);

    // 账号
    await page.locator('#user').click();
    await randomDelay(300, 600);
    await page.locator('#user').fill(this.cred.loginUser);
    await randomDelay(500, 1000);

    // 点验证码框使账号失焦 → 密码框出现
    await page.locator('#div_auth_code').click();
    await randomDelay(1000, 1500);
    await page.waitForSelector('#common_password', { state: 'visible', timeout: 5000 });

    // 密码
    await page.locator('#common_password').click();
    await randomDelay(300, 600);
    await page.locator('#common_password').fill(this.cred.pass);
    await randomDelay(1000, 1500);

    // 再点验证码框 → 验证码图片出现
    await page.locator('#div_auth_code').click();
    await randomDelay(500, 1000);
    await page.waitForSelector('#auth_code_img', { state: 'visible', timeout: 5000 });

    // 取图打码并填入
    const base64 = await this._captchaBase64(page);
    const code = await recognizeCaptcha(base64);
    await page.locator('#div_auth_code').fill(code);
    await randomDelay(1000, 1500);

    // 提交并判定
    await page.locator('#mfa_form_login_submit').click();
    await randomDelay(3000, 5000);
    const url = page.url();
    if (url !== SWPU_LOGIN_URL && url.includes(SWPU_LOGIN_SUCCESS_HINT)) return;

    const msg = await page
      .locator('#msg')
      .textContent()
      .catch(() => null);
    throw new Error(msg ? `登录失败：${msg.trim()}` : '登录失败，未知原因');
  }

  /**
   * 把页面上已显示的验证码图片转 base64（canvas，去掉 data 前缀）。
   * @param {import('playwright-core').Page} page
   * @returns {Promise<string>}
   */
  async _captchaBase64(page) {
    return page.evaluate(() => {
      const img = document.querySelector('#auth_code_img img');
      if (!img) throw new Error('未找到验证码图片元素');
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    });
  }

  /** 会话落盘（NFR-1：文件含 cookie，须在 .gitignore 内，不入库）。 */
  async _persist() {
    await mkdir(dirname(this.sessionFile), { recursive: true });
    await writeFile(this.sessionFile, JSON.stringify(this.session), 'utf8');
  }
}

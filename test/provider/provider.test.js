import { describe, it, expect, afterEach } from 'vitest';
import { assertEmailProvider } from '../../src/provider/email-provider.js';
import { swpuCapabilities } from '../../src/provider/swpu/capabilities.js';
import { cookieHeader, buildHeaders } from '../../src/provider/swpu/request-util.js';
import { resolveSwpuCredentials } from '../../src/provider/swpu/credentials.js';
import { SwpuSession } from '../../src/provider/swpu/session.js';

/** 一个最小的合法 EmailProvider 实现（方法体留空，仅校验形状） */
function makeValidProvider() {
  return {
    accountId: 'a',
    domain: 'swpu.edu.cn',
    group: 'swpu',
    capabilities() {},
    login() {},
    isSessionValid() {},
    ensureSession() {},
    getCurrentAlias() {},
    setAlias() {},
    subscribeMail() {},
    cleanup() {},
  };
}

describe('M2 assertEmailProvider 接口校验', () => {
  it('完整实现通过', () => {
    expect(() => assertEmailProvider(makeValidProvider())).not.toThrow();
  });
  it('缺方法 → 抛错并点名', () => {
    const p = makeValidProvider();
    delete p.setAlias;
    expect(() => assertEmailProvider(p)).toThrow(/setAlias/);
  });
  it('缺属性 → 抛错并点名', () => {
    const p = makeValidProvider();
    delete p.accountId;
    expect(() => assertEmailProvider(p)).toThrow(/accountId/);
  });
  it('非对象 → 抛错', () => {
    expect(() => assertEmailProvider(null)).toThrow();
  });
});

describe('M2 swpuCapabilities 能力声明', () => {
  it('imap 通道 + 支持删信 + swpu 域 + 默认正则可用', () => {
    const caps = swpuCapabilities();
    expect(caps.receiveChannel).toBe('imap');
    expect(caps.supportsImapDelete).toBe(true);
    expect(caps.aliasRule.domain).toBe('swpu.edu.cn');
    expect('code 1234'.match(caps.codeRegex)?.[1]).toBe('1234');
  });
});

describe('M2 request-util L1 拟真头', () => {
  it('cookieHeader 全量拼接', () => {
    expect(
      cookieHeader([
        { name: 'a', value: '1' },
        { name: 'b', value: '2' },
      ]),
    ).toBe('a=1; b=2');
    expect(cookieHeader([])).toBe('');
  });
  it('buildHeaders 含 UA/Cookie/拟真头，登录头作基础、extra 覆盖', () => {
    const h = buildHeaders(
      { ua: 'UA-X', cookies: [{ name: 'k', value: 'v' }], headers: { 'sec-ch-ua': 'chip' } },
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    );
    expect(h['User-Agent']).toBe('UA-X');
    expect(h.Cookie).toBe('k=v');
    expect(h['X-Requested-With']).toBe('XMLHttpRequest');
    expect(h.Origin).toBe('https://mail.swpu.edu.cn');
    expect(h['sec-ch-ua']).toBe('chip'); // 登录时抓的环境头被带上
    expect(h['Content-Type']).toBe('application/x-www-form-urlencoded'); // extra 覆盖
  });
});

describe('M2 resolveSwpuCredentials 凭据解析', () => {
  const KEYS = ['SWPU_T_NAME', 'SWPU_T_PASS', 'SWPU_T_IMAP_PASS', 'SWPU_T_GROUP'];
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it('NAME 不含 @ → 按域名补全完整邮箱；GROUP 缺省为 swpu', () => {
    process.env.SWPU_T_NAME = 'tester';
    process.env.SWPU_T_PASS = 'pw';
    process.env.SWPU_T_IMAP_PASS = 'ipw';
    const c = resolveSwpuCredentials('SWPU_T');
    expect(c.loginUser).toBe('tester');
    expect(c.email).toBe('tester@swpu.edu.cn');
    expect(c.group).toBe('swpu');
  });

  it('NAME 含 @ → 直接作完整邮箱', () => {
    process.env.SWPU_T_NAME = 'foo@swpu.edu.cn';
    process.env.SWPU_T_PASS = 'pw';
    process.env.SWPU_T_IMAP_PASS = 'ipw';
    expect(resolveSwpuCredentials('SWPU_T').email).toBe('foo@swpu.edu.cn');
  });

  it('缺必填键 → 抛错（fail-fast）', () => {
    expect(() => resolveSwpuCredentials('SWPU_NOPE')).toThrow();
  });
});

describe('M2 SwpuSession.isSessionValid 探针文本判定（FR-1.8）', () => {
  // 构造不做 IO，可安全实例化；isSessionValid 不依赖实例状态
  const sess = new SwpuSession({ accountId: 't', credentials: {}, dataDir: './data' });

  it('含 q=login 跳转 → 失效', () => {
    expect(sess.isSessionValid('window.location="/user/?q=login&furl=x"')).toBe(false);
  });
  it('含失效 alert 文案 → 失效', () => {
    expect(sess.isSessionValid('alert("您没有登录，或者登录已经过期，请重新登录。")')).toBe(false);
  });
  it('正常邮箱页（含 gZid）→ 有效', () => {
    expect(sess.isSessionValid('<script>window.gZid="abc123"</script>')).toBe(true);
  });
  it('非字符串 → 失效', () => {
    expect(sess.isSessionValid(null)).toBe(false);
    expect(sess.isSessionValid(undefined)).toBe(false);
  });
});

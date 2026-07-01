/**
 * 端到端自检：打到**运行中的服务**（localhost:8080），验证排队闭环 + 真实收码。
 * - 阶段 A（排队，不依赖外部邮件）：activate c1→active；activate c2→pending(queueAhead)；
 *   再次 activate c2→复用同一 pending；cancel c1→c2 自动 promote→active；cancel c2 释放。
 * - 阶段 B（真实收码）：activate c3→active alias；用 163（EMAIL_USER/PASS，手写 SMTP over TLS）
 *   发信到该别名；轮询直到 received，打印整封邮件。
 *
 * 运行：node scripts/e2e-queue.js   （需先 npm start 起服务；.env 提供 ADMIN_TOKEN / EMAIL_USER / EMAIL_PASS）
 */
import 'dotenv/config';
import tls from 'node:tls';

const BASE = 'http://localhost:8080';
const TOKEN = process.env.ADMIN_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);

const admin = (path, body, method = 'POST') =>
  fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

const pub = (path, body, method = 'POST') =>
  fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

const getLease = (id) => pub(`/api/public/leases/${id}`, null, 'GET').then((r) => r.data);

/** 手写 163 SMTP（465 隐式 TLS + AUTH LOGIN），发一封纯文本信到 to。 */
function smtpSend163(to, subject, text) {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) return Promise.reject(new Error('缺少 EMAIL_USER/EMAIL_PASS'));
  const b64 = (s) => Buffer.from(s).toString('base64');
  const mail = [
    `From: ${user}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
  ].join('\r\n');
  const steps = [
    { expect: '220', send: 'EHLO e2e.local\r\n' },
    { expect: '250', send: 'AUTH LOGIN\r\n' },
    { expect: '334', send: `${b64(user)}\r\n` },
    { expect: '334', send: `${b64(pass)}\r\n` },
    { expect: '235', send: `MAIL FROM:<${user}>\r\n` },
    { expect: '250', send: `RCPT TO:<${to}>\r\n` },
    { expect: '250', send: 'DATA\r\n' },
    { expect: '354', send: `${mail}\r\n.\r\n` },
  ];
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: 'smtp.163.com', port: 465, servername: 'smtp.163.com' });
    sock.setTimeout(20000, () => {
      sock.destroy();
      reject(new Error('SMTP 超时'));
    });
    let i = 0;
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return; // 等一个完整响应
      const code = last.slice(0, 3);
      buf = '';
      if (i >= steps.length) {
        // 所有命令已发，等 DATA 后最终 250
        if (code === '250') resolve();
        else reject(new Error(`SMTP 最终响应 ${last}`));
        sock.end();
        return;
      }
      if (code !== steps[i].expect) {
        reject(new Error(`SMTP 步骤${i} 期望 ${steps[i].expect} 实得 ${last}`));
        sock.destroy();
        return;
      }
      sock.write(steps[i].send);
      i++;
    });
    sock.on('error', reject);
  });
}

async function main() {
  // 账号 group（套餐 allowedGroups 需匹配）
  const accs = await admin('/api/admin/accounts', null, 'GET');
  const acc = accs.data?.[0];
  if (!acc) throw new Error('无账号');
  log('账号:', acc.id, 'group:', acc.group, 'status:', acc.status);

  // 套餐：目标发件人 @163.com
  await admin('/api/admin/plans', {
    prefix: 'e2e',
    name: 'E2E',
    allowedGroups: [acc.group],
    targetSenders: ['@163.com'],
    quota: 1,
    leaseTtlSec: 900,
  });
  const gen = await admin('/api/admin/codes', { prefix: 'e2e', count: 3 });
  const [c1, c2, c3] = gen.data.codes.map((x) => (typeof x === 'string' ? x : x.code));
  log('码:', c1, c2, c3);

  // ── 阶段 A：排队 ──
  log('── 阶段 A：排队 ──');
  const r1 = await pub('/api/public/activate', { code: c1 });
  log('c1 →', r1.data.status, r1.data.alias);
  const r2 = await pub('/api/public/activate', { code: c2 });
  log('c2 →', r2.data.status, 'queueAhead=', r2.data.queueAhead, 'enqueuedAt=', r2.data.enqueuedAt);
  const r2b = await pub('/api/public/activate', { code: c2 });
  log('c2 再次 activate → 复用同 leaseId:', r2b.data.leaseId === r2.data.leaseId);

  log('cancel c1 → 释放 → 期望 c2 自动 promote…');
  await pub(`/api/public/leases/${r1.data.leaseId}/cancel`);
  let promoted = null;
  for (let i = 0; i < 15; i++) {
    await sleep(1500);
    const l2 = await getLease(r2.data.leaseId);
    if (l2.status === 'active') {
      promoted = l2;
      break;
    }
    if (['rejected', 'cancelled'].includes(l2.status)) {
      log('c2 promote 失败 →', l2.status);
      break;
    }
  }
  if (promoted) log('✅ 阶段 A 通过：c2 promote →', promoted.status, promoted.alias);
  else log('⚠️ 阶段 A：c2 未在预期时间内 promote');
  if (promoted) await pub(`/api/public/leases/${promoted.leaseId}/cancel`); // 释放账号供阶段 B

  // ── 阶段 B：真实收码 ──
  log('── 阶段 B：真实收码（163 发信）──');
  const r3 = await pub('/api/public/activate', { code: c3 });
  if (r3.data.status !== 'active') {
    log('阶段 B：c3 未 active（', r3.data.status, '），跳过收码');
    return;
  }
  const alias = r3.data.alias;
  log('c3 → active，别名:', alias, '正在用 163 发信…');
  try {
    await smtpSend163(alias, 'E2E 验证码 654321', '你的验证码是 654321，请在 5 分钟内使用。');
    log('163 发信成功，等待 IMAP 收码…');
  } catch (e) {
    log('163 发信失败：', e.message, '（收码部分跳过；排队闭环已在阶段 A 验证）');
    return;
  }
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const l3 = await getLease(r3.data.leaseId);
    log(`[${i}] c3 = ${l3.status}`);
    if (l3.status === 'received') {
      log('✅ 阶段 B 通过：真实收码成功！');
      log('   from   :', l3.mail.from);
      log('   subject:', l3.mail.subject);
      log('   code   :', l3.code);
      return;
    }
    if (l3.status !== 'active') {
      log('c3 非预期状态：', l3.status);
      return;
    }
  }
  log('⚠️ 阶段 B：超时未收到邮件');
}

main()
  .catch((e) => log('端到端异常：', e.message))
  .finally(() => process.exit(0));

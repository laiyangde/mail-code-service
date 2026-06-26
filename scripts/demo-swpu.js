/**
 * 单账号 SWPU Provider 端到端 demo（M2 验收，基座 §8）：
 *   设别名（HTTP）→ 订阅收码（IMAP）→ 打印整封邮件 → 删信（IMAP）。
 *
 * 前置：在 .env 配好 SWPU_ACCT_1_NAME / _PASS / _IMAP_PASS 与 SWPU_CAPTCHA_API_TOKEN，
 * 且当前网络能访问 mailgate.swpu.edu.cn:993（校园网 / VPN / 代理）。
 *
 * 用法：
 *   node scripts/demo-swpu.js [别名前缀] [发件人规则] [收码等待秒数]
 *   node scripts/demo-swpu.js mytest123 @github.com 300
 */
import { createSwpuProvider } from '../src/provider/swpu/index.js';

async function main() {
  const aliasBase = process.argv[2] || `demo${Date.now().toString().slice(-6)}`;
  const sender = process.argv[3] || '@github.com';
  const waitSec = Number(process.argv[4] || 300);

  const provider = createSwpuProvider({
    accountId: 'demo-1',
    credsRef: 'SWPU_ACCT_1',
    headless: false,
  });

  console.log('== 0. 加载持久化会话（命中则免开浏览器）==');
  await provider.loadSession();

  console.log('== 1. 启动 IMAP 常驻连接 ==');
  await provider.startReceiver();

  console.log('== 2. 设置别名 ==');
  const since = Math.floor(Date.now() / 1000); // 收码时间窗起点
  const { ok, finalAlias } = await provider.setAlias(aliasBase);
  if (!ok) throw new Error('设置别名失败');
  const address = `${finalAlias}@swpu.edu.cn`;
  console.log(`✅ 别名已设为：${address}\n   → 去目标平台用此地址注册，等待验证码邮件...`);

  console.log(`== 3. 订阅收码（最多等待 ${waitSec}s）==`);
  const match = { to: address, fromSenders: [sender], since };
  const mail = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`收码超时（${waitSec}s 未收到匹配邮件）`));
    }, waitSec * 1000);
    const unsub = provider.subscribeMail(match, (m) => {
      clearTimeout(timer);
      unsub();
      resolve(m);
    });
  });

  console.log('✅ 收到整封邮件：');
  console.log(`   发件人：${mail.from}`);
  console.log(`   主题  ：${mail.subject}`);
  console.log(`   时间  ：${new Date(mail.date * 1000).toLocaleString('zh-CN')}`);
  console.log(`   正文  ：${(mail.text || '').replace(/\s+/g, ' ').slice(0, 200)}`);

  console.log('== 4. 删信（删已读）==');
  const { deleted } = await provider.cleanup({ seen: true });
  console.log(`✅ 删除 ${deleted} 封已读邮件`);

  await provider.stopReceiver();
  console.log('\n🎉 demo 全链路完成');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ demo 失败：', err.message);
  process.exit(1);
});

/**
 * 整封邮件展示（M7 / FR-4.3、FR-6.3）：服务端交付整封邮件，前端原样展示。验证码高光卡。
 *
 * 安全（不变的红线）：`mail.html` 来自第三方发件人，**严禁 innerHTML 直插**。HTML 用
 * `<iframe sandbox srcDoc>`（不含 allow-scripts）隔离渲染，杜绝脚本执行（XSS 防护）。
 * 默认优先纯文本；`code` 为后端尽力提取的便利字段，可能为 null（FR-4）。
 */
import { useState } from 'react';
import { Card, Descriptions, Tabs, Typography } from 'antd';

const { Text, Paragraph } = Typography;

/** 尽力把日期格式化为本地时间，失败返回原值 */
function fmtDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? String(date) : d.toLocaleString('zh-CN');
}

/**
 * @param {object} props
 * @param {object} props.mail `{from,to,subject,date,text,html}`
 * @param {string|null} [props.code] 便利提取的验证码
 */
export default function MailView({ mail, code }) {
  const hasHtml = Boolean(mail?.html);
  const hasText = Boolean(mail?.text);
  // 默认纯文本；无文本但有 HTML 时默认 HTML
  const [tab, setTab] = useState(hasText ? 'text' : 'html');

  const textBody = <div className="mcs-mailbody">{mail.text || '(无正文)'}</div>;

  const htmlBody = (
    // sandbox 空值：禁脚本/表单/同源，仅渲染静态富文本（XSS 隔离）
    <iframe
      className="mcs-mailframe"
      sandbox=""
      referrerPolicy="no-referrer"
      title="邮件内容"
      srcDoc={mail.html}
    />
  );

  const tabItems = [];
  if (hasText) tabItems.push({ key: 'text', label: '纯文本', children: textBody });
  if (hasHtml) tabItems.push({ key: 'html', label: 'HTML', children: htmlBody });

  return (
    <div className="mcs-mail">
      {code ? (
        <div className="mcs-otp">
          <div className="mcs-otp__label">验证码</div>
          <div className="mcs-otp__row">
            <span className="mcs-otp__digits mcs-mono">{code}</span>
            <Text className="mcs-otp__copy" copyable={{ text: code }} />
          </div>
          <div className="mcs-otp__hint">已自动识别 · 点击右侧图标复制</div>
        </div>
      ) : (
        <Paragraph type="secondary" className="mcs-hint">
          未自动识别到验证码，请从下方邮件内容中查看验证码或激活链接。
        </Paragraph>
      )}

      <Card size="small" className="mcs-mailcard" title={mail.subject || '(无主题)'}>
        <Descriptions
          size="small"
          column={1}
          items={[
            { key: 'from', label: '发件人', children: mail.from || '-' },
            { key: 'to', label: '收件人', children: mail.to || '-' },
            { key: 'date', label: '时间', children: fmtDate(mail.date) },
          ]}
        />
        {tabItems.length > 1 ? (
          <Tabs activeKey={tab} onChange={setTab} items={tabItems} style={{ marginTop: 8 }} />
        ) : (
          <div style={{ marginTop: 8 }}>{tabItems[0]?.children}</div>
        )}
      </Card>

      {hasText && (
        <Paragraph className="mcs-copyrow">
          <Text copyable={{ text: mail.text }} type="secondary">
            复制邮件正文
          </Text>
        </Paragraph>
      )}
    </div>
  );
}

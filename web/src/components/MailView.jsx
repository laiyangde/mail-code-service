/**
 * 整封邮件展示（M7 / FR-4.3、FR-6.3）：服务端交付整封邮件，前端原样展示。
 *
 * 安全：`mail.html` 来自第三方发件人，**严禁 innerHTML 直插**。HTML 用
 * `<iframe sandbox srcdoc>`（不含 allow-scripts）隔离渲染，杜绝脚本执行（XSS 防护）。
 * 默认优先纯文本，提供切换。`code` 为后端尽力提取的便利字段，可能为 null（FR-4）。
 */
import { useState } from 'react';
import CopyButton from './CopyButton.jsx';

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

  return (
    <div>
      {code ? (
        <div className="code-highlight">
          <span className="val">{code}</span>
          <CopyButton text={code} label="复制验证码" />
        </div>
      ) : (
        <p className="hint mt-sm">未自动识别到验证码，请从下方邮件内容中查看验证码或激活链接。</p>
      )}

      <div className="mail mt">
        <div className="mail-head">
          <div className="mail-subject">{mail.subject || '(无主题)'}</div>
          <div className="mail-row">
            <span className="mail-label">发件人</span>
            <span className="mail-value">{mail.from || '-'}</span>
          </div>
          <div className="mail-row">
            <span className="mail-label">收件人</span>
            <span className="mail-value">{mail.to || '-'}</span>
          </div>
          <div className="mail-row">
            <span className="mail-label">时间</span>
            <span className="mail-value">{fmtDate(mail.date)}</span>
          </div>
        </div>

        {hasHtml && hasText && (
          <div className="mail-tabs">
            <span
              className={`tab ${tab === 'text' ? 'active' : ''}`}
              onClick={() => setTab('text')}
            >
              纯文本
            </span>
            <span
              className={`tab ${tab === 'html' ? 'active' : ''}`}
              onClick={() => setTab('html')}
            >
              HTML
            </span>
          </div>
        )}

        {tab === 'html' && hasHtml ? (
          // sandbox 空值：禁脚本/表单/同源，仅渲染静态富文本（XSS 隔离）
          <iframe
            className="mail-iframe"
            sandbox=""
            referrerPolicy="no-referrer"
            title="邮件内容"
            srcDoc={mail.html}
          />
        ) : (
          <div className="mail-body">{mail.text || '(无正文)'}</div>
        )}
      </div>

      {hasText && (
        <div className="row mt-sm">
          <CopyButton text={mail.text} label="复制邮件正文" />
        </div>
      )}
    </div>
  );
}

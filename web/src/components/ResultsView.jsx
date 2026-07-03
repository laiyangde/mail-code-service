/**
 * 收码结果回看（M7 / FR-6.9）：`used` 态唯一码在保留期内只读展示历史整封邮件，
 * 并显示距 `retainUntil` 的剩余保留时间。不新建租约、不消费配额（后端保证）。
 */
import { Typography } from 'antd';
import MailView from './MailView.jsx';

const { Title, Paragraph } = Typography;

/** 把毫秒差格式化为「N 天 N 小时」/「N 小时 N 分钟」 */
function fmtRemain(ms) {
  if (ms <= 0) return '已到期';
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${mins} 分钟`;
  return `${mins} 分钟`;
}

/**
 * @param {object} props
 * @param {object[]} props.results `[{alias,from,to,subject,date,text,html,code?}]`
 * @param {number|null} [props.retainUntil] 回看截止时间戳（ms）
 */
export default function ResultsView({ results, retainUntil }) {
  const remain = retainUntil ? retainUntil - Date.now() : 0;
  return (
    <div className="mcs-fade-in">
      <Title level={4} className="mcs-h">
        已收到的邮件
      </Title>
      <Paragraph type="secondary" className="mcs-lead">
        该卡密已完成收码，以下为历史邮件（只读）。
      </Paragraph>

      {results.length === 0 && (
        <Paragraph type="secondary" className="mcs-hint">
          暂无收码记录。
        </Paragraph>
      )}
      {results.map((r, i) => (
        <div key={i} className="mcs-result-item">
          <MailView mail={r} code={r.code ?? null} />
        </div>
      ))}

      {retainUntil && <div className="mcs-retain">保留期剩余 · {fmtRemain(remain)}</div>}
    </div>
  );
}

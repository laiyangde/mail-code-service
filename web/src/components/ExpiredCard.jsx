/**
 * 超时/释放卡（M7 / FR-6.5）：邮箱未收到邮件即超时或被取消时展示，
 * 提供「重新获取邮箱」（renew）。renew 受后端 maxRenews 限制，超限返回 RENEW_LIMIT。
 * 自绘居中结果版式（图标 + 标题 + 说明 + CTA），契合玻璃卡质感。
 */
import { Button } from 'antd';

/**
 * @param {object} props
 * @param {'expired'|'cancelled'} props.status 终态
 * @param {boolean} props.loading renew 进行中
 * @param {() => void} props.onRenew 重新获取
 */
export default function ExpiredCard({ status, loading, onRenew }) {
  const cancelled = status === 'cancelled';
  return (
    <div className="mcs-fade-in mcs-outcome">
      <span className="mcs-outcome__icon mcs-outcome__icon--warn" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 7.4 V12 L15 14"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <div className="mcs-outcome__title">{cancelled ? '已释放邮箱' : '等待超时'}</div>
      <div className="mcs-outcome__sub">你的卡密尚未消费，可重新获取一个邮箱再次尝试接收邮件。</div>
      <Button
        type="primary"
        size="large"
        loading={loading}
        onClick={onRenew}
        className="mcs-cta mcs-cta--inline"
      >
        重新获取邮箱
      </Button>
    </div>
  );
}

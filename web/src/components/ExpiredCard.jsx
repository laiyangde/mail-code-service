/**
 * 超时/释放卡（M7 / FR-6.5）：邮箱未收到邮件即超时或被取消时展示，
 * 提供「重新获取邮箱」（renew）。renew 受后端 maxRenews 限制，超限返回 RENEW_LIMIT。
 */

/**
 * @param {object} props
 * @param {'expired'|'cancelled'} props.status 终态
 * @param {boolean} props.loading renew 进行中
 * @param {() => void} props.onRenew 重新获取
 */
export default function ExpiredCard({ status, loading, onRenew }) {
  const cancelled = status === 'cancelled';
  return (
    <div>
      <div className="banner banner-warn">
        {cancelled ? '本次邮箱已释放。' : '本次邮箱已超时，未收到邮件。'}
      </div>
      <h1 className="title">{cancelled ? '已释放邮箱' : '等待超时'}</h1>
      <p className="subtitle">你的唯一码尚未消费，可重新获取一个邮箱再次尝试接收邮件。</p>
      <button
        type="button"
        className="btn btn-primary btn-block mt"
        disabled={loading}
        onClick={onRenew}
      >
        {loading ? '重新申请中…' : '重新获取邮箱'}
      </button>
    </div>
  );
}

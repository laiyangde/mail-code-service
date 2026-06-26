/**
 * 进行中卡（M7 / FR-6.2）：展示别名（一键复制）、套餐说明、15min 倒计时、状态条。
 * `pending`（排队，首版极少触发）显示排队提示，无别名/倒计时。
 */
import CopyButton from './CopyButton.jsx';
import { useCountdown } from '../hooks/useCountdown.js';

/** 状态条三步：申请 → 等待邮件 → 已收到 */
function StatusBar({ status }) {
  const stepClass = (idx) => {
    // idx: 0 申请, 1 等待邮件, 2 已收到
    if (status === 'pending') return idx === 0 ? 'active' : '';
    if (status === 'active') {
      if (idx === 0) return 'done';
      if (idx === 1) return 'active';
      return '';
    }
    return ''; // received 由 MailView 接管，不在此渲染
  };
  return (
    <div className="statusbar">
      <div className={`status-step ${stepClass(0)}`}>申请邮箱</div>
      <div className={`status-step ${stepClass(1)}`}>等待邮件</div>
      <div className={`status-step ${stepClass(2)}`}>收到邮件</div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.lease `{alias, expiresAt, plan, status}`
 * @param {() => void} [props.onCancel] 提前释放
 */
export default function ActiveCard({ lease, onCancel }) {
  const { mmss, remainMs, over } = useCountdown(lease.expiresAt);
  const isPending = lease.status === 'pending';

  if (isPending) {
    return (
      <div>
        <h1 className="title">正在排队</h1>
        <p className="subtitle">邮箱资源暂时占满，正在为你排队，请稍候…</p>
        <div className="loading mt">
          <span className="spinner" />
          <span>等待空闲邮箱</span>
        </div>
        <StatusBar status="pending" />
      </div>
    );
  }

  const cdClass = over ? 'over' : remainMs <= 60_000 ? 'warn' : '';

  return (
    <div>
      <h1 className="title">邮箱已就绪</h1>
      <p className="subtitle">
        请将下面的邮箱地址填入目标平台（套餐：<span className="code-chip">{lease.plan}</span>），
        发来的邮件会自动显示在本页面。
      </p>

      <div className="field-label">你的临时邮箱</div>
      <div className="alias-box">
        <span className="alias-text">{lease.alias}</span>
        <CopyButton text={lease.alias} />
      </div>

      <div className="field-label mt-sm">剩余等待时间</div>
      <div className={`countdown ${cdClass}`}>{over ? '已超时' : mmss}</div>

      <StatusBar status="active" />

      <div className="loading mt-sm">
        <span className="spinner" />
        <span>正在实时监听新邮件…</span>
      </div>

      {onCancel && (
        <button type="button" className="btn btn-block mt" onClick={onCancel}>
          放弃并释放邮箱
        </button>
      )}
    </div>
  );
}

/**
 * 错误卡（M7 / FR-6.4）：按错误码展示中文文案与可操作项。自绘居中结果版式。
 * POOL_BUSY（池满）等可重试错误显示重试按钮。
 */
import { Button } from 'antd';
import { errorText } from '../errorText.js';

/** 可重试的错误码 */
const RETRYABLE = new Set(['POOL_BUSY', 'NETWORK', 'INTERNAL']);

/**
 * @param {object} props
 * @param {string} props.errCode 错误码
 * @param {string} [props.errMsg] 后端原始描述
 * @param {boolean} [props.loading] 重试进行中
 * @param {() => void} [props.onRetry] 重试回调
 */
export default function ErrorCard({ errCode, errMsg, loading, onRetry }) {
  const { title, hint, kind } = errorText(errCode, errMsg);
  const retryable = RETRYABLE.has(errCode) && onRetry;
  const warn = kind === 'warn';
  return (
    <div className="mcs-fade-in mcs-outcome">
      <span
        className={`mcs-outcome__icon ${warn ? 'mcs-outcome__icon--warn' : 'mcs-outcome__icon--danger'}`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 7.6 V12.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          <circle cx="12" cy="16.2" r="0.95" fill="currentColor" />
        </svg>
      </span>
      <div className="mcs-outcome__title">{title}</div>
      <div className="mcs-outcome__sub">{hint}</div>
      {retryable && (
        <Button
          type="primary"
          size="large"
          loading={loading}
          onClick={onRetry}
          className="mcs-cta mcs-cta--inline"
        >
          重试
        </Button>
      )}
    </div>
  );
}

/**
 * 错误卡（M7 / FR-6.4）：按错误码展示中文文案与可操作项。
 * POOL_BUSY（池满）等可重试错误显示重试按钮。
 */
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
  return (
    <div>
      <div className={`banner ${kind === 'warn' ? 'banner-warn' : 'banner-error'}`}>{hint}</div>
      <h1 className="title">{title}</h1>
      {retryable && (
        <button
          type="button"
          className="btn btn-primary btn-block mt"
          disabled={loading}
          onClick={onRetry}
        >
          {loading ? '重试中…' : '重试'}
        </button>
      )}
    </div>
  );
}

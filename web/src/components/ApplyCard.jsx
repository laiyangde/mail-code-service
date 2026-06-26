/**
 * 初始申请卡（M7 / FR-6.1）：仅预填唯一码，用户点「申请邮箱」才占用账号
 * （避免链接被分享/预览时白白占用稀缺账号）。
 */
import CopyButton from './CopyButton.jsx';

/**
 * @param {object} props
 * @param {string} props.code 唯一码
 * @param {boolean} props.loading 是否申请中
 * @param {() => void} props.onApply 点击申请
 */
export default function ApplyCard({ code, loading, onApply }) {
  return (
    <div>
      <h1 className="title">申请一次性邮箱</h1>
      <p className="subtitle">用于在目标平台接收验证码 / 激活邮件。</p>

      <div className="field-label">你的唯一码</div>
      <div className="alias-box">
        <span className="alias-text">{code}</span>
        <CopyButton text={code} />
      </div>

      <button
        type="button"
        className="btn btn-primary btn-block mt"
        disabled={loading}
        onClick={onApply}
      >
        {loading ? '申请中…' : '申请邮箱'}
      </button>
      <p className="hint mt-sm">申请后将为你分配一个邮箱地址，并在 15 分钟内实时接收发来的邮件。</p>
    </div>
  );
}

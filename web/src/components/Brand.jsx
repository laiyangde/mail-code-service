/**
 * 品牌标识（取码页头部 / Admin Header 复用）。纯展示组件，无业务逻辑。
 * 发光信封徽标 + 「邮箱接码」字标，徽标内的绿色脉冲点呼应产品核心「实时收码」。
 *
 * @param {object} props
 * @param {'sm'|'md'|'lg'} [props.size] 尺寸档位
 * @param {boolean} [props.sub] 是否显示英文副标（hero 场景用）
 * @param {string} [props.className] 追加类名
 */
export default function Brand({ size = 'md', sub = false, className = '' }) {
  return (
    <div className={`mcs-brand mcs-brand--${size} ${className}`.trim()}>
      <span className="mcs-brand__mark" aria-hidden="true">
        <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* 信封主体 */}
          <rect
            x="3"
            y="6.5"
            width="22"
            height="15"
            rx="3.6"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          {/* 信封翻盖 */}
          <path
            d="M4.6 8.6 L14 15 L23.4 8.6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* 收码脉冲点（实时接收隐喻） */}
          <circle className="mcs-brand__pulse" cx="14" cy="14" r="1.7" />
        </svg>
      </span>
      <span className="mcs-brand__text">
        <span className="mcs-brand__name">邮箱接码</span>
        {sub && <span className="mcs-brand__sub">MAILCODE · 实时收码</span>}
      </span>
    </div>
  );
}

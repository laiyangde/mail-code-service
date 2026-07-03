/**
 * 初始申请卡（M7 / FR-6.1）：仅预填唯一码，用户点「申请邮箱」才占用账号
 * （避免链接被分享/预览时白白占用稀缺账号）。等宽码块 + 辉光主 CTA。
 */
import { Button, Typography } from 'antd';

const { Title, Paragraph, Text } = Typography;

/**
 * @param {object} props
 * @param {string} props.code 唯一码
 * @param {boolean} props.loading 是否申请中
 * @param {() => void} props.onApply 点击申请
 */
export default function ApplyCard({ code, loading, onApply }) {
  return (
    <div className="mcs-fade-in">
      <Title level={4} className="mcs-h">
        申请一次性邮箱
      </Title>
      <Paragraph type="secondary" className="mcs-lead">
        用于在目标平台接收验证码 / 激活邮件，分配后 15 分钟内实时到达。
      </Paragraph>

      <div className="mcs-field-label">你的卡密</div>
      <div className="mcs-codechip">
        <span className="mcs-codechip__text mcs-mono">{code}</span>
        <Text className="mcs-codechip__copy" copyable={{ text: code }} />
      </div>

      <Button
        type="primary"
        block
        size="large"
        loading={loading}
        onClick={onApply}
        className="mcs-cta"
      >
        申请邮箱
      </Button>
      <div className="mcs-hint">申请后将为你分配一个专属邮箱地址，并实时接收发来的邮件。</div>
    </div>
  );
}

/**
 * 初始申请卡（M7 / FR-6.1）：仅预填唯一码，用户点「申请邮箱」才占用账号
 * （避免链接被分享/预览时白白占用稀缺账号）。antd 版。
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
    <>
      <Title level={4} style={{ marginTop: 0 }}>
        申请一次性邮箱
      </Title>
      <Paragraph type="secondary">用于在目标平台接收验证码 / 激活邮件。</Paragraph>

      <Text type="secondary" style={{ fontSize: 13 }}>
        你的唯一码
      </Text>
      <Paragraph style={{ marginTop: 4 }}>
        <Text code copyable style={{ fontSize: 15 }}>
          {code}
        </Text>
      </Paragraph>

      <Button type="primary" block size="large" loading={loading} onClick={onApply}>
        申请邮箱
      </Button>
      <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 12, marginBottom: 0 }}>
        申请后将为你分配一个邮箱地址，并在 15 分钟内实时接收发来的邮件。
      </Paragraph>
    </>
  );
}

/**
 * 超时/释放卡（M7 / FR-6.5）：邮箱未收到邮件即超时或被取消时展示，
 * 提供「重新获取邮箱」（renew）。renew 受后端 maxRenews 限制，超限返回 RENEW_LIMIT。antd 版。
 */
import { Button, Result } from 'antd';

/**
 * @param {object} props
 * @param {'expired'|'cancelled'} props.status 终态
 * @param {boolean} props.loading renew 进行中
 * @param {() => void} props.onRenew 重新获取
 */
export default function ExpiredCard({ status, loading, onRenew }) {
  const cancelled = status === 'cancelled';
  return (
    <Result
      status="warning"
      title={cancelled ? '已释放邮箱' : '等待超时'}
      subTitle="你的唯一码尚未消费，可重新获取一个邮箱再次尝试接收邮件。"
      extra={
        <Button type="primary" loading={loading} onClick={onRenew}>
          重新获取邮箱
        </Button>
      }
    />
  );
}

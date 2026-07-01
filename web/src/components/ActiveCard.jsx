/**
 * 进行中卡（M7 / FR-6.2）：展示别名（一键复制）、套餐说明、15min 倒计时、状态条。
 * `pending`（排队）显示「前面还有几人」+「已排队时长」+ 放弃排队，无别名/倒计时。antd 版。
 *
 * 倒计时沿用 useCountdown（剩余 ≤60s 变橙、超时变红）；排队计时用 useElapsed（正向累加）。
 */
import { Button, Col, Row, Spin, Statistic, Steps, Typography } from 'antd';
import { useCountdown } from '../hooks/useCountdown.js';
import { useElapsed } from '../hooks/useElapsed.js';

const { Title, Paragraph, Text } = Typography;

/** 状态条三步：申请邮箱 → 等待邮件 → 收到邮件 */
const STEP_ITEMS = [{ title: '申请邮箱' }, { title: '等待邮件' }, { title: '收到邮件' }];

/**
 * @param {object} props
 * @param {object} props.lease `{alias, expiresAt, plan, status, receiving?, queueAhead?, enqueuedAt?}`
 * @param {() => void} [props.onCancel] 提前释放 / 放弃排队
 * @param {() => void} [props.onConfirm] 确认「我已发送邮件」→ 开始收码
 * @param {boolean} [props.confirming] 确认请求进行中
 */
export default function ActiveCard({ lease, onCancel, onConfirm, confirming }) {
  const { mmss, remainMs, over } = useCountdown(lease.expiresAt);
  const { mmss: waited } = useElapsed(lease.enqueuedAt);
  const isPending = lease.status === 'pending';

  if (isPending) {
    const ahead = lease.queueAhead ?? 0;
    return (
      <>
        <Title level={4} style={{ marginTop: 0 }}>
          正在排队
        </Title>
        <Paragraph type="secondary">
          邮箱资源暂时占满，已为你排队，一有空闲会立即分配并开始收码。
        </Paragraph>

        <Row gutter={16} style={{ margin: '4px 0 16px' }}>
          <Col span={12}>
            <Statistic
              title="前面还有"
              value={ahead}
              suffix="人"
              valueStyle={{ color: '#4f8cff' }}
            />
          </Col>
          <Col span={12}>
            <Statistic
              title="已排队"
              value={waited}
              valueStyle={{ fontVariantNumeric: 'tabular-nums' }}
            />
          </Col>
        </Row>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Spin size="small" />
          <Text type="secondary">
            {ahead === 0 ? '即将轮到你，正在准备邮箱…' : '正在等待空闲邮箱…'}
          </Text>
        </div>
        <Steps size="small" current={0} items={STEP_ITEMS} />

        {onCancel && (
          <Button block style={{ marginTop: 16 }} onClick={onCancel}>
            放弃排队
          </Button>
        )}
      </>
    );
  }

  // 倒计时配色：超时红、最后 1 分钟橙、其余绿
  const cdColor = over ? '#ef5a5a' : remainMs <= 60_000 ? '#f0a73c' : '#36c98a';

  return (
    <>
      <Title level={4} style={{ marginTop: 0 }}>
        邮箱已就绪
      </Title>
      <Paragraph type="secondary">
        请将下面的邮箱地址填入目标平台（套餐 <Text code>{lease.plan}</Text>
        ），发来的邮件会自动显示在本页面。
      </Paragraph>

      <Text type="secondary" style={{ fontSize: 13 }}>
        你的临时邮箱
      </Text>
      <Paragraph style={{ marginTop: 4 }}>
        <Text copyable style={{ fontSize: 16 }}>
          {lease.alias}
        </Text>
      </Paragraph>

      <Text type="secondary" style={{ fontSize: 13 }}>
        剩余等待时间
      </Text>
      <div
        style={{
          textAlign: 'center',
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: 1,
          margin: '6px 0',
          color: cdColor,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {over ? '已超时' : mmss}
      </div>

      <div style={{ margin: '16px 0' }}>
        <Steps size="small" current={lease.receiving ? 1 : 0} items={STEP_ITEMS} />
      </div>

      {lease.receiving ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Spin size="small" />
          <Text type="secondary">正在实时监听新邮件…</Text>
        </div>
      ) : (
        <>
          <Button type="primary" block size="large" loading={confirming} onClick={onConfirm}>
            我已发送邮件
          </Button>
          <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 10, marginBottom: 0 }}>
            请先把上面的邮箱填到目标平台并触发发信，再点此按钮开始接收（点击后才连接邮箱查收）。
          </Paragraph>
        </>
      )}

      {onCancel && (
        <Button block style={{ marginTop: 16 }} onClick={onCancel}>
          放弃并释放邮箱
        </Button>
      )}
    </>
  );
}

/**
 * 进行中卡（M7 / FR-6.2）：展示别名（一键复制）、套餐说明、15min 倒计时、状态条。
 * `pending`（排队）显示「前面还有几人」+「已排队时长」+ 放弃排队，无别名/倒计时（不做 ETA）。
 *
 * 倒计时沿用 useCountdown（剩余 ≤60s 变橙、超时变红，配色改由 CSS 类）；排队计时用 useElapsed（正向累加）。
 */
import { Button, Steps, Typography } from 'antd';
import { useCountdown } from '../hooks/useCountdown.js';
import { useElapsed } from '../hooks/useElapsed.js';

const { Title, Paragraph, Text } = Typography;

/** 状态条三步：申请邮箱 → 等待邮件 → 收到邮件 */
const STEP_ITEMS = [{ title: '申请邮箱' }, { title: '等待邮件' }, { title: '收到邮件' }];

/** 实时监听脉冲行（雷达点 + 文案），排队与收码等待共用 */
function Listening({ children }) {
  return (
    <div className="mcs-listening">
      <span className="mcs-listening__radar" aria-hidden="true" />
      <Text type="secondary">{children}</Text>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.lease `{alias, expiresAt, plan, planName, status, receiving?, queueAhead?, enqueuedAt?}`
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
      <div className="mcs-fade-in">
        <Title level={4} className="mcs-h">
          正在排队
        </Title>
        <Paragraph type="secondary" className="mcs-lead">
          邮箱资源暂时占满，已为你排队，一有空闲会立即分配并开始收码。
        </Paragraph>

        <div className="mcs-queue">
          <div className="mcs-queue__stat">
            <span className="mcs-queue__num mcs-mono">{ahead}</span>
            <span className="mcs-queue__cap">前面还有（人）</span>
          </div>
          <span className="mcs-queue__divider" />
          <div className="mcs-queue__stat">
            <span className="mcs-queue__num mcs-mono">{waited}</span>
            <span className="mcs-queue__cap">已排队</span>
          </div>
        </div>

        <Listening>{ahead === 0 ? '即将轮到你，正在准备邮箱…' : '正在等待空闲邮箱…'}</Listening>

        <Steps className="mcs-steps" size="small" current={0} items={STEP_ITEMS} />

        {onCancel && (
          <Button className="mcs-ghost-btn" block onClick={onCancel}>
            放弃排队
          </Button>
        )}
      </div>
    );
  }

  // 倒计时状态类：超时红、最后 1 分钟橙、其余默认（绿）
  const cdState = over ? 'is-danger' : remainMs <= 60_000 ? 'is-warn' : '';

  return (
    <div className="mcs-fade-in">
      <Title level={4} className="mcs-h">
        邮箱已就绪
      </Title>
      <Paragraph type="secondary" className="mcs-lead">
        请将下面的邮箱地址填入目标平台（{lease.planName || lease.plan}
        ），发来的邮件会自动显示在本页面。
      </Paragraph>

      <div className="mcs-field-label">你的临时邮箱</div>
      <div className="mcs-copyblock">
        <span className="mcs-copyblock__text mcs-mono">{lease.alias}</span>
        <Text className="mcs-copyblock__copy" copyable={{ text: lease.alias }} />
      </div>

      <div className={`mcs-countdown ${cdState}`.trim()}>
        <span className="mcs-countdown__label">剩余等待时间</span>
        <span className="mcs-countdown__time mcs-mono">{over ? '已超时' : mmss}</span>
      </div>

      <Steps
        className="mcs-steps"
        size="small"
        current={lease.receiving ? 1 : 0}
        items={STEP_ITEMS}
      />

      {lease.receiving ? (
        <Listening>正在实时监听新邮件…</Listening>
      ) : (
        <>
          <Button
            type="primary"
            block
            size="large"
            loading={confirming}
            onClick={onConfirm}
            className="mcs-cta"
          >
            我已发送邮件
          </Button>
          <div className="mcs-hint">
            请先把上面的邮箱填到目标平台并触发发信，再点此按钮开始接收（点击后才连接邮箱查收）。
          </div>
        </>
      )}

      {onCancel && (
        <Button className="mcs-ghost-btn" block onClick={onCancel}>
          放弃并释放邮箱
        </Button>
      )}
    </div>
  );
}

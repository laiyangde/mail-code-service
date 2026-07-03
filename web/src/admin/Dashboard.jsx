/**
 * 监控面板（B3 / FR-8.4）：展示 GET /stats 的池水位、排队、SSE、租约计数。手动刷新（低频自用）。
 * 分组自绘统计卡（账号池 / 租约 / 实时），带状态色条与等宽数字，数据感更强。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Spin } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { adminApi } from './adminApi.js';
import { useApiError } from './useApiError.js';

/**
 * @param {object} props
 * @param {() => void} props.onUnauthorized 401 时上抛登出
 */
export default function Dashboard({ onUnauthorized }) {
  const onErr = useApiError(onUnauthorized);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await adminApi.stats());
    } catch (err) {
      onErr(err, '加载失败');
    } finally {
      setLoading(false);
    }
  }, [onErr]);

  useEffect(() => {
    load();
  }, [load]);

  const pool = stats?.pool ?? {};
  const leases = stats?.leases ?? {};

  /** 分组统计：tone 决定状态色条与数字高亮 */
  const groups = [
    {
      label: '账号池',
      items: [
        { label: '账号总数', value: pool.total ?? 0, tone: 'neutral' },
        { label: '空闲', value: pool.free ?? 0, tone: 'success' },
        { label: '占用', value: pool.leased ?? 0, tone: 'primary' },
        { label: '不健康', value: pool.unhealthy ?? 0, tone: 'warning' },
        { label: '禁用', value: pool.disabled ?? 0, tone: 'muted' },
      ],
    },
    {
      label: '租约',
      items: [
        { label: '活跃租约', value: leases.active ?? 0, tone: 'primary' },
        { label: '已收码', value: leases.received ?? 0, tone: 'success' },
        { label: '已超时', value: leases.expired ?? 0, tone: 'muted' },
      ],
    },
    {
      label: '实时',
      items: [
        { label: '排队数', value: stats?.queue ?? 0, tone: 'warning' },
        { label: 'SSE 连接', value: stats?.sse ?? 0, tone: 'primary' },
      ],
    },
  ];

  return (
    <div className="mcs-admin-page">
      <div className="mcs-admin-toolbar">
        <div>
          <div className="mcs-admin-h">运行监控</div>
          <div className="mcs-admin-desc">账号池水位、租约与实时连接概览</div>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load}>
          刷新
        </Button>
      </div>
      <Spin spinning={loading}>
        {groups.map((g) => (
          <section key={g.label} className="mcs-statgroup">
            <div className="mcs-statgroup__label">{g.label}</div>
            <div className="mcs-statgrid">
              {g.items.map((it) => (
                <div key={it.label} className={`mcs-statcard mcs-statcard--${it.tone}`}>
                  <span className="mcs-statcard__value mcs-mono">{it.value}</span>
                  <span className="mcs-statcard__label">{it.label}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </Spin>
    </div>
  );
}

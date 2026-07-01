/**
 * 监控面板（B3 / FR-8.4）：展示 GET /stats 的池水位、排队、SSE、租约计数。手动刷新（低频自用）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Col, Row, Spin, Statistic } from 'antd';
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

  /** 统计卡片：[标题, 值, 颜色?] */
  const cards = [
    ['账号总数', pool.total ?? 0],
    ['空闲', pool.free ?? 0, '#36c98a'],
    ['占用', pool.leased ?? 0, '#4f8cff'],
    ['不健康', pool.unhealthy ?? 0, '#f0a73c'],
    ['禁用', pool.disabled ?? 0],
    ['排队数', stats?.queue ?? 0],
    ['SSE 连接', stats?.sse ?? 0],
    ['活跃租约', leases.active ?? 0, '#4f8cff'],
    ['已收码', leases.received ?? 0, '#36c98a'],
    ['已超时', leases.expired ?? 0],
  ];

  return (
    <Spin spinning={loading}>
      <div style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={load}>
          刷新
        </Button>
      </div>
      <Row gutter={[16, 16]}>
        {cards.map(([title, value, color]) => (
          <Col xs={12} sm={8} md={6} key={title}>
            <Card>
              <Statistic title={title} value={value} valueStyle={color ? { color } : undefined} />
            </Card>
          </Col>
        ))}
      </Row>
    </Spin>
  );
}

/**
 * 唯一码管理（B3 / FR-8.3）：批量生成 + 前端导出（txt / 取码链接 csv）+ 按状态查询 + 吊销。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  App,
  Button,
  Card,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { adminApi } from './adminApi.js';
import { useApiError } from './useApiError.js';
import { download, codeText } from './download.js';

/** 唯一码状态 → 中文标签 + Tag 颜色 */
const STATUS_META = {
  unused: { label: '未使用', color: 'default' },
  active: { label: '收码中', color: 'blue' },
  used: { label: '已收码', color: 'green' },
  expired: { label: '已失效', color: 'orange' },
  revoked: { label: '已吊销', color: 'red' },
};
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  ...Object.entries(STATUS_META).map(([value, m]) => ({ value, label: m.label })),
];
/** 可吊销的码状态（终态 expired/revoked 不再吊销） */
const REVOCABLE = new Set(['unused', 'active', 'used']);

/** 时间戳 → 本地时间，空值返回 '-' */
const fmtTs = (ts) => {
  if (!ts) return '-';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString('zh-CN');
};

/**
 * @param {object} props
 * @param {() => void} props.onUnauthorized 401 登出
 */
export default function Codes({ onUnauthorized }) {
  const { message } = App.useApp();
  const onErr = useApiError(onUnauthorized);
  const [plans, setPlans] = useState([]);
  const [genPrefix, setGenPrefix] = useState(null);
  const [genCount, setGenCount] = useState(10);
  const [generated, setGenerated] = useState([]);
  const [status, setStatus] = useState('');
  const [filterPrefix, setFilterPrefix] = useState('');
  const [list, setList] = useState([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [loading, setLoading] = useState(false);

  // 套餐前缀下拉（生成时选用）
  useEffect(() => {
    adminApi
      .plans()
      .then(setPlans)
      .catch(() => {});
  }, []);

  const query = useCallback(async () => {
    setLoading(true);
    try {
      setList(await adminApi.codesQuery({ status, prefix: filterPrefix }));
    } catch (err) {
      onErr(err, '查询失败');
    } finally {
      setLoading(false);
    }
  }, [status, filterPrefix, onErr]);

  useEffect(() => {
    query();
  }, [query]);

  const generate = async () => {
    if (!genPrefix) {
      message.warning('请选择套餐前缀');
      return;
    }
    try {
      const res = await adminApi.genCodes(genPrefix, genCount);
      const codes = (res.codes ?? []).map(codeText);
      setGenerated(codes);
      message.success(`已生成 ${codes.length} 个唯一码`);
      query();
    } catch (err) {
      onErr(err, '生成失败');
    }
  };

  const revoke = async (code) => {
    try {
      await adminApi.revokeCode(code);
      message.success('已吊销');
      query();
    } catch (err) {
      onErr(err, '吊销失败');
    }
  };

  const delBatch = async () => {
    try {
      const r = await adminApi.deleteCodes(selectedRowKeys);
      message.success(`已删除 ${r.deleted} 个唯一码`);
      setSelectedRowKeys([]);
      query();
    } catch (err) {
      onErr(err, '批量删除失败');
    }
  };

  const delOne = async (code) => {
    try {
      await adminApi.deleteCodes([code]);
      message.success('已删除');
      setSelectedRowKeys((keys) => keys.filter((k) => k !== code));
      query();
    } catch (err) {
      onErr(err, '删除失败');
    }
  };

  const exportTxt = () => download('codes.txt', generated.join('\n'));
  const exportCsv = () => {
    const rows = ['code,link', ...generated.map((c) => `${c},${window.location.origin}/r/${c}`)];
    download('codes-links.csv', rows.join('\n'), 'text/csv;charset=utf-8');
  };

  const columns = [
    {
      title: '唯一码',
      dataIndex: 'code',
      render: (c) => <Typography.Text copyable>{c}</Typography.Text>,
    },
    { title: '套餐', dataIndex: 'prefix' },
    {
      title: '状态',
      dataIndex: 'status',
      render: (s) => <Tag color={STATUS_META[s]?.color}>{STATUS_META[s]?.label ?? s}</Tag>,
    },
    { title: '剩余配额', dataIndex: 'quotaLeft' },
    { title: '签发', dataIndex: 'issuedAt', render: fmtTs },
    { title: '回看截止', dataIndex: 'retainUntil', render: fmtTs },
    {
      title: '操作',
      key: 'op',
      render: (_, rec) => (
        <Space>
          {REVOCABLE.has(rec.status) && (
            <Popconfirm
              title="确认吊销该唯一码？"
              okText="吊销"
              okButtonProps={{ danger: true }}
              onConfirm={() => revoke(rec.code)}
            >
              <Button size="small" danger>
                吊销
              </Button>
            </Popconfirm>
          )}
          <Popconfirm
            title="删除该唯一码？"
            description="将物理删除该码及其收码记录，不可恢复。"
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={() => delOne(rec.code)}
          >
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title="批量生成">
        <Space wrap>
          <Select
            placeholder="选择套餐前缀"
            style={{ width: 220 }}
            value={genPrefix}
            onChange={setGenPrefix}
            options={plans.map((p) => ({ value: p.prefix, label: `${p.prefix}（${p.name}）` }))}
          />
          <InputNumber min={1} max={1000} value={genCount} onChange={(v) => setGenCount(v ?? 1)} />
          <Button type="primary" onClick={generate}>
            生成
          </Button>
        </Space>
        {generated.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <Space wrap style={{ marginBottom: 8 }}>
              <Typography.Text>本次生成 {generated.length} 个</Typography.Text>
              <Typography.Text copyable={{ text: generated.join('\n') }}>复制全部</Typography.Text>
              <Button size="small" onClick={exportTxt}>
                下载 .txt
              </Button>
              <Button size="small" onClick={exportCsv}>
                下载取码链接 .csv
              </Button>
            </Space>
            <Input.TextArea value={generated.join('\n')} readOnly rows={6} />
          </div>
        )}
      </Card>

      <Card title="唯一码查询">
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            value={status}
            onChange={(v) => {
              setStatus(v);
              setSelectedRowKeys([]);
            }}
            options={STATUS_OPTIONS}
            style={{ width: 140 }}
          />
          <Select
            value={filterPrefix}
            onChange={(v) => {
              setFilterPrefix(v);
              setSelectedRowKeys([]);
            }}
            style={{ width: 220 }}
            options={[
              { value: '', label: '全部套餐' },
              ...plans.map((p) => ({ value: p.prefix, label: `${p.prefix}（${p.name}）` })),
            ]}
          />
          <Button onClick={query}>刷新</Button>
          <Popconfirm
            title={`删除选中的 ${selectedRowKeys.length} 个唯一码？`}
            description="将物理删除这些码及其收码记录，不可恢复。"
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={delBatch}
            disabled={selectedRowKeys.length === 0}
          >
            <Button danger disabled={selectedRowKeys.length === 0}>
              批量删除{selectedRowKeys.length ? `（${selectedRowKeys.length}）` : ''}
            </Button>
          </Popconfirm>
        </Space>
        <Table
          rowKey="code"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={list}
          scroll={{ x: 'max-content' }}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
          rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        />
      </Card>
    </Space>
  );
}

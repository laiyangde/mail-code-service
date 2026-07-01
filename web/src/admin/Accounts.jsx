/**
 * 账号管理（B3 / FR-8.1）：列表 + 启禁 + 强制重登 + 新增。对接 /api/admin/accounts 全套。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Popconfirm, Space, Table, Tag } from 'antd';
import { adminApi } from './adminApi.js';
import { useApiError } from './useApiError.js';

/** 账号状态 → 中文标签 + Tag 颜色 */
const STATUS_META = {
  free: { label: '空闲', color: 'green' },
  leased: { label: '占用中', color: 'blue' },
  reloging: { label: '重登中', color: 'gold' },
  unhealthy: { label: '异常', color: 'orange' },
  disabled: { label: '已禁用', color: 'default' },
};

/**
 * @param {object} props
 * @param {() => void} props.onUnauthorized 401 登出
 */
export default function Accounts({ onUnauthorized }) {
  const { message } = App.useApp();
  const onErr = useApiError(onUnauthorized);
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await adminApi.accounts());
    } catch (err) {
      onErr(err, '加载账号失败');
    } finally {
      setLoading(false);
    }
  }, [onErr]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleDisabled = async (rec) => {
    try {
      await adminApi.setAccountDisabled(rec.id, !rec.disabled);
      message.success(rec.disabled ? '已启用' : '已禁用');
      load();
    } catch (err) {
      onErr(err, '操作失败');
    }
  };

  const relogin = async (rec) => {
    try {
      await adminApi.relogin(rec.id);
      message.success('已触发重登');
      load();
    } catch (err) {
      onErr(err, '重登失败');
    }
  };

  const del = async (rec) => {
    try {
      await adminApi.deleteAccount(rec.id);
      message.success('账号已删除');
      load();
    } catch (err) {
      onErr(err, '删除失败');
    }
  };

  const openAdd = () => {
    form.resetFields();
    setOpen(true);
  };

  const submitAdd = async () => {
    let v;
    try {
      v = await form.validateFields();
    } catch {
      return; // 表单校验失败，留在弹窗
    }
    try {
      await adminApi.addAccount(v);
      message.success('账号已新增');
      setOpen(false);
      load();
    } catch (err) {
      onErr(err, '新增失败');
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id' },
    { title: '高校', dataIndex: 'university' },
    { title: '域名', dataIndex: 'domain' },
    { title: '分组', dataIndex: 'group' },
    {
      title: '状态',
      dataIndex: 'status',
      render: (s) => <Tag color={STATUS_META[s]?.color}>{STATUS_META[s]?.label ?? s}</Tag>,
    },
    {
      title: '健康',
      dataIndex: 'healthy',
      render: (h) => <Tag color={h ? 'green' : 'orange'}>{h ? '正常' : '异常'}</Tag>,
    },
    { title: '当前别名', dataIndex: 'currentAlias', render: (a) => a || '-' },
    {
      title: '操作',
      key: 'op',
      render: (_, rec) => (
        <Space>
          <Button size="small" onClick={() => toggleDisabled(rec)}>
            {rec.disabled ? '启用' : '禁用'}
          </Button>
          <Button size="small" onClick={() => relogin(rec)}>
            重登
          </Button>
          <Popconfirm
            title="删除该账号？"
            description="将同时清除该账号的全部租约记录，不可恢复。"
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={() => del(rec)}
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
    <>
      <div style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={openAdd}>
          新增账号
        </Button>
      </div>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={data}
        scroll={{ x: 'max-content' }}
      />
      <Modal
        title="新增账号"
        open={open}
        onOk={submitAdd}
        onCancel={() => setOpen(false)}
        okText="新增"
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="新增前请先把账号凭据写入 .env；credsRef 填变量前缀（如 SWPU_ACCT_1）"
        />
        <Form form={form} layout="vertical">
          <Form.Item name="id" label="账号 ID" rules={[{ required: true }]}>
            <Input placeholder="如 swpu-1" />
          </Form.Item>
          <Form.Item name="university" label="高校" rules={[{ required: true }]}>
            <Input placeholder="如 西南石油大学" />
          </Form.Item>
          <Form.Item name="domain" label="域名" rules={[{ required: true }]}>
            <Input placeholder="如 swpu.edu.cn" />
          </Form.Item>
          <Form.Item name="group" label="分组" rules={[{ required: true }]}>
            <Input placeholder="如 swpu" />
          </Form.Item>
          <Form.Item name="credsRef" label="凭据引用（.env 变量前缀）" rules={[{ required: true }]}>
            <Input placeholder="如 SWPU_ACCT_1" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

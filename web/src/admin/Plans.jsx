/**
 * 套餐管理（B3 / FR-8.2）：列表 + 新增/编辑（upsert）。数组字段用 Select tags 直接产出数组。
 * prefix 是主键：编辑时禁改（upsert 按 prefix 覆盖）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd';
import { adminApi } from './adminApi.js';
import { useApiError } from './useApiError.js';

/** 新增时的字段默认值（与后端 plan.repo 默认一致） */
const DEFAULTS = {
  quota: 1,
  leaseTtlSec: 900,
  retentionSec: 604800,
  maxRenews: 5,
  enabled: true,
  allowedGroups: [],
  targetSenders: [],
};

/**
 * @param {object} props
 * @param {() => void} props.onUnauthorized 401 登出
 */
export default function Plans({ onUnauthorized }) {
  const { message } = App.useApp();
  const onErr = useApiError(onUnauthorized);
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await adminApi.plans());
    } catch (err) {
      onErr(err, '加载套餐失败');
    } finally {
      setLoading(false);
    }
  }, [onErr]);

  useEffect(() => {
    load();
  }, [load]);

  const openAdd = () => {
    setEditing(false);
    form.setFieldsValue(DEFAULTS);
    setOpen(true);
  };

  const openEdit = (rec) => {
    setEditing(true);
    form.setFieldsValue({ ...DEFAULTS, ...rec });
    setOpen(true);
  };

  const submit = async () => {
    let v;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    try {
      await adminApi.upsertPlan(v);
      message.success('套餐已保存');
      setOpen(false);
      load();
    } catch (err) {
      onErr(err, '保存失败');
    }
  };

  const del = async (prefix) => {
    try {
      const r = await adminApi.deletePlan(prefix);
      message.success(`套餐已删除（连带清除 ${r.deletedCodes} 个码）`);
      setSelectedRowKeys((keys) => keys.filter((k) => k !== prefix));
      load();
    } catch (err) {
      onErr(err, '删除失败');
    }
  };

  const delBatch = async () => {
    try {
      let codes = 0;
      for (const prefix of selectedRowKeys) {
        const r = await adminApi.deletePlan(prefix);
        codes += r.deletedCodes ?? 0;
      }
      message.success(`已删除 ${selectedRowKeys.length} 个套餐（连带清除 ${codes} 个码）`);
      setSelectedRowKeys([]);
      load();
    } catch (err) {
      onErr(err, '批量删除失败');
    }
  };

  const columns = [
    { title: '前缀', dataIndex: 'prefix' },
    { title: '名称', dataIndex: 'name' },
    {
      title: '允许分组',
      dataIndex: 'allowedGroups',
      render: (g) => (g || []).map((x) => <Tag key={x}>{x}</Tag>),
    },
    {
      title: '目标发件人',
      dataIndex: 'targetSenders',
      render: (g) => (g || []).join(', ') || '-',
    },
    { title: '配额', dataIndex: 'quota' },
    { title: 'TTL(s)', dataIndex: 'leaseTtlSec' },
    { title: '保留(s)', dataIndex: 'retentionSec' },
    { title: '重申请上限', dataIndex: 'maxRenews' },
    {
      title: '启用',
      dataIndex: 'enabled',
      render: (e) => <Tag color={e ? 'green' : 'default'}>{e ? '是' : '否'}</Tag>,
    },
    {
      title: '操作',
      key: 'op',
      render: (_, rec) => (
        <Space>
          <Button size="small" onClick={() => openEdit(rec)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该套餐？"
            description="将连带删除该套餐下的全部唯一码与租约，不可恢复。"
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={() => del(rec.prefix)}
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
        <Space>
          <Button type="primary" onClick={openAdd}>
            新增套餐
          </Button>
          <Popconfirm
            title={`删除选中的 ${selectedRowKeys.length} 个套餐？`}
            description="将连带删除这些套餐下的全部唯一码与租约，不可恢复。"
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
      </div>
      <Table
        rowKey="prefix"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={data}
        scroll={{ x: 'max-content' }}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
      />
      <Modal
        title={editing ? '编辑套餐' : '新增套餐'}
        open={open}
        onOk={submit}
        onCancel={() => setOpen(false)}
        okText="保存"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="prefix" label="前缀（主键）" rules={[{ required: true }]}>
            <Input placeholder="如 gh" disabled={editing} />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="如 GitHub 注册码" />
          </Form.Item>
          <Form.Item name="allowedGroups" label="允许分组">
            <Select mode="tags" placeholder="回车添加，如 swpu" />
          </Form.Item>
          <Form.Item
            name="targetSenders"
            label="目标发件人（选填，留空=不限发件人，仅按收件人+时间匹配）"
          >
            <Select mode="tags" placeholder="留空即可；如需限制填 @github.com" />
          </Form.Item>
          <Form.Item name="codeRegex" label="验证码正则（选填）">
            <Input placeholder="默认 \b\d{4,8}\b" />
          </Form.Item>
          <Form.Item name="quota" label="配额" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="leaseTtlSec" label="租约 TTL（秒）" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="retentionSec" label="保留期（秒）" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="maxRenews" label="重申请上限" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

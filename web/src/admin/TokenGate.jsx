/**
 * 密钥门（B2 / 需求①）：输入固定密钥 ADMIN_TOKEN 进入。校验方式 = 用该密钥试调 /stats，
 * 区分 401（密钥错）与 503（服务端未配置 ADMIN_TOKEN）。无用户体系、无会话。
 */
import { useState } from 'react';
import { App, Button, Card, Form, Input, Typography } from 'antd';
import { adminApi, AdminError, setToken, clearToken } from './adminApi.js';

const { Title, Paragraph } = Typography;

/**
 * @param {object} props
 * @param {() => void} props.onAuthed 校验通过回调（进入主界面）
 */
export default function TokenGate({ onAuthed }) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  const onSubmit = async ({ token }) => {
    setLoading(true);
    setToken(token.trim());
    try {
      await adminApi.stats(); // 用密钥试调，成功即视为有效
      onAuthed();
    } catch (err) {
      clearToken();
      if (err instanceof AdminError && err.status === 503) {
        message.error('管理后台未启用：服务端未配置 ADMIN_TOKEN');
      } else {
        message.error('密钥无效，请重试');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <Card style={{ width: '100%', maxWidth: 380 }}>
        <Title level={4} style={{ marginTop: 0 }}>
          管理后台
        </Title>
        <Paragraph type="secondary">输入管理密钥进入（对应 .env 的 ADMIN_TOKEN）。</Paragraph>
        <Form onFinish={onSubmit}>
          <Form.Item name="token" rules={[{ required: true, message: '请输入管理密钥' }]}>
            <Input.Password placeholder="ADMIN_TOKEN" autoFocus />
          </Form.Item>
          <Button type="primary" block htmlType="submit" loading={loading}>
            进入
          </Button>
        </Form>
      </Card>
    </div>
  );
}

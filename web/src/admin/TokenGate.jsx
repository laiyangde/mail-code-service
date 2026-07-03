/**
 * 密钥门（B2 / 需求①）：输入固定密钥 ADMIN_TOKEN 进入。校验方式 = 用该密钥试调 /stats，
 * 区分 401（密钥错）与 503（服务端未配置 ADMIN_TOKEN）。无用户体系、无会话。沉浸式登录门。
 */
import { useState } from 'react';
import { App, Button, Card, Form, Input, Typography } from 'antd';
import { adminApi, AdminError, setToken, clearToken } from './adminApi.js';
import Brand from '../components/Brand.jsx';

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
    <div className="mcs-gate">
      {/* 氛围光球 + 网格，与取码页同源 */}
      <div className="mcs-aurora" aria-hidden="true">
        <span className="mcs-orb mcs-orb--cyan" />
        <span className="mcs-orb mcs-orb--teal" />
        <span className="mcs-orb mcs-orb--blue" />
      </div>
      <div className="mcs-grid-overlay" aria-hidden="true" />

      <Card className="mcs-card mcs-gate__card mcs-fade-in" variant="borderless">
        <div className="mcs-gate__brand">
          <Brand size="lg" sub />
        </div>
        <Title level={4} className="mcs-h">
          管理后台
        </Title>
        <Paragraph type="secondary" className="mcs-lead">
          输入管理密钥进入（对应 .env 的 ADMIN_TOKEN）。
        </Paragraph>
        <Form onFinish={onSubmit}>
          <Form.Item name="token" rules={[{ required: true, message: '请输入管理密钥' }]}>
            <Input.Password placeholder="ADMIN_TOKEN" size="large" autoFocus />
          </Form.Item>
          <Button
            type="primary"
            block
            size="large"
            htmlType="submit"
            loading={loading}
            className="mcs-cta"
          >
            进入
          </Button>
        </Form>
      </Card>
    </div>
  );
}

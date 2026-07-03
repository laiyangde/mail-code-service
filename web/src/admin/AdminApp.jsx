/**
 * 管理后台主界面（B2/B3）：未登录显示密钥门，登录后 Layout + Tabs（监控/账号/套餐/唯一码）。
 * 固定密钥进入（localStorage），任一 Tab 遇 401 经 onUnauthorized 统一登出。品牌化 Header。
 */
import { useCallback, useState } from 'react';
import { Button, Layout, Tabs } from 'antd';
import { getToken, clearToken } from './adminApi.js';
import Brand from '../components/Brand.jsx';
import TokenGate from './TokenGate.jsx';
import Dashboard from './Dashboard.jsx';
import Accounts from './Accounts.jsx';
import Plans from './Plans.jsx';
import Codes from './Codes.jsx';

const { Header, Content } = Layout;

export default function AdminApp() {
  // 初始已有 token 视为已登录（请求失败再经 401 登出）
  const [authed, setAuthed] = useState(() => Boolean(getToken()));

  const logout = useCallback(() => {
    clearToken();
    setAuthed(false);
  }, []);

  if (!authed) return <TokenGate onAuthed={() => setAuthed(true)} />;

  const items = [
    { key: 'dashboard', label: '监控', children: <Dashboard onUnauthorized={logout} /> },
    { key: 'accounts', label: '账号', children: <Accounts onUnauthorized={logout} /> },
    { key: 'plans', label: '套餐', children: <Plans onUnauthorized={logout} /> },
    { key: 'codes', label: '唯一码', children: <Codes onUnauthorized={logout} /> },
  ];

  return (
    <Layout className="mcs-admin">
      <Header className="mcs-admin__header">
        <div className="mcs-admin__brandwrap">
          <Brand size="sm" />
          <span className="mcs-admin__tag">管理后台</span>
        </div>
        <Button onClick={logout}>退出</Button>
      </Header>
      <Content className="mcs-admin__content">
        <div className="mcs-admin__inner">
          <Tabs items={items} className="mcs-admin__tabs" />
        </div>
      </Content>
    </Layout>
  );
}

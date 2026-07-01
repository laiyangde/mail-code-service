/**
 * React 渲染入口（M7）：全局 antd 暗色主题 + 中文语境；按 pathname 分流取码页 / 管理后台。
 * `/admin*` → 管理后台（AdminApp，懒加载），其余 → 取码页（App）；与后端 SPA fallback 协同。
 *
 * 管理后台用 lazy 懒加载：取码页（付费用户入口、可能移动端）不打包 admin 的
 * Table/Form/Modal/Layout 等，减小首屏体积；admin 为低频自用，进入 /admin 才按需加载。
 */
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp, Spin, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App.jsx';
import './styles.css';

const AdminApp = lazy(() => import('./admin/AdminApp.jsx'));

/** 进入哪个界面：仅凭路径前缀分流，无需路由库 */
const isAdmin = window.location.pathname.startsWith('/admin');

/** 懒加载期间的居中加载态 */
const Loading = () => (
  <div
    style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
  >
    <Spin size="large" />
  </div>
);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: { colorPrimary: '#4f8cff', borderRadius: 10 },
      }}
    >
      {/* AntApp 提供 message/modal/notification 的 context（组件内经 App.useApp() 取用） */}
      <AntApp>
        {isAdmin ? (
          <Suspense fallback={<Loading />}>
            <AdminApp />
          </Suspense>
        ) : (
          <App />
        )}
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);

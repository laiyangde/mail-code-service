/**
 * 取码主页面（M7 / FR-6）：解析 `/r/:code`，按租约状态在单页内切换视图。
 *
 * 阶段（phase）：
 * - idle      初始，仅预填唯一码，点「申请邮箱」才占用（FR-6.1）
 * - activating 申请中
 * - active    进行中（含 lease.status pending/active），订阅 SSE 等码
 * - received  收到邮件，展示整封邮件
 * - expired   超时/取消，可重新获取
 * - used      回看历史收码（不新建租约）
 * - error     业务错误（按 errCode 文案）
 */
import { useCallback, useState } from 'react';
import { activate, renewLease, cancelLease } from './api.js';
import { ApiError } from './api.js';
import { useLeaseStream } from './hooks/useLeaseStream.js';
import ApplyCard from './components/ApplyCard.jsx';
import ActiveCard from './components/ActiveCard.jsx';
import MailView from './components/MailView.jsx';
import ResultsView from './components/ResultsView.jsx';
import ExpiredCard from './components/ExpiredCard.jsx';
import ErrorCard from './components/ErrorCard.jsx';

/** 从 `/r/:code` 路径解析唯一码 */
function parseCode() {
  const m = window.location.pathname.match(/^\/r\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function App() {
  const [code] = useState(parseCode);
  const [phase, setPhase] = useState('idle');
  const [lease, setLease] = useState(null);
  const [recall, setRecall] = useState({ results: [], retainUntil: null });
  const [error, setError] = useState({ errCode: '', errMsg: '' });
  const [busy, setBusy] = useState(false);

  /** 统一处理 activate/renew 的返回（active 租约 或 used 回看） */
  const applyResult = useCallback((data) => {
    if (data?.status === 'used') {
      setRecall({ results: data.results ?? [], retainUntil: data.retainUntil ?? null });
      setPhase('used');
    } else {
      setLease(data); // leaseView（pending/active）
      setPhase('active');
    }
  }, []);

  /** 统一处理错误 */
  const handleError = useCallback((err) => {
    if (err instanceof ApiError) {
      setError({ errCode: err.errCode, errMsg: err.message });
    } else {
      setError({ errCode: 'INTERNAL', errMsg: '服务内部错误' });
    }
    setPhase('error');
  }, []);

  /** 申请邮箱（FR-6.1） */
  const onApply = useCallback(async () => {
    if (!code) return;
    setBusy(true);
    setPhase('activating');
    try {
      applyResult(await activate(code));
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }, [code, applyResult, handleError]);

  /** 重新获取邮箱（FR-6.5）：renew 当前租约 */
  const onRenew = useCallback(async () => {
    if (!lease) return;
    setBusy(true);
    try {
      applyResult(await renewLease(lease.leaseId));
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }, [lease, applyResult, handleError]);

  /** 提前释放（FR-3.6） */
  const onCancel = useCallback(async () => {
    if (!lease) return;
    try {
      await cancelLease(lease.leaseId);
    } catch {
      /* 忽略：SSE done 或轮询会兜底切换状态 */
    }
    setLease((l) => (l ? { ...l, status: 'cancelled' } : l));
    setPhase('expired');
  }, [lease]);

  /** SSE 终态分流 */
  const onStreamDone = useCallback((done) => {
    setLease(done);
    if (done.status === 'received') setPhase('received');
    else if (done.status === 'expired' || done.status === 'cancelled') setPhase('expired');
    else if (done.status === 'rejected') {
      setError({ errCode: 'POOL_BUSY', errMsg: '邮箱资源暂时占满' });
      setPhase('error');
    }
  }, []);

  // 进行中才订阅；leaseId 变化（renew）自动重订
  useLeaseStream(lease?.leaseId ?? null, {
    onUpdate: setLease,
    onDone: onStreamDone,
    enabled: phase === 'active',
  });

  return (
    <div className="app">
      <div className="card">
        <div className="brand">
          <span className="dot" />
          邮箱接码
        </div>
        {renderBody()}
      </div>
    </div>
  );

  function renderBody() {
    if (!code) {
      return (
        <div>
          <h1 className="title">链接无效</h1>
          <p className="subtitle">请使用包含唯一码的完整链接进入（形如 /r/你的唯一码）。</p>
        </div>
      );
    }
    switch (phase) {
      case 'idle':
      case 'activating':
        return <ApplyCard code={code} loading={busy} onApply={onApply} />;
      case 'active':
        return <ActiveCard lease={lease} onCancel={onCancel} />;
      case 'received':
        return (
          <div>
            <div
              className="banner"
              style={{
                background: 'rgba(54,201,138,.12)',
                border: '1px solid var(--ok)',
                color: '#9be9c5',
              }}
            >
              已收到邮件！
            </div>
            <MailView mail={lease.mail} code={lease.code ?? null} />
          </div>
        );
      case 'expired':
        return (
          <ExpiredCard
            status={lease?.status === 'cancelled' ? 'cancelled' : 'expired'}
            loading={busy}
            onRenew={onRenew}
          />
        );
      case 'used':
        return <ResultsView results={recall.results} retainUntil={recall.retainUntil} />;
      case 'error':
        return (
          <ErrorCard
            errCode={error.errCode}
            errMsg={error.errMsg}
            loading={busy}
            onRetry={onApply}
          />
        );
      default:
        return null;
    }
  }
}

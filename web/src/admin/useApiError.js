/**
 * 管理接口错误处理 hook（B3，DRY）：401 → 登出；其余 → message.error。供各 Tab 复用。
 */
import { useCallback } from 'react';
import { App } from 'antd';
import { AdminError } from './adminApi.js';

/**
 * @param {() => void} onUnauthorized 401 时调用（清 token + 回密钥门）
 * @returns {(err:unknown, fallback?:string) => void}
 */
export function useApiError(onUnauthorized) {
  const { message } = App.useApp();
  return useCallback(
    (err, fallback) => {
      if (err instanceof AdminError && err.status === 401) onUnauthorized();
      else message.error((err && err.message) || fallback || '操作失败');
    },
    [message, onUnauthorized],
  );
}

/**
 * 倒计时 hook（M7）：基于绝对到期时间戳 `expiresAt`（ms）每秒刷新剩余时间。
 * 返回 `{ remainMs, mmss, over }`，归零后 `over=true` 并停止刷新。
 */
import { useEffect, useRef, useState } from 'react';

/**
 * @param {number|null|undefined} expiresAt 绝对毫秒时间戳；falsy 则不计时
 * @param {() => void} [onOver] 归零时回调（只触发一次）
 * @returns {{remainMs:number, mmss:string, over:boolean}}
 */
export function useCountdown(expiresAt, onOver) {
  const calc = () => (expiresAt ? Math.max(0, expiresAt - Date.now()) : 0);
  const [remainMs, setRemainMs] = useState(calc);
  const firedRef = useRef(false);
  // 保存最新 onOver，避免因回调引用变化重启定时器
  const onOverRef = useRef(onOver);
  onOverRef.current = onOver;

  useEffect(() => {
    firedRef.current = false;
    if (!expiresAt) return undefined;

    const tick = () => {
      const next = Math.max(0, expiresAt - Date.now());
      setRemainMs(next);
      if (next === 0 && !firedRef.current) {
        firedRef.current = true;
        onOverRef.current?.();
      }
    };
    tick(); // 立即同步一次
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const totalSec = Math.ceil(remainMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');

  return { remainMs, mmss: `${mm}:${ss}`, over: remainMs === 0 };
}

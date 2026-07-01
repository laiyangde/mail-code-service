/**
 * 已流逝时长 hook（M7 / 排队计时）：基于起点时间戳 `sinceMs` 每秒返回已过去的时长。
 * 与 useCountdown 相反（正向累加），用于排队中显示「已排队 mm:ss」。
 */
import { useEffect, useState } from 'react';

/**
 * @param {number|null|undefined} sinceMs 起点绝对毫秒时间戳；falsy 则不计时
 * @returns {{ elapsedMs:number, mmss:string }}
 */
export function useElapsed(sinceMs) {
  const calc = () => (sinceMs ? Math.max(0, Date.now() - sinceMs) : 0);
  const [elapsedMs, setElapsedMs] = useState(calc);

  useEffect(() => {
    if (!sinceMs) return undefined;
    const tick = () => setElapsedMs(Math.max(0, Date.now() - sinceMs));
    tick(); // 立即同步一次
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sinceMs]);

  const totalSec = Math.floor(elapsedMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return { elapsedMs, mmss: `${mm}:${ss}` };
}

/**
 * 一键复制按钮（M7）：优先 navigator.clipboard，降级 execCommand；复制后短暂提示。
 */
import { useState } from 'react';

/**
 * @param {object} props
 * @param {string} props.text 要复制的文本
 * @param {string} [props.label='复制'] 按钮文案
 */
export default function CopyButton({ text, label = '复制' }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // 降级：临时 textarea + execCommand
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 复制失败静默（用户可手动选择文本） */
    }
  };

  return (
    <button type="button" className="btn btn-sm" onClick={copy}>
      {copied ? '已复制 ✓' : label}
    </button>
  );
}

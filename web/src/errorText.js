/**
 * 错误码 → 用户文案映射（M7）。后端错误码见 src/errors.js；附 NETWORK/INTERNAL 兜底。
 * 每条含标题 + 可操作提示，供 ErrorCard 渲染。
 */

/** @type {Record<string, {title:string, hint:string, kind?:'warn'}>} */
const TEXTS = {
  CODE_NOT_FOUND: { title: '卡密不存在', hint: '请检查链接是否完整、是否复制有误。' },
  CODE_EXPIRED: { title: '无效的卡密', hint: '该卡密已失效（收码结果保留期已满）。' },
  CODE_EXHAUSTED: { title: '配额已用尽', hint: '该卡密的收码次数已全部用完。' },
  CODE_REVOKED: { title: '卡密已吊销', hint: '该卡密已被管理员停用，请联系发放方。' },
  PLAN_DISABLED: { title: '套餐已停用', hint: '对应套餐当前不可用，请联系发放方。' },
  POOL_BUSY: {
    title: '当前排队繁忙',
    hint: '邮箱资源暂时占满，请稍后重试。',
    kind: 'warn',
  },
  LEASE_NOT_FOUND: { title: '租约不存在', hint: '会话可能已过期，请重新申请。' },
  LEASE_NOT_TERMINAL: { title: '当前不可重申请', hint: '请等待本次邮箱超时或收到邮件后再操作。' },
  RENEW_LIMIT: { title: '重申请次数已达上限', hint: '该卡密无法再次获取邮箱，请联系发放方。' },
  NETWORK: { title: '网络异常', hint: '无法连接服务，请检查网络后重试。', kind: 'warn' },
  INTERNAL: { title: '服务内部错误', hint: '请稍后重试，若持续出现请联系发放方。' },
};

const FALLBACK = { title: '出错了', hint: '请稍后重试。' };

/**
 * 取错误码对应文案。
 * @param {string} errCode
 * @param {string} [errMsg] 后端原始描述（作为兜底标题）
 * @returns {{title:string, hint:string, kind?:'warn'}}
 */
export function errorText(errCode, errMsg) {
  if (TEXTS[errCode]) return TEXTS[errCode];
  return { ...FALLBACK, title: errMsg || FALLBACK.title };
}

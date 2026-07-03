/**
 * 对外视图转换（M6）：把内部租约 / 邮件结构映射为响应数据，**剔除账号真实标识**
 * （不含 accountId / 池规模 / 他人订单，FR-6.6/NFR-2）。public 与 v1 共用。
 */

/**
 * 内部 expiresAt/startTime 为 **Unix 秒**（与 IMAP SINCE 时间窗同语义，见 schema.sql 注释）；
 * 对外统一换算为 **毫秒**，便于前端直接与 `Date.now()` 比较（修正倒计时立即「已超时」的单位错配）。
 * @param {number|null|undefined} sec Unix 秒时间戳
 * @returns {number|null|undefined} 毫秒时间戳；null/undefined 原样透传
 */
export function secToMs(sec) {
  return sec == null ? sec : sec * 1000;
}

/**
 * 整封邮件视图（交付物，FR-4.3：服务端不提码，原文给消费端）。
 * @param {object|null|undefined} meta lease.mailMeta
 * @returns {object|null}
 */
export function mailView(meta) {
  if (!meta) return null;
  return {
    from: meta.from,
    to: meta.to,
    subject: meta.subject,
    date: meta.date,
    text: meta.text,
    html: meta.html,
  };
}

/**
 * 租约对外视图。`pending` 时附排队位次与入队时刻；`received` 时附整封邮件与可选便利码。
 * @param {object} lease lease 行
 * @param {{ queueAhead?: number, planName?: string }} [extra] 调用方补充：
 *   queueAhead（pending 时队列位次）、planName（套餐展示名，供前端展示；缺省回退前缀）
 * @returns {object}
 */
export function leaseView(lease, extra = {}) {
  const view = {
    leaseId: lease.id,
    status: lease.status,
    alias: lease.alias,
    expiresAt: secToMs(lease.expiresAt),
    plan: lease.plan, // 套餐前缀（内部标识，前端不直接展示）
    planName: extra.planName ?? lease.plan, // 套餐展示名（面向用户）；无则回退前缀
    renews: lease.renews,
  };
  if (lease.status === 'pending') {
    view.queueAhead = extra.queueAhead ?? 0; // 前面还有几人（0=下一个就轮到）
    view.enqueuedAt = lease.createdAt; // 入队时刻（ms），前端据此显示已排队时长
  }
  if (lease.status === 'active') {
    view.receiving = !!lease.receiving; // false=已设别名待用户点「我已发送」，true=收码中
  }
  if (lease.status === 'received') {
    view.mail = mailView(lease.mailMeta);
    view.code = lease.code ?? null; // 便利字段，可能为 null
  }
  return view;
}

/**
 * 对外视图转换（M6）：把内部租约 / 邮件结构映射为响应数据，**剔除账号真实标识**
 * （不含 accountId / 池规模 / 他人订单，FR-6.6/NFR-2）。public 与 v1 共用。
 */

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
 * 租约对外视图。`received` 时附整封邮件与可选便利码。
 * @param {object} lease lease 行
 * @returns {object}
 */
export function leaseView(lease) {
  const view = {
    leaseId: lease.id,
    status: lease.status,
    alias: lease.alias,
    expiresAt: lease.expiresAt,
    plan: lease.plan,
    renews: lease.renews,
  };
  if (lease.status === 'received') {
    view.mail = mailView(lease.mailMeta);
    view.code = lease.code ?? null; // 便利字段，可能为 null
  }
  return view;
}

/**
 * 访问控制服务（D 层 / FR-2.4 校验分流）：唯一码激活时的校验与状态流转。
 * 全部为**同步**方法，由 LeaseManager 在串行执行器上下文内调用（无竞态）。
 *
 * 分流（classify）：
 * - `unused/active` 且 quota>0 → `{kind:'ok', plan}`（建 / 复用租约）；
 * - `used` 且未过回看期 → `{kind:'used', results}`（只读回看，不建租约不扣配额，FR-2.7）；
 * - `revoked/expired/配额尽/套餐停用/不存在` → 抛 {@link ApiError}（对应错误码）。
 */
import { ApiError, ErrorCode } from '../errors.js';

export class AccessService {
  /** @param {object} opts @param {object} opts.store */
  constructor({ store }) {
    this.store = store;
  }

  /**
   * 校验并分流（FR-2.4）。error 分支以抛 ApiError 表达。
   * @param {string} accessCode
   * @returns {{kind:'ok', plan:object} | {kind:'used', results:object[], retainUntil:number}}
   */
  classify(accessCode) {
    const code = this.store.accessCode.getByCode(accessCode);
    if (!code) throw new ApiError(ErrorCode.CODE_NOT_FOUND, '唯一码不存在');

    const plan = this.store.plan.getByPrefix(code.prefix);
    if (!plan || !plan.enabled) throw new ApiError(ErrorCode.PLAN_DISABLED, '套餐已停用或不存在');

    if (code.status === 'revoked') throw new ApiError(ErrorCode.CODE_REVOKED, '唯一码已吊销');
    if (code.status === 'expired') throw new ApiError(ErrorCode.CODE_EXPIRED, '无效的唯一码');

    if (code.status === 'used') {
      // 回看期内 → 只读回看；过期 → 失效
      if (code.retainUntil && Date.now() <= code.retainUntil) {
        return {
          kind: 'used',
          results: this.getResults(accessCode),
          retainUntil: code.retainUntil,
        };
      }
      throw new ApiError(ErrorCode.CODE_EXPIRED, '无效的唯一码');
    }

    // unused / active：配额够则放行（unused 永久有效，不论签发多久）
    if (code.quotaLeft > 0) return { kind: 'ok', plan };
    throw new ApiError(ErrorCode.CODE_EXHAUSTED, '配额已用尽');
  }

  /**
   * 收码结果回看（FR-2.7）：该码全部 received 租约的整封邮件。
   * @param {string} accessCode
   * @returns {object[]} [{ alias, from, to, subject, date, text, html, code?, receivedAt }]
   */
  getResults(accessCode) {
    return this.store.lease
      .listByCode(accessCode)
      .filter((l) => l.status === 'received')
      .map((l) => ({
        alias: l.alias,
        from: l.mailMeta?.from,
        to: l.mailMeta?.to,
        subject: l.mailMeta?.subject,
        date: l.mailMeta?.date,
        text: l.mailMeta?.text,
        html: l.mailMeta?.html,
        code: l.code ?? undefined,
        receivedAt: l.mailMeta?.date,
      }));
  }

  /**
   * unused/active → active 并绑定租约（createLease 置 active 时调用，同步）。
   * @param {string} accessCode
   * @param {string} leaseId
   */
  markActiveSync(accessCode, leaseId) {
    const code = this.store.accessCode.getByCode(accessCode);
    if (code?.status === 'unused') this.store.accessCode.updateStatus(accessCode, 'active');
    this.store.accessCode.setBoundLease(accessCode, leaseId);
  }

  /**
   * active → unused（超时 / 取消，配额未消费可 renew，同步）。
   * @param {string} accessCode
   */
  markBackToUnusedSync(accessCode) {
    const code = this.store.accessCode.getByCode(accessCode);
    if (code?.status === 'active') this.store.accessCode.updateStatus(accessCode, 'unused');
    this.store.accessCode.setBoundLease(accessCode, null);
  }

  /**
   * 配额耗尽 → used 并设回看期（收码成功且 quota_left 归零时调用，同步）。
   * @param {string} accessCode
   * @param {number} retainUntil 回看截止时间戳（ms）
   */
  markUsedSync(accessCode, retainUntil) {
    this.store.accessCode.setStatusAndRetain(accessCode, 'used', retainUntil);
  }
}

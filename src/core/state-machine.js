/**
 * 租约（lease）与唯一码（access_code）状态机：定义合法状态集与转移表，
 * 在非法转移时抛错——落地 INV-4 / FR-0 M6「终态不可逆」。
 *
 * 所有状态变更前必须经对应 assert*Transition 校验（配合单写串行执行器），
 * 杜绝把终态（如 received）改回 active 而导致重复发码。
 */

/** 租约状态枚举 */
export const LeaseStatus = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  RECEIVED: 'received',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
});

/** 租约合法转移表：键=当前态，值=允许的下一态；空数组=终态不可逆 */
const LEASE_TRANSITIONS = Object.freeze({
  [LeaseStatus.PENDING]: [LeaseStatus.ACTIVE, LeaseStatus.REJECTED, LeaseStatus.CANCELLED],
  [LeaseStatus.ACTIVE]: [LeaseStatus.RECEIVED, LeaseStatus.EXPIRED, LeaseStatus.CANCELLED],
  [LeaseStatus.RECEIVED]: [],
  [LeaseStatus.EXPIRED]: [],
  [LeaseStatus.CANCELLED]: [],
  [LeaseStatus.REJECTED]: [],
});

/** 租约终态集合 */
export const LEASE_TERMINAL = Object.freeze(
  new Set([LeaseStatus.RECEIVED, LeaseStatus.EXPIRED, LeaseStatus.CANCELLED, LeaseStatus.REJECTED]),
);

/** 唯一码状态枚举 */
export const AccessCodeStatus = Object.freeze({
  UNUSED: 'unused',
  ACTIVE: 'active',
  USED: 'used',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
});

/**
 * 唯一码合法转移表。
 * - unused → active（首次/再次 activate 建租约）/ revoked；unused 永不过期，故无 → expired。
 * - active → used（成功收码且配额耗尽）/ unused（租约超时·取消，配额未变，回退可 renew）/ revoked。
 * - used   → expired（回看期满 GC）/ revoked。
 */
const ACCESS_CODE_TRANSITIONS = Object.freeze({
  [AccessCodeStatus.UNUSED]: [AccessCodeStatus.ACTIVE, AccessCodeStatus.REVOKED],
  [AccessCodeStatus.ACTIVE]: [
    AccessCodeStatus.USED,
    AccessCodeStatus.UNUSED,
    AccessCodeStatus.REVOKED,
  ],
  [AccessCodeStatus.USED]: [AccessCodeStatus.EXPIRED, AccessCodeStatus.REVOKED],
  [AccessCodeStatus.EXPIRED]: [],
  [AccessCodeStatus.REVOKED]: [],
});

/** 唯一码终态集合 */
export const ACCESS_CODE_TERMINAL = Object.freeze(
  new Set([AccessCodeStatus.EXPIRED, AccessCodeStatus.REVOKED]),
);

/**
 * 通用转移校验：from===to 视为无变更直接放行（便于幂等写入）；否则查表。
 * @param {string} label 错误信息前缀
 * @param {Record<string, string[]>} table 转移表
 * @param {string} from 当前态
 * @param {string} to 目标态
 */
function assertTransition(label, table, from, to) {
  if (from === to) return;
  const allowed = table[from];
  if (!allowed) {
    throw new Error(`${label}：未知的当前状态「${from}」`);
  }
  if (!allowed.includes(to)) {
    throw new Error(`${label}：非法状态转移 ${from} → ${to}（终态不可逆或不在合法转移表）`);
  }
}

/**
 * 校验租约状态转移合法性，非法即抛错。
 * @param {string} from
 * @param {string} to
 */
export function assertLeaseTransition(from, to) {
  assertTransition('租约状态机', LEASE_TRANSITIONS, from, to);
}

/**
 * 校验唯一码状态转移合法性，非法即抛错。
 * @param {string} from
 * @param {string} to
 */
export function assertAccessCodeTransition(from, to) {
  assertTransition('唯一码状态机', ACCESS_CODE_TRANSITIONS, from, to);
}

/**
 * @param {string} status
 * @returns {boolean} 是否为租约终态
 */
export function isLeaseTerminal(status) {
  return LEASE_TERMINAL.has(status);
}

/**
 * @param {string} status
 * @returns {boolean} 是否为唯一码终态
 */
export function isAccessCodeTerminal(status) {
  return ACCESS_CODE_TERMINAL.has(status);
}

import { describe, it, expect } from 'vitest';
import {
  assertLeaseTransition,
  assertAccessCodeTransition,
  isLeaseTerminal,
  isAccessCodeTerminal,
} from '../../src/core/state-machine.js';

describe('M1 状态机（INV-4 终态不可逆）', () => {
  it('租约合法转移通过', () => {
    expect(() => assertLeaseTransition('pending', 'active')).not.toThrow();
    expect(() => assertLeaseTransition('active', 'received')).not.toThrow();
    expect(() => assertLeaseTransition('active', 'expired')).not.toThrow();
    expect(() => assertLeaseTransition('pending', 'rejected')).not.toThrow();
  });

  it('租约终态不可逆：received/expired/cancelled → active 一律抛错', () => {
    expect(() => assertLeaseTransition('received', 'active')).toThrow();
    expect(() => assertLeaseTransition('expired', 'active')).toThrow();
    expect(() => assertLeaseTransition('cancelled', 'active')).toThrow();
  });

  it('同态视为无变更直接放行', () => {
    expect(() => assertLeaseTransition('active', 'active')).not.toThrow();
  });

  it('未知状态抛错', () => {
    expect(() => assertLeaseTransition('weird', 'active')).toThrow();
  });

  it('isLeaseTerminal 判定', () => {
    expect(isLeaseTerminal('received')).toBe(true);
    expect(isLeaseTerminal('expired')).toBe(true);
    expect(isLeaseTerminal('active')).toBe(false);
    expect(isLeaseTerminal('pending')).toBe(false);
  });

  it('唯一码转移与终态', () => {
    expect(() => assertAccessCodeTransition('unused', 'active')).not.toThrow();
    expect(() => assertAccessCodeTransition('active', 'used')).not.toThrow();
    expect(() => assertAccessCodeTransition('active', 'unused')).not.toThrow();
    expect(() => assertAccessCodeTransition('used', 'active')).toThrow(); // used 不可回 active
    expect(isAccessCodeTerminal('expired')).toBe(true);
    expect(isAccessCodeTerminal('revoked')).toBe(true);
    expect(isAccessCodeTerminal('unused')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  PRE_FUNDING_STATUSES,
  TERMINAL_STATUSES,
  isPreFunding,
} from '../../../src/types/status.js';

describe('PRE_FUNDING_STATUSES', () => {
  it('contains exactly the statuses where BTC is not yet locked on-chain', () => {
    const expected = new Set(['pending', 'awaiting_funding', 'initializing']);
    expect(new Set(PRE_FUNDING_STATUSES)).toEqual(expected);
  });

  it('does not overlap with TERMINAL_STATUSES', () => {
    for (const status of PRE_FUNDING_STATUSES) {
      expect(TERMINAL_STATUSES.has(status)).toBe(false);
    }
  });
});

describe('isPreFunding', () => {
  it('returns true for statuses where BTC has not been locked', () => {
    expect(isPreFunding('pending')).toBe(true);
    expect(isPreFunding('awaiting_funding')).toBe(true);
    expect(isPreFunding('initializing')).toBe(true);
  });

  it('returns false for statuses where BTC is locked or the protocol is mid-flight', () => {
    expect(isPreFunding('deposited')).toBe(false);
    expect(isPreFunding('swapping')).toBe(false);
    expect(isPreFunding('sending')).toBe(false);
    expect(isPreFunding('punished')).toBe(false);
    expect(isPreFunding('cancelling')).toBe(false);
  });

  it('returns false for terminal statuses', () => {
    expect(isPreFunding('completed')).toBe(false);
    expect(isPreFunding('failed')).toBe(false);
    expect(isPreFunding('refunded')).toBe(false);
    expect(isPreFunding('withheld')).toBe(false);
    expect(isPreFunding('expired')).toBe(false);
  });
});

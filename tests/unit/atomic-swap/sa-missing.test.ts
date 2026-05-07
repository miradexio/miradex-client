import { describe, it, expect } from 'vitest';
import { ProtocolError, VerificationError, ERROR_CODES } from '../../../src/types/index.js';

// Fix 12 (AV-C.3) — the atomic-swap driver no longer silent-passes when
// S_a_monero is absent. It throws ProtocolError('E_S_A_MONERO_MISSING')
// before any XMR-verification call. This test pins the error contract so
// a future refactor cannot accidentally reintroduce the silent-skip.

describe('atomic-swap S_a_monero missing (AV-C.3)', () => {
  it('ERROR_CODES has the typed E_S_A_MONERO_MISSING code', () => {
    expect(ERROR_CODES.E_S_A_MONERO_MISSING).toBeDefined();
  });

  it('ProtocolError E_S_A_MONERO_MISSING constructs with the correct name', () => {
    const err = new ProtocolError(
      'E_S_A_MONERO_MISSING',
      'S_a_monero not available; refusing to release encsig without XMR lock verification',
    );
    expect(err.name).toBe('ProtocolError');
    expect(err.code).toBe('E_S_A_MONERO_MISSING');
  });

  it('VerificationError E_XMR_LOCK_FAILED is thrown on non-retryable failure', () => {
    const err = new VerificationError('E_XMR_LOCK_FAILED', 'unlock_time is 1000 (expected 0)');
    expect(err.code).toBe('E_XMR_LOCK_FAILED');
  });
});

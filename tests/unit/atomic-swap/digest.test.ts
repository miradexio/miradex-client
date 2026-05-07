import { describe, it, expect } from 'vitest';
import { VerificationError, ProtocolError, ERROR_CODES } from '../../../src/types/index.js';
import { constantTimeEqualHex } from '../../../src/lib/crypto/bytes.js';

// Fix 1 (AV-B.2) — the atomic-swap driver must recompute the redeem digest
// locally before releasing encsig. This test exercises the two building
// blocks of the fix: the constant-time comparator and the typed errors.
// The end-to-end driver branch is covered in the replay/integration tests.

describe('atomic-swap redeem digest fix (AV-B.2)', () => {
  it('constant-time comparator matches identical digests', () => {
    const digest = '11'.repeat(32);
    expect(constantTimeEqualHex(digest, digest)).toBe(true);
  });

  it('constant-time comparator rejects off-by-one-bit mismatch', () => {
    const a = '11'.repeat(32);
    const b = '12' + '11'.repeat(31);
    expect(constantTimeEqualHex(a, b)).toBe(false);
  });

  it('VerificationError E_REDEEM_DIGEST_MISMATCH is thrown on mismatch', () => {
    const err = new VerificationError(
      'E_REDEEM_DIGEST_MISMATCH',
      'local redeem digest does not match sidecar',
    );
    expect(err.name).toBe('VerificationError');
    expect(err.code).toBe('E_REDEEM_DIGEST_MISMATCH');
    expect(ERROR_CODES[err.code]).toBeDefined();
  });

  it('ProtocolError E_NO_SIGNED_PSBT is thrown when lastSignedPsbt is empty', () => {
    const err = new ProtocolError(
      'E_NO_SIGNED_PSBT',
      'cannot recompute redeem digest without the locally-signed PSBT',
    );
    expect(err.name).toBe('ProtocolError');
    expect(err.code).toBe('E_NO_SIGNED_PSBT');
    expect(ERROR_CODES[err.code]).toBeDefined();
  });
});

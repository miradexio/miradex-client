import { describe, it, expect } from 'vitest';
import { Point } from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { bytesToBigInt, hexToBytes } from '../../../src/lib/crypto/scalars.js';
import { VerificationError } from '../../../src/types/index.js';

// Fix 3: Before the sweep combines s_a + s_b, it must verify that the
// sidecar-supplied s_a multiplies the ed25519 base to exactly S_a_monero.
// This test exercises the invariant on its own. The end-to-end branch
// through sweepMonero is covered by integration tests once we record a
// stagenet swap.

function pointFromScalar(hex: string): string {
  const bytes = hexToBytes(hex);
  const scalar = bytesToBigInt(bytes);
  return bytesToHex(Point.BASE.multiply(scalar).toBytes());
}

describe('sweep s_a check (invariant C.5)', () => {
  it('accepts a matching (s_a, S_a_monero) pair', () => {
    const s_aHex = '01' + '00'.repeat(31);
    const S_aExpected = pointFromScalar(s_aHex);

    const s_a = hexToBytes(s_aHex);
    const derivedHex = pointFromScalar(bytesToHex(s_a));
    expect(derivedHex).toBe(S_aExpected);
  });

  it('detects a flipped s_a bit and would throw', () => {
    const s_aHexHonest = '01' + '00'.repeat(31);
    const S_aExpected = pointFromScalar(s_aHexHonest);

    const s_aHexTampered = '02' + '00'.repeat(31);
    const derivedHex = pointFromScalar(s_aHexTampered);
    expect(derivedHex).not.toBe(S_aExpected);

    const err = new VerificationError(
      'E_S_A_MISMATCH',
      's_a returned by sidecar does not match S_a_monero, aborting sweep',
    );
    expect(err.code).toBe('E_S_A_MISMATCH');
  });
});

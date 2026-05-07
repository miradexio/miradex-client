import { describe, it, expect } from 'vitest';
import { isLowS } from '../../../../src/atomic-swap/refund.js';

const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const N_HALF = SECP256K1_N >> 1n;

function compact(rHex: string, sHex: string): Buffer {
  return Buffer.concat([Buffer.from(rHex, 'hex'), Buffer.from(sHex, 'hex')]);
}

function bigIntToBytes32(v: bigint): Buffer {
  let h = v.toString(16);
  if (h.length % 2 !== 0) h = '0' + h;
  return Buffer.from(h.padStart(64, '0'), 'hex');
}

describe('isLowS', () => {
  it('accepts s = 1', () => {
    expect(isLowS(compact('11'.repeat(32), bigIntToBytes32(1n).toString('hex')))).toBe(true);
  });

  it('accepts s = n/2 (boundary)', () => {
    expect(isLowS(compact('11'.repeat(32), bigIntToBytes32(N_HALF).toString('hex')))).toBe(true);
  });

  it('rejects s = n/2 + 1 (high-S)', () => {
    expect(isLowS(compact('11'.repeat(32), bigIntToBytes32(N_HALF + 1n).toString('hex')))).toBe(
      false,
    );
  });

  it('rejects s = 0', () => {
    expect(isLowS(compact('11'.repeat(32), '00'.repeat(32)))).toBe(false);
  });

  it('rejects signatures of the wrong length', () => {
    expect(isLowS(Buffer.alloc(63))).toBe(false);
    expect(isLowS(Buffer.alloc(65))).toBe(false);
  });
});

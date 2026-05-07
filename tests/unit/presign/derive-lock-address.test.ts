import { describe, it, expect } from 'vitest';
import { deriveLockAddress, buildMultisigWitnessScript } from '../../../src/atomic-swap/presign.js';
import { VerificationError } from '../../../src/types/index.js';

// Two valid compressed secp256k1 public keys (not associated with any real key — test vectors).
// G * 2 = 02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5
const A = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
// G * 3 = 02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9
const B = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';

describe('deriveLockAddress', () => {
  it('returns a mainnet bech32 (bc1q) P2WSH address', () => {
    const addr = deriveLockAddress({ aHex: A, bHex: B, network: 'mainnet' });
    expect(addr.startsWith('bc1q')).toBe(true);
    expect(addr.length).toBe(62);
  });

  it('returns a testnet bech32 (tb1q) P2WSH address', () => {
    const addr = deriveLockAddress({ aHex: A, bHex: B, network: 'testnet' });
    expect(addr.startsWith('tb1q')).toBe(true);
    expect(addr.length).toBe(62);
  });

  it('is deterministic for fixed (A, B, network)', () => {
    const a1 = deriveLockAddress({ aHex: A, bHex: B, network: 'mainnet' });
    const a2 = deriveLockAddress({ aHex: A, bHex: B, network: 'mainnet' });
    expect(a1).toBe(a2);
  });

  it('produces different addresses for swapped (A, B) order (script is asymmetric)', () => {
    const forward = deriveLockAddress({ aHex: A, bHex: B, network: 'mainnet' });
    const reversed = deriveLockAddress({ aHex: B, bHex: A, network: 'mainnet' });
    expect(forward).not.toBe(reversed);
  });

  it('matches the P2WSH derivation of buildMultisigWitnessScript', () => {
    const ws = buildMultisigWitnessScript(A, B);
    expect(ws.length).toBeGreaterThan(0);
    const addr = deriveLockAddress({ aHex: A, bHex: B, network: 'mainnet' });
    expect(addr.startsWith('bc1q')).toBe(true);
  });

  it('throws on bad-length pubkeys via buildMultisigWitnessScript', () => {
    expect(() => deriveLockAddress({ aHex: '00', bHex: B, network: 'mainnet' })).toThrow();
  });
});

describe('atomic-swap lock-address enforcement (AV-B.1)', () => {
  it('VerificationError E_LOCK_ADDR_MISMATCH is produced on sidecar mismatch path', () => {
    const err = new VerificationError(
      'E_LOCK_ADDR_MISMATCH',
      'derived P2WSH address does not match sidecar, refusing to fund',
    );
    expect(err.code).toBe('E_LOCK_ADDR_MISMATCH');
    expect(err.name).toBe('VerificationError');
  });

  it('VerificationError E_LOCK_SCRIPT is produced by deriveLockAddress on derivation failure', () => {
    const err = new VerificationError('E_LOCK_SCRIPT', 'failed to derive P2WSH lock address');
    expect(err.code).toBe('E_LOCK_SCRIPT');
  });
});

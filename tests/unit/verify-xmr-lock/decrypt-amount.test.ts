import { describe, it, expect } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { decryptAmount, encodeVarint } from '../../../src/lib/monero/output-scanner.js';
import { bytesToBigIntLE, bigIntToBytes } from '../../../src/lib/crypto/scalars.js';

// Spec-correct ECDH amount key, mirroring Rust WASM `decrypt_amount_inner`
// in miradex-rust/src/monero/commitment.rs:
//   derivation_scalar = sc_reduce32(keccak256(d8 || varint(i)))   // serialised as 32-byte LE
//   amount_key        = keccak256("amount" || derivation_scalar)  // first 8 bytes
function specCorrectAmountKey8(d8: Uint8Array, outputIndex: number): Uint8Array {
  const varintBytes = encodeVarint(outputIndex);
  const preimage1 = new Uint8Array(d8.length + varintBytes.length);
  preimage1.set(d8);
  preimage1.set(varintBytes, d8.length);
  const rawHash = keccak_256(preimage1);
  const reducedBytes = bigIntToBytes(bytesToBigIntLE(rawHash));
  const amountPrefix = new TextEncoder().encode('amount');
  const preimage2 = new Uint8Array(amountPrefix.length + 32);
  preimage2.set(amountPrefix);
  preimage2.set(reducedBytes, amountPrefix.length);
  return keccak_256(preimage2).slice(0, 8);
}

function uint64ToLEBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let n = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function encryptAmount(d8: Uint8Array, outputIndex: number, plaintext: bigint): string {
  const key = specCorrectAmountKey8(d8, outputIndex);
  const plainBytes = uint64ToLEBytes(plaintext);
  const cipher = new Uint8Array(8);
  for (let i = 0; i < 8; i++) cipher[i] = (plainBytes[i] ?? 0) ^ (key[i] ?? 0);
  return bytesToHex(cipher);
}

describe('decryptAmount — reduces derivation hash mod L before amount-key keccak', () => {
  it('round-trips a known plaintext encrypted with the spec-correct algorithm', () => {
    const d8 = new Uint8Array(32);
    for (let i = 0; i < 32; i++) d8[i] = (0xa0 + i) & 0xff;
    const outputIndex = 0;
    const plaintext = 99_610_000_000n; // 0.0996 XMR — the value seen in the failing log

    const cipherHex = encryptAmount(d8, outputIndex, plaintext);
    const decrypted = decryptAmount(d8, outputIndex, { amount: cipherHex });

    expect(decrypted).toBe(plaintext);
  });

  it('round-trips across a sweep of d8 inputs that exercise both raw < L and raw >= L', () => {
    // The bug only manifests when keccak256(d8 || varint(i)) >= L. Hashing 64
    // distinct d8 values produces a mix of below- and above-L raw hashes, so
    // any regression to the raw-hash path is caught by at least one iteration.
    for (let seed = 0; seed < 64; seed++) {
      const d8 = new Uint8Array(32);
      for (let i = 0; i < 32; i++) d8[i] = (seed * 7 + i * 13) & 0xff;
      const outputIndex = seed % 4;
      const plaintext = BigInt(seed * 1_000_007 + 1);
      const cipherHex = encryptAmount(d8, outputIndex, plaintext);
      const decrypted = decryptAmount(d8, outputIndex, { amount: cipherHex });
      expect(decrypted).toBe(plaintext);
    }
  });

  it('returns 0n when ecdhInfo is undefined', () => {
    const d8 = new Uint8Array(32);
    expect(decryptAmount(d8, 0, undefined)).toBe(0n);
  });
});

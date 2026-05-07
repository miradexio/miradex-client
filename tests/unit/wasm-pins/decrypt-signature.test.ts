/**
 * Known-answer tests for decrypt_signature / verify_encsig.
 *
 * Fixture values are the output of `cargo test -p keygen-wasm kat_refund_fixture
 * -- --ignored --nocapture` (see keygen-wasm/src/lib.rs). Do not hand-edit;
 * regenerate by running the Rust test when the WASM crate changes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureWasm,
  decryptSignature,
  verifyEncsig,
  signDigest,
  encsignDigest,
  generateClientKeysFromSeed,
} from '../../../src/lib/crypto/wasm.js';

const KAT = {
  aSecret: '0000000000000000000000000000000000000000000000000000000000000007',
  A: '025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc',
  bSecret: '000000000000000000000000000000000000000000000000000000000000000b',
  B: '03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb',
  sBedLE: '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543200',
  sBBitcoin: '03589bc1207687a3f099e068ea5edc22703cfc4d94dded03aecb77e04ed10933a6',
  sBAsSecp: '0032547698badcfeefcdab89674523011032547698badcfeefcdab8967452301',
  digest: 'deadbeefcafebabefeedfacebaadf00d0123456789abcdeffedcba9876543210',
  encsig:
    '03294e569dc9f9dd1cf2cbe8266899573b041b96a4785593ad287e6f39a68ad07103afdbfb0ac83011f10a3adffc8a37c7906b0363a4261b0c0f3d4d7627266f2921fd8d28f36c5f00dc162757c1a5fccb1c8a5ae46a8171ac9230bb87fde34e87152d6267f54714b64c2968aa40f57a68339ad590629f2a8cb31a9bc3dc3d83b177421511099e79d9b26b4b8be4e92719cb91a4d1a34ffa80f95062de7c5a582ccb',
  sigACompact:
    '294e569dc9f9dd1cf2cbe8266899573b041b96a4785593ad287e6f39a68ad07120564f5ac52eb3239c6001fb1635f14f17dd4c2b0708a808bb75799e4f270dc4',
  sigBCompact:
    'abee6a0406dd2187f8f2b11d5471e3394810693215483cfd699742df72ca0320186462331a95319bde46ef211c9225e79a2c8530c0c0a15af31a9f030e71fec2',
} as const;

function reverseHex(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  const reversed = Buffer.from(bytes).reverse();
  return reversed.toString('hex');
}

describe('decrypt_signature / verify_encsig KAT', () => {
  beforeAll(async () => {
    await ensureWasm();
  });

  it('derives the pinned keys from seed', () => {
    const vB = '0202020202020202020202020202020202020202020202020202020202020202';
    const alice = generateClientKeysFromSeed(KAT.sBedLE, vB, KAT.aSecret);
    expect(alice.B).toBe(KAT.A);
    const bob = generateClientKeysFromSeed(KAT.sBedLE, vB, KAT.bSecret);
    expect(bob.B).toBe(KAT.B);
    expect(bob.s_b_bitcoin).toBe(KAT.sBBitcoin);
    expect(bob.s_b).toBe(KAT.sBedLE);
  });

  it('verifies the pinned encsig under (A, S_b_bitcoin, digest)', () => {
    expect(verifyEncsig(KAT.A, KAT.sBBitcoin, KAT.digest, KAT.encsig)).toBe(true);
  });

  it('rejects a mutated encsig', () => {
    const prefix = KAT.encsig.slice(0, KAT.encsig.length - 2);
    const last = KAT.encsig.slice(-2);
    const flipped = prefix + (last === 'ff' ? '00' : 'ff');
    expect(verifyEncsig(KAT.A, KAT.sBBitcoin, KAT.digest, flipped)).toBe(false);
  });

  it('rejects an encsig against a wrong verification key', () => {
    expect(verifyEncsig(KAT.B, KAT.sBBitcoin, KAT.digest, KAT.encsig)).toBe(false);
  });

  it('decrypts the encsig with byte-reversed s_b to the exact pinned sig_A', () => {
    const reversed = reverseHex(KAT.sBedLE);
    expect(reversed).toBe(KAT.sBAsSecp);
    const sig = decryptSignature(reversed, KAT.encsig);
    expect(sig).toBe(KAT.sigACompact);
  });

  it('non-reversed s_b yields a different (wrong) signature — reversal is load-bearing', () => {
    const sig = decryptSignature(KAT.sBedLE, KAT.encsig);
    expect(sig).not.toBe(KAT.sigACompact);
  });

  it('signDigest with pinned b produces the exact pinned sig_B', () => {
    const sig = signDigest(KAT.bSecret, KAT.digest);
    expect(sig).toBe(KAT.sigBCompact);
  });

  it('round-trip: encsign → verify → decrypt yields a 64-byte compact sig', () => {
    const digest = 'aa'.repeat(32);
    const encsig = encsignDigest(KAT.aSecret, KAT.sBBitcoin, digest);
    expect(verifyEncsig(KAT.A, KAT.sBBitcoin, digest, encsig)).toBe(true);
    const sig = decryptSignature(KAT.sBAsSecp, encsig);
    expect(sig).toHaveLength(128);
  });
});

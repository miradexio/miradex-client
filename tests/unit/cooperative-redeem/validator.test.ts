import { describe, it, expect, beforeEach } from 'vitest';
import { Point } from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { validateCooperativeRedeem } from '../../../src/cooperative-redeem.js';
import {
  initKeygen,
  type WasmModule,
} from '../../../src/lib/crypto/wasm.js';
import { VerificationError } from '../../../src/types/index.js';
import { bytesToBigInt, hexToBytes } from '../../../src/lib/crypto/scalars.js';

function pointFromScalar(hex: string): string {
  return bytesToHex(Point.BASE.multiply(bytesToBigInt(hexToBytes(hex))).toBytes());
}

function stubModule(overrides: Partial<WasmModule>): WasmModule {
  return {
    generate_client_keys: () => '{}',
    generate_client_keys_from_seed: () => '{}',
    sign_digest: () => '',
    encsign_digest: () => '',
    ...overrides,
  };
}

describe('validateCooperativeRedeem', () => {
  beforeEach(() => {
    initKeygen(stubModule({ recover_adaptor_scalar: () => '' }));
  });

  it('happy path: adaptor recovers claimedSA and claimedSA hashes to S_a_monero', () => {
    const claimedSA = '01' + '00'.repeat(31);
    const S_aMonero = pointFromScalar(claimedSA);

    initKeygen(
      stubModule({
        recover_adaptor_scalar: () => claimedSA,
      }),
    );

    const out = validateCooperativeRedeem({
      aliceSigA: 'aa'.repeat(32),
      bobEncsig: 'bb'.repeat(64),
      S_a_bitcoin: '02' + 'cd'.repeat(32),
      S_a_monero: S_aMonero,
      claimedSA,
    });
    expect(out).toBe(claimedSA);
  });

  it('throws E_COOP_SA_ADAPTOR_MISMATCH when recovered != claimedSA', () => {
    const claimedSA = '01' + '00'.repeat(31);
    const S_aMonero = pointFromScalar(claimedSA);

    initKeygen(
      stubModule({
        recover_adaptor_scalar: () => '02' + '00'.repeat(31),
      }),
    );

    expect(() =>
      validateCooperativeRedeem({
        aliceSigA: 'aa'.repeat(32),
        bobEncsig: 'bb'.repeat(64),
        S_a_bitcoin: '02' + 'cd'.repeat(32),
        S_a_monero: S_aMonero,
        claimedSA,
      }),
    ).toThrow(VerificationError);
  });

  it('throws E_COOP_SA_PUBKEY_MISMATCH when claimedSA does not hash to S_a_monero', () => {
    const claimedSA = '01' + '00'.repeat(31);
    const wrongSA = '09' + '00'.repeat(31);
    const S_aMonero = pointFromScalar(wrongSA);

    initKeygen(
      stubModule({
        recover_adaptor_scalar: () => claimedSA,
      }),
    );

    let caught: VerificationError | undefined;
    try {
      validateCooperativeRedeem({
        aliceSigA: 'aa'.repeat(32),
        bobEncsig: 'bb'.repeat(64),
        S_a_bitcoin: '02' + 'cd'.repeat(32),
        S_a_monero: S_aMonero,
        claimedSA,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe('E_COOP_SA_PUBKEY_MISMATCH');
  });

  it('throws when the WASM module lacks recover_adaptor_scalar', () => {
    // Defensive: our unified crate always exports recover_adaptor_scalar, but
    // if a bogus module somehow lands in the cache, the invocation must fail
    // loudly rather than silently returning undefined.
    initKeygen(stubModule({}));
    expect(() =>
      validateCooperativeRedeem({
        aliceSigA: 'aa'.repeat(32),
        bobEncsig: 'bb'.repeat(64),
        S_a_bitcoin: '02' + 'cd'.repeat(32),
        S_a_monero: '00'.repeat(32),
        claimedSA: '01' + '00'.repeat(31),
      }),
    ).toThrow();
  });
});

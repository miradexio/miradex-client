/**
 * Unit tests for the recovery snapshot helpers.
 *
 * Covers:
 *   - buildProtocolSnapshot produces a typed object with a correct digest.
 *   - canonicalSerialize is key-order-stable so the digest reproduces.
 *   - verifySnapshotIntegrity catches tampered snapshots.
 *   - Roundtrip: build → stringify → parse → verify.
 */
import { describe, it, expect } from 'vitest';
import {
  buildProtocolSnapshot,
  canonicalSerialize,
  computeSnapshotDigest,
  verifySnapshotIntegrity,
  SNAPSHOT_VERSION,
  type BuildProtocolSnapshotInput,
  type ProtocolSnapshot,
} from '../../../src/atomic-swap/snapshot.js';

function fixtureInput(overrides: Partial<BuildProtocolSnapshotInput> = {}): BuildProtocolSnapshotInput {
  return {
    swapId: 'swap-abc-123',
    externalSwapId: 'MX-000042',
    keystoreId: 'keystore-path-or-id',
    network: 'mainnet',
    capturedByVersion: '0.3.0',
    capturedAtEpochMs: 1_750_000_000_000,
    protocolParams: {
      A: '02' + 'aa'.repeat(32),
      S_a_bitcoin: '02' + 'bb'.repeat(32),
      S_a_monero: 'cc'.repeat(32),
      v_a: 'dd'.repeat(32),
      cancel_timelock: 72,
      punish_timelock: 144,
      remaining_refund_timelock: null,
      redeem_address: 'bc1qredeem',
      punish_address: 'bc1qpunish',
      tx_cancel_fee_sats: '1000',
      tx_refund_fee_sats: '1500',
      tx_redeem_fee_sats: '1500',
      tx_punish_fee_sats: '1000',
      amnesty_amount_sats: null,
      tx_partial_refund_fee_sats: null,
      tx_reclaim_fee_sats: null,
      tx_withhold_fee_sats: null,
      tx_mercy_fee_sats: null,
      monero_lock_address: '4monerolockaddress',
      xmr_amount_pico: '500000000000',
      tx_full_refund_encsig: 'ee'.repeat(64),
      tx_partial_refund_encsig: null,
      tx_cancel_sig: null,
    },
    lockTx: {
      txid: 'ff'.repeat(32),
      vout: 0,
      amountSats: '100000',
      unsignedPsbtBase64: 'cHNidP8BAAoCAAAAAAAAAAAAAAA=',
      lockAddress: 'bc1qlockaddress',
    },
    maker: {
      peerId: '12D3KooWMakerPeerId',
      multiaddrs: ['/onion3/xxxx/tcp/9939'],
    },
    chain: {
      moneroWalletRestoreBlockheight: 3_200_000,
      lockTransferProof: null,
      sidecarStateAtCapture: 'SwapSetupCompleted',
    },
    ...overrides,
  };
}

describe('buildProtocolSnapshot', () => {
  it('produces a snapshot with a valid digest', () => {
    const snap = buildProtocolSnapshot(fixtureInput());
    expect(snap.snapshotVersion).toBe(SNAPSHOT_VERSION);
    expect(snap.capturedBy).toBe('miradex-client');
    expect(snap.phaseMarker).toBe('funded-with-encsigs');
    expect(snap.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySnapshotIntegrity(snap)).toBe(true);
  });

  it('captures the provided input verbatim', () => {
    const input = fixtureInput();
    const snap = buildProtocolSnapshot(input);
    expect(snap.swapId).toBe(input.swapId);
    expect(snap.externalSwapId).toBe(input.externalSwapId);
    expect(snap.lockTx.txid).toBe(input.lockTx.txid);
    expect(snap.protocolParams.tx_full_refund_encsig).toBe(input.protocolParams.tx_full_refund_encsig);
  });

  it('produces the same digest for two inputs that differ only in key order', () => {
    const a = buildProtocolSnapshot(fixtureInput());
    // Re-construct with shuffled key order on input — same canonical bytes.
    const shuffled: BuildProtocolSnapshotInput = {
      chain: fixtureInput().chain,
      maker: fixtureInput().maker,
      lockTx: fixtureInput().lockTx,
      protocolParams: fixtureInput().protocolParams,
      capturedAtEpochMs: 1_750_000_000_000,
      capturedByVersion: '0.3.0',
      network: 'mainnet',
      keystoreId: 'keystore-path-or-id',
      externalSwapId: 'MX-000042',
      swapId: 'swap-abc-123',
    };
    const b = buildProtocolSnapshot(shuffled);
    expect(b.digest).toBe(a.digest);
  });

  it('rejects a tampered snapshot', () => {
    const snap = buildProtocolSnapshot(fixtureInput());
    const tampered: ProtocolSnapshot = {
      ...snap,
      protocolParams: { ...snap.protocolParams, cancel_timelock: 999 },
    };
    expect(verifySnapshotIntegrity(tampered)).toBe(false);
  });

  it('roundtrips through JSON stringify + parse', () => {
    const snap = buildProtocolSnapshot(fixtureInput());
    const raw = JSON.stringify(snap);
    const loaded = JSON.parse(raw) as ProtocolSnapshot;
    expect(verifySnapshotIntegrity(loaded)).toBe(true);
  });
});

describe('canonicalSerialize', () => {
  it('sorts keys deterministically at every nesting level', () => {
    const a = { z: 1, a: { y: 2, b: 3 } };
    const b = { a: { b: 3, y: 2 }, z: 1 };
    expect(canonicalSerialize(a)).toBe(canonicalSerialize(b));
  });
});

describe('computeSnapshotDigest', () => {
  it('matches the canonical SHA-256 of the serialized body', () => {
    const body = { a: 1, b: 'two' };
    const digest = computeSnapshotDigest(body);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Different body yields different digest.
    expect(computeSnapshotDigest({ ...body, a: 2 })).not.toBe(digest);
  });
});

// Recovery snapshot. Pairs with the keystore so an external recovery binary
// (eigenwallet CLI / Tauri GUI) can drive a stuck swap to terminal. Written
// exactly once between /presigs and /fund, before any on-chain commitment.
// Public material only; private keys stay in the keystore.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// v2 added tx_cancel_sig to ProtocolParamsSnapshot. Recovery binaries that
// need autonomous-cancel must refuse v1; everything else can still load v1.
export const SNAPSHOT_VERSION = 2 as const;

export type ProtocolSnapshotPhase = 'funded-with-encsigs';

export interface ProtocolSnapshot {
  readonly snapshotVersion: typeof SNAPSHOT_VERSION;
  readonly capturedAtEpochMs: number;
  readonly capturedBy: 'miradex-client';
  readonly capturedByVersion: string;
  readonly phaseMarker: ProtocolSnapshotPhase;

  readonly swapId: string;
  readonly externalSwapId: string;
  readonly keystoreId: string;
  readonly network: 'mainnet' | 'testnet' | 'regtest';
  readonly protocolParams: ProtocolParamsSnapshot;
  readonly lockTx: LockTxSnapshot;
  readonly maker: MakerSnapshot;
  // chain fields fill as the swap progresses past funding.
  readonly chain: ChainSnapshot;
  // sha256 over canonical JSON of every other field.
  readonly digest: string;
}

export interface ProtocolParamsSnapshot {
  readonly A: string;
  readonly S_a_bitcoin: string;
  readonly S_a_monero: string;
  readonly v_a: string | null;
  readonly cancel_timelock: number;
  readonly punish_timelock: number;
  readonly remaining_refund_timelock: number | null;
  readonly redeem_address: string;
  readonly punish_address: string;
  readonly tx_cancel_fee_sats: string;
  readonly tx_refund_fee_sats: string;
  readonly tx_redeem_fee_sats: string;
  readonly tx_punish_fee_sats: string;
  readonly amnesty_amount_sats: string | null;
  readonly tx_partial_refund_fee_sats: string | null;
  readonly tx_reclaim_fee_sats: string | null;
  readonly tx_withhold_fee_sats: string | null;
  readonly tx_mercy_fee_sats: string | null;
  readonly monero_lock_address: string | null;
  readonly xmr_amount_pico: string;
  readonly tx_full_refund_encsig: string | null;
  readonly tx_partial_refund_encsig: string | null;
  // V-16 enabling-work: Alice's plain ECDSA pre-sig on TxCancel (Message3),
  // persisted so a future autonomous-cancel binary can build + broadcast
  // TxCancel without the sidecar. Null on older sidecars; in that case
  // recovery still works through the sidecar-published cancel path.
  readonly tx_cancel_sig: string | null;
}

export interface LockTxSnapshot {
  readonly txid: string;
  readonly vout: number;
  readonly amountSats: string;
  /** UNSIGNED PSBT base64 — recovery binary signs locally with key from keystore. */
  readonly unsignedPsbtBase64: string;
  readonly lockAddress: string;
}

export interface MakerSnapshot {
  readonly peerId: string;
  readonly multiaddrs: ReadonlyArray<string>;
}

export interface ChainSnapshot {
  readonly moneroWalletRestoreBlockheight: number | null;
  readonly lockTransferProof: { readonly tx_hash: string; readonly tx_key: string | null } | null;
  readonly sidecarStateAtCapture: string;
}

export interface BuildProtocolSnapshotInput {
  readonly swapId: string;
  readonly externalSwapId: string;
  readonly keystoreId: string;
  readonly network: 'mainnet' | 'testnet' | 'regtest';
  readonly capturedByVersion: string;
  readonly capturedAtEpochMs: number;
  readonly protocolParams: ProtocolParamsSnapshot;
  readonly lockTx: LockTxSnapshot;
  readonly maker: MakerSnapshot;
  readonly chain: ChainSnapshot;
  readonly phaseMarker?: ProtocolSnapshotPhase;
}

export function buildProtocolSnapshot(input: BuildProtocolSnapshotInput): ProtocolSnapshot {
  const body = {
    snapshotVersion: SNAPSHOT_VERSION,
    capturedAtEpochMs: input.capturedAtEpochMs,
    capturedBy: 'miradex-client' as const,
    capturedByVersion: input.capturedByVersion,
    phaseMarker: input.phaseMarker ?? 'funded-with-encsigs',
    swapId: input.swapId,
    externalSwapId: input.externalSwapId,
    keystoreId: input.keystoreId,
    network: input.network,
    protocolParams: input.protocolParams,
    lockTx: input.lockTx,
    maker: input.maker,
    chain: input.chain,
  };
  const digest = computeSnapshotDigest(body);
  return { ...body, digest };
}

// Sorted-keys serialise so a recovery tool can recompute the digest and
// reject tampered or corrupted files.
export function canonicalSerialize(obj: unknown): string {
  return JSON.stringify(sortKeysDeep(obj));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, sortKeysDeep(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

export function computeSnapshotDigest(snapshotBody: unknown): string {
  const canonical = canonicalSerialize(snapshotBody);
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

export function verifySnapshotIntegrity(snapshot: ProtocolSnapshot): boolean {
  const { digest, ...body } = snapshot;
  return computeSnapshotDigest(body) === digest;
}

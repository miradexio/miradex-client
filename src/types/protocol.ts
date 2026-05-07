import type { ErrorCode } from './errors.js';

// Alice's protocol parameters returned after negotiation (Messages 0-1).
export interface ProtocolParams {
  readonly A: string;
  readonly S_a_bitcoin: string;
  readonly cancel_timelock: number;
  readonly punish_timelock: number;
  readonly redeem_address: string;
  readonly punish_address: string;
  readonly tx_cancel_fee_sats: number;
  readonly tx_refund_fee_sats: number;
  readonly tx_redeem_fee_sats: number;
  readonly tx_punish_fee_sats: number;
  // Optional / amnesty fields. Rust sidecar serialises absent Option<T> as
  // JSON null, so all of these accept null alongside undefined for round-trip.
  readonly amnesty_amount_sats?: number | null;
  readonly remaining_refund_timelock?: number | null;
  readonly tx_partial_refund_fee_sats?: number | null;
  readonly tx_reclaim_fee_sats?: number | null;
  readonly tx_withhold_fee_sats?: number | null;
  readonly tx_mercy_fee_sats?: number | null;
  readonly S_a_monero?: string | null;
  readonly dleq_proof_s_a?: string | null;
  readonly v_a?: string | null;
  readonly monero_lock_address?: string | null;
  readonly xmr_amount_pico?: string | null;
  // Alice's adaptor-encrypted sig over TxFullRefund (bincode hex). Set once
  // Message3 lands. Null on Partial (amnesty-only) variants; those use
  // tx_partial_refund_encsig instead.
  readonly tx_full_refund_encsig?: string | null;
  // Alice's adaptor-encrypted sig over TxPartialRefund (amnesty variant).
  // Null on Legacy (full-only).
  readonly tx_partial_refund_encsig?: string | null;
  // V-16 enabling-work: Alice's plain ECDSA pre-sig on TxCancel. Persisted
  // in the recovery snapshot before /fund. Currently informational only.
  readonly tx_cancel_sig?: string | null;
  // base64. Client signs once, returns via /fund. Populated by sidecar at prepare.
  readonly unsigned_lock_psbt?: string | null;
  // Set once the scanner observes Alice's XMR lock tx.
  readonly monero_tx_hash?: string | null;
  readonly monero_tx_key?: string | null;
  readonly monero_restore_height?: number | null;
  // Combined view key v_a + v_b (server convenience; client could derive).
  readonly combined_view_key?: string | null;
  // Sidecar's BIP143 sighash for TxRedeem. Driver recomputes locally and
  // byte-compares before releasing the encsig.
  readonly tx_redeem_digest?: string | null;
  // Maker libp2p hints, persisted into the recovery snapshot so eigenwallet
  // (or another runtime) can re-dial without going through rendezvous again.
  readonly maker_peer_id?: string | null;
  readonly maker_multiaddrs?: ReadonlyArray<string> | null;
}

// Protocol-level inconsistency (missing required field, unexpected terminal
// state, driver timeout). Distinct from VerificationError (failed crypto
// check). Category 'protocol' so withRetry fails immediately.

import { MiradexError } from '../lib/errors.js';

export class ProtocolError extends MiradexError {
  override readonly name = 'ProtocolError';
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message, 'protocol');
    this.code = code;
  }
}

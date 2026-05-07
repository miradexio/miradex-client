import type { SwapDetail, ProtocolParams } from '../types/index.js';

// Legacy xmrVerification wrapper shape. Kept because atomic-flow's snapshot
// builder still expects lock_transfer_proof.{tx_hash, tx_key}.
export interface XmrVerificationData {
  readonly lock_transfer_proof: {
    readonly tx_hash: string;
    readonly tx_key: string | null;
  };
  readonly combined_view_key: string;
  readonly monero_lock_address: string;
  readonly xmr_amount_pico: string;
  readonly monero_restore_height?: number;
}

export interface ExtractedProtocolData {
  readonly params: ProtocolParams | null;
  readonly redeemDigestHex: string | null;
  readonly lockAddress: string | null;
  readonly timelockBlocks: number | null;
  readonly xmrVerification: XmrVerificationData | null;
  readonly makerPeerId: string | null;
  readonly makerMultiaddrs: ReadonlyArray<string> | null;
  // V-16 enabling-work: Alice's plain ECDSA pre-sig on TxCancel (Message3),
  // threaded into the recovery snapshot before /fund. Null when the sidecar
  // hasn't surfaced it yet; the client falls back to the sidecar's publish path.
  readonly aliceTxCancelSig: string | null;
}

export function extractProtocolData(detail: SwapDetail): ExtractedProtocolData {
  const pd = detail.protocolData;
  if (!pd || pd.type !== 'atomicswap' || !pd.params) {
    return {
      params: null,
      redeemDigestHex: null,
      lockAddress: null,
      timelockBlocks: null,
      xmrVerification: null,
      makerPeerId: null,
      makerMultiaddrs: null,
      aliceTxCancelSig: null,
    };
  }

  const params = pd.params as ProtocolParams;

  // Rebuild the legacy xmrVerification wrapper from the typed params.
  const xmrVerification: XmrVerificationData | null =
    params.monero_tx_hash && params.monero_lock_address && params.xmr_amount_pico
      ? {
          lock_transfer_proof: {
            tx_hash: params.monero_tx_hash,
            tx_key: params.monero_tx_key ?? null,
          },
          combined_view_key: params.combined_view_key ?? '',
          monero_lock_address: params.monero_lock_address,
          xmr_amount_pico: params.xmr_amount_pico,
          monero_restore_height: params.monero_restore_height ?? undefined,
        }
      : null;

  return {
    params,
    // Sidecar's BIP143 redeem digest. Driver recomputes locally and
    // byte-compares before releasing the encrypted signature.
    redeemDigestHex: params.tx_redeem_digest ?? null,
    // lock_address on the wire is depositAddress on SwapDetail.
    lockAddress: detail.depositAddress ?? null,
    timelockBlocks: params.cancel_timelock,
    xmrVerification,
    // libp2p hints eigenwallet needs to re-dial during cross-binary recovery.
    makerPeerId: params.maker_peer_id ?? null,
    makerMultiaddrs: params.maker_multiaddrs ?? null,
    // Null until Message3 has propagated sidecar -> swap-engine -> server.
    aliceTxCancelSig: params.tx_cancel_sig ?? null,
  };
}

import { z } from 'zod';
import { SwapNumberSchema } from './common.zod.js';
import { swapStatusSchema } from './swap.zod.js';

export const preSigsSchema = z.object({
  tx_cancel_sig: z.string().min(1),
  tx_punish_sig: z.string().min(1),
  tx_early_refund_sig: z.string().min(1),
  tx_reclaim_sig: z.string().min(1).optional(),
  tx_withhold_sig: z.string().min(1).optional(),
  tx_mercy_sig: z.string().min(1).optional(),
});
export type PreSigs = z.infer<typeof preSigsSchema>;

const presigsActionBodySchema = z.object({
  type: z.literal('presigs'),
  unsignedPsbt: z.string().min(1),
  targetAddress: z.string().optional(),
  preSigs: preSigsSchema,
});

const fundActionBodySchema = z.object({
  type: z.literal('fund'),
  signedPsbt: z.string().min(1),
  targetAddress: z.string().optional(),
  preSigs: preSigsSchema.optional(),
});

const cancelActionBodySchema = z.object({
  type: z.literal('cancel'),
  reason: z.string().max(500).optional(),
});

// V-4: the legacy `refund` action body carried Bob's private XMR scalar s_b
// and optionally his Bitcoin secret b. Current refund flow is fully client-
// side (AtomicFlow.executeRefund builds + signs + broadcasts directly, then
// posts notify-refund). Schema removed so swapActionBodySchema.parse() will
// reject any attempt to ship private keys over the wire.

const notifyRefundActionBodySchema = z.object({
  type: z.literal('notify-refund'),
  refund_txid: z.string().length(64),
});

const getOutputsActionBodySchema = z.object({
  type: z.literal('get-outputs'),
});

const getKeyImagesActionBodySchema = z.object({
  type: z.literal('get-key-images'),
  keyImagesHex: z.string().min(1),
});

const submitMoneroTxActionBodySchema = z.object({
  type: z.literal('submit-monero-tx'),
  signedTxHex: z.string().min(1).optional(),
  rawTxHex: z.string().min(1).optional(),
});

const sweepCompleteActionBodySchema = z.object({
  type: z.literal('sweep-complete'),
  txHash: z.string().min(1),
});

const commitIntentsActionBodySchema = z.object({
  type: z.literal('commit_intents'),
  signedWithdrawIntent: z.record(z.string(), z.unknown()),
  signedRefundIntent: z.record(z.string(), z.unknown()),
  signedSwapIntent: z.record(z.string(), z.unknown()).optional(),
});

const signSwapActionBodySchema = z.object({
  type: z.literal('sign_swap'),
  signedSwapIntent: z.record(z.string(), z.unknown()),
});

const submitEncsigActionBodySchema = z.object({
  type: z.literal('submit_encsig'),
  tx_redeem_encsig: z.string().min(1),
});

export const swapActionBodySchema = z.discriminatedUnion('type', [
  presigsActionBodySchema,
  fundActionBodySchema,
  cancelActionBodySchema,
  notifyRefundActionBodySchema,
  getOutputsActionBodySchema,
  getKeyImagesActionBodySchema,
  submitMoneroTxActionBodySchema,
  sweepCompleteActionBodySchema,
  commitIntentsActionBodySchema,
  signSwapActionBodySchema,
  submitEncsigActionBodySchema,
]);
export type SwapAction = z.infer<typeof swapActionBodySchema>;

const structuredOutputSchema = z.object({
  one_time_public_key: z.string(),
  tx_public_key: z.string(),
  output_index: z.number().int(),
  global_output_index: z.number().int(),
  amount: z.number(),
  rct_mask: z.string(),
  additional_tx_keys: z.array(z.string()),
  subaddr_major: z.number().int(),
  subaddr_minor: z.number().int(),
});

const sweepConstructionDataSchema = z.object({
  inputs: z.array(
    z.object({
      ring_members: z.array(z.object({ public_key: z.string(), commitment: z.string() })),
      real_output_index: z.number().int(),
      real_output: structuredOutputSchema,
      key_offsets: z.array(z.number()),
    }),
  ),
  destination: z.object({ address: z.string(), amount: z.number() }),
  fee: z.number(),
  tx_extra: z.string(),
  rct_type: z.number().int(),
});

const presigsProtocolDataSchema = z.object({
  txFullRefundEncsig: z.string().nullable(),
  txPartialRefundEncsig: z.string().nullable(),
  // V-16 enabling-work: Alice's plain ECDSA pre-sig on TxCancel. Written
  // into the recovery snapshot when present. Optional so older sidecars
  // still validate; consumers must tolerate null.
  txCancelSig: z.string().nullable().optional(),
  txLockTxid: z.string().nullable(),
  txLockVout: z.number().int().nonnegative().nullable(),
  txLockAmountSats: z.string().nullable(),
});

const fundActionProtocolDataSchema = z.object({
  txid: z.string(),
  confirmations_required: z.number().int(),
  estimated_time_minutes: z.number(),
});

const cancelProtocolDataSchema = z.object({
  tx_cancel_txid: z.string(),
  tx_cancel_hex: z.string(),
});

const refundProtocolDataSchema = z.object({
  tx_refund_txid: z.string(),
  tx_refund_hex: z.string(),
  refund_address: z.string(),
});

const notifyRefundProtocolDataSchema = z.object({
  tx_refund_txid: z.string(),
});

const getOutputsProtocolDataSchema = z.object({
  outputs_hex: z.string(),
  structured_outputs: z.array(structuredOutputSchema).optional(),
  s_a_hex: z.string(),
  v_hex: z.string(),
  receive_address: z.string(),
  monero_lock_address: z.string(),
  lock_tx_hash: z.string(),
  restore_height: z.number().int(),
});

const getKeyImagesProtocolDataSchema = z.object({
  unsigned_tx_hex: z.string(),
  construction_data: sweepConstructionDataSchema.optional(),
  fee: z.string(),
  amount: z.string(),
  destination: z.string(),
});

const submitMoneroTxProtocolDataSchema = z.object({
  tx_hashes: z.array(z.string()),
});

export const actionProtocolDataSchema = z.union([
  presigsProtocolDataSchema,
  fundActionProtocolDataSchema,
  cancelProtocolDataSchema,
  refundProtocolDataSchema,
  notifyRefundProtocolDataSchema,
  getOutputsProtocolDataSchema,
  getKeyImagesProtocolDataSchema,
  submitMoneroTxProtocolDataSchema,
]);
export type SwapActionProtocolData = z.infer<typeof actionProtocolDataSchema>;

export const swapActionResponseSchema = z.object({
  swapNumber: SwapNumberSchema,
  status: swapStatusSchema,
  message: z.string(),
  protocolData: actionProtocolDataSchema.nullable(),
});
export type SwapActionResponse = z.infer<typeof swapActionResponseSchema>;

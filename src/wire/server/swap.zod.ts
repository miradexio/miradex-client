import { z } from 'zod';
import {
  tolerantEnum,
  IsoTimestampSchema,
  SwapNumberSchema,
  DecimalAmountSchema,
} from './common.zod.js';
import { swapProviderSchema } from './tokens.zod.js';

export const swapStatusSchema = tolerantEnum([
  'initializing',
  'pending',
  'awaiting_funding',
  'deposited',
  'swapping',
  'sending',
  'cancelling',
  'completed',
  'failed',
  'refunded',
  'withheld',
  'punished',
  'expired',
] as const);
export type SwapStatus = z.infer<typeof swapStatusSchema>;

export const chainflipVerificationSchema = z.object({
  provider: z.literal('chainflip'),
  channel_id: z.string(),
  status_url: z.string(),
  explorer_url: z.string().nullable(),
});
export type ChainflipVerification = z.infer<typeof chainflipVerificationSchema>;

export const thorchainVerificationSchema = z.object({
  provider: z.literal('thorchain'),
  thornode_url: z.string(),
  inbound_addresses_url: z.string(),
  registered_memo: z.string().nullable(),
  reference_number: z.number().int().nullable(),
  explorer_url: z.string().nullable(),
});
export type ThorchainVerification = z.infer<typeof thorchainVerificationSchema>;

// status_url is nullable: 1Click has no auth-free per-swap URL guaranteed
// to work; server emits null when it declines to expose one.
// correlation_id echoes 1Click's correlationId for support/dispute reference;
// optional because older server builds omit it.
export const nearIntentsVerificationSchema = z.object({
  provider: z.literal('near_intents'),
  status_url: z.string().nullable(),
  deposit_memo: z.string().nullable(),
  explorer_url: z.string().nullable(),
  correlation_id: z.string().optional(),
});
export type NearIntentsVerification = z.infer<typeof nearIntentsVerificationSchema>;

export const atomicSwapVerificationSchema = z.object({
  provider: z.literal('atomicswap'),
  lock_address: z.string(),
  deposit_type: z.string(),
  timelock_blocks: z.number().int(),
  timelock_hours: z.number(),
  refund_address: z.string(),
  explorer_url: z.string().nullable(),
});
export type AtomicSwapVerification = z.infer<typeof atomicSwapVerificationSchema>;

export const swapVerificationSchema = z.discriminatedUnion('provider', [
  chainflipVerificationSchema,
  thorchainVerificationSchema,
  nearIntentsVerificationSchema,
  atomicSwapVerificationSchema,
]);
export type SwapVerification = z.infer<typeof swapVerificationSchema>;

export const requiredActionTypeSchema = tolerantEnum([
  'wait',
  'fund',
  'sweep',
  'cancel',
  'refund',
  'sign_swap',
  'submit_encsig',
  'none',
] as const);
export type RequiredActionType = z.infer<typeof requiredActionTypeSchema>;

export const actionUrgencySchema = tolerantEnum(['low', 'medium', 'critical'] as const);
export type ActionUrgency = z.infer<typeof actionUrgencySchema>;

export const requiredActionSchema = z.object({
  type: requiredActionTypeSchema,
  urgency: actionUrgencySchema,
  message: z.string(),
  blocksRemaining: z.number().int().nullable().optional(),
  estimatedSecondsRemaining: z.number().int().nullable().optional(),
  txCancelTxid: z.string().nullable().optional(),
  txRefundTxid: z.string().nullable().optional(),
});
export type RequiredAction = z.infer<typeof requiredActionSchema>;

const atomicSwapKeysSchema = z.object({
  S_b_bitcoin: z.string().min(1),
  S_b_monero: z.string().min(1),
  dleq_proof: z.string().min(1),
  v_b: z.string().min(1),
  B: z.string().min(1),
  libp2p_seed_hex: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .optional(),
});

const fundingProofEntrySchema = z.object({
  txid: z.string().min(1),
  vout: z.number().int().min(0),
  value: z.number().int().min(0),
  address: z.string().min(1),
  nonce: z.string().uuid(),
  signature: z.string().min(1),
});

const atomicSwapRequestProtocolSchema = z.object({
  type: z.literal('atomicSwap'),
  atomicSwap: atomicSwapKeysSchema,
  // Client sends fundingProof in a later action, not at swap creation for
  // engine-path swaps. Legacy daemon path accepts fundingProof here.
  fundingProof: z.array(fundingProofEntrySchema).min(1).optional(),
});

const nearBridgeRequestProtocolSchema = z.object({
  type: z.literal('nearBridge'),
  nearBridge: z.object({
    publicKey: z.string().length(64),
  }),
});

export const swapRequestProtocolSchema = z.discriminatedUnion('type', [
  atomicSwapRequestProtocolSchema,
  nearBridgeRequestProtocolSchema,
]);

export const createSwapBodySchema = z.object({
  from: z.string().min(1).max(20),
  to: z.string().min(1).max(20),
  amount: z.string().min(1),
  destAddress: z.string().min(1).max(256),
  refundAddress: z.string().min(1).max(256).optional(),
  provider: swapProviderSchema.optional(),
  variantId: z.string().max(100).optional(),
  fromChain: z.string().min(1).max(40).optional(),
  toChain: z.string().min(1).max(40).optional(),
  slippageBps: z.number().int().min(0).max(10000).optional(),
  protocol: swapRequestProtocolSchema.optional(),
  callbackUrl: z.string().url().max(2048).optional(),
  callbackSecret: z.string().min(16).max(256).optional(),
  telegramChatId: z.string().max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
// z.input so callers can pass raw string for `provider`; tolerantEnum accepts
// any string at runtime but z.infer would narrow to the enum union.
export type CreateSwapBody = z.input<typeof createSwapBodySchema>;

// Includes the unsigned lock PSBT, Monero lock verification data
// (tx_hash, tx_key, restore_height), and combined view key.
export const protocolParamsSchema = z.object({
  A: z.string(),
  S_a_bitcoin: z.string(),
  cancel_timelock: z.number().int(),
  punish_timelock: z.number().int(),
  redeem_address: z.string(),
  punish_address: z.string(),
  tx_cancel_fee_sats: z.number().int(),
  tx_refund_fee_sats: z.number().int(),
  tx_redeem_fee_sats: z.number().int(),
  tx_punish_fee_sats: z.number().int(),
  amnesty_amount_sats: z.number().int().optional(),
  remaining_refund_timelock: z.number().int().optional(),
  tx_partial_refund_fee_sats: z.number().int().optional(),
  tx_reclaim_fee_sats: z.number().int().optional(),
  tx_withhold_fee_sats: z.number().int().optional(),
  tx_mercy_fee_sats: z.number().int().optional(),
  tx_full_refund_encsig: z.string().nullable().optional(),
  tx_partial_refund_encsig: z.string().nullable().optional(),
  // V-16 enabling-work: Alice's plain ECDSA pre-sig on TxCancel; persisted in
  // the recovery snapshot before /fund. Currently informational only.
  tx_cancel_sig: z.string().nullable().optional(),
  unsigned_lock_psbt: z.string().nullable().optional(),
  S_a_monero: z.string().optional(),
  dleq_proof_s_a: z.string().nullable().optional(),
  v_a: z.string().nullable().optional(),
  monero_lock_address: z.string().nullable().optional(),
  xmr_amount_pico: z.string().optional(),
  monero_tx_hash: z.string().nullable().optional(),
  monero_tx_key: z.string().nullable().optional(),
  monero_restore_height: z.number().int().nullable().optional(),
  combined_view_key: z.string().nullable().optional(),
});

// Discriminated-union protocolData on swap-detail responses.
const pendingSignatureSchema = z.object({
  unsignedSwapPayload: z.record(z.string(), z.unknown()),
  freshQuote: z.object({
    amountOut: z.string(),
    quoteHash: z.string(),
    expiresAt: IsoTimestampSchema,
  }),
});

const atomicSwapProtocolDataSchema = z.object({
  type: z.literal('atomicswap'),
  params: protocolParamsSchema.nullable(),
});

const nearBridgeProtocolDataSchema = z.object({
  type: z.literal('near_intents'),
  pendingSignature: pendingSignatureSchema.nullable(),
});

const thorchainProtocolDataSchema = z.object({ type: z.literal('thorchain') });
const chainflipProtocolDataSchema = z.object({ type: z.literal('chainflip') });

export const swapProtocolDataSchema = z.discriminatedUnion('type', [
  atomicSwapProtocolDataSchema,
  nearBridgeProtocolDataSchema,
  thorchainProtocolDataSchema,
  chainflipProtocolDataSchema,
]);
export type SwapProtocolData = z.infer<typeof swapProtocolDataSchema>;
// Back-compat alias for callers that import SwapDetailProtocolData.
export type SwapDetailProtocolData = SwapProtocolData;

export const createSwapResponseSchema = z.object({
  swapNumber: SwapNumberSchema,
  status: swapStatusSchema,
  provider: swapProviderSchema,
  depositAddress: z.string().nullable(),
  fromToken: z.string(),
  toToken: z.string(),
  amountIn: DecimalAmountSchema,
  amountInUsd: z.string().nullable(),
  expectedAmountOut: z.string().nullable(),
  expectedAmountOutUsd: z.string().nullable(),
  priceImpactPct: z.string().nullable(),
  expiresAt: IsoTimestampSchema.nullable(),
  requiresFunding: z.boolean(),
  fundingDeadlineSecs: z.number().int().nullable(),
  protocolData: swapProtocolDataSchema.nullable(),
  verification: swapVerificationSchema.nullable(),
});
export type CreateSwapResponse = z.infer<typeof createSwapResponseSchema>;

export const swapDetailSchema = z.object({
  swapNumber: SwapNumberSchema,
  status: swapStatusSchema,
  provider: swapProviderSchema,
  fromToken: z.string(),
  fromChain: z.string(),
  toToken: z.string(),
  toChain: z.string(),
  amountIn: DecimalAmountSchema,
  amountInUsd: z.string().nullable(),
  expectedAmountOut: z.string().nullable(),
  expectedAmountOutUsd: z.string().nullable(),
  actualAmountOut: z.string().nullable(),
  actualAmountOutUsd: z.string().nullable(),
  priceImpactPct: z.string().nullable(),
  depositAddress: z.string().nullable(),
  fundingAddress: z.string().nullable(),
  destAddress: z.string(),
  refundAddress: z.string().nullable(),
  depositTxHash: z.string().nullable(),
  outputTxHash: z.string().nullable(),
  refundTxHash: z.string().nullable(),
  expiresAt: IsoTimestampSchema.nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema.nullable(),
  durationSeconds: z.number().int().nullable(),
  requiresFunding: z.boolean(),
  verification: swapVerificationSchema.nullable(),
  requiredAction: requiredActionSchema.nullable().optional(),
  // Discriminated union: atomicswap carries typed params (incl.
  // unsigned_lock_psbt, monero tx_hash/key/restore_height, combined_view_key).
  // near_intents carries pendingSignature. thorchain / chainflip are empty.
  protocolData: swapProtocolDataSchema.nullable(),
});
export type SwapDetail = z.infer<typeof swapDetailSchema>;

export const recentSwapSchema = z.object({
  fromToken: z.string(),
  toToken: z.string(),
  provider: swapProviderSchema,
  status: swapStatusSchema,
  amountIn: DecimalAmountSchema,
  amountInUsd: z.string().nullable(),
  expectedAmountOut: z.string().nullable(),
  expectedAmountOutUsd: z.string().nullable(),
  createdAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema.nullable(),
  durationSeconds: z.number().int().nullable(),
});
export type RecentSwap = z.infer<typeof recentSwapSchema>;

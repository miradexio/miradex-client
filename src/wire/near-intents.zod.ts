import { z } from 'zod';

// 1Click /v0/status. Source: 1Click OpenAPI v0.1.10 cross-validated against
// live captures in apps/swap-engine/tests/fixtures/oneclick/. Divergence here
// silently breaks verification — keep in sync.
//
// Shape facts:
//   - 7-value status enum. No NOT_FOUND / EXPIRED — 404 signals NOT_FOUND;
//     expiry is computed against quote.deadline.
//   - User-visible fields (recipient, refundTo, depositAddress, deadline)
//     are nested under quoteResponse.quoteRequest / quoteResponse.quote.
//   - swapDetails.*Amount is explicit null for not-yet-applicable states,
//     so .nullish() (not .optional()).
//   - Nested quoteResponse.correlationId dropped here; the top-level
//     status response carries its own.

export const NearIntentStatusCode = z.enum([
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
]);

export type NearIntentStatusCode = z.infer<typeof NearIntentStatusCode>;

const TransactionDetailsSchema = z.object({
  hash: z.string(),
  explorerUrl: z.string(),
});

const SwapDetailsSchema = z.object({
  intentHashes: z.array(z.string()),
  nearTxHashes: z.array(z.string()),
  amountIn: z.string().nullish(),
  amountInFormatted: z.string().nullish(),
  amountInUsd: z.string().nullish(),
  amountOut: z.string().nullish(),
  amountOutFormatted: z.string().nullish(),
  amountOutUsd: z.string().nullish(),
  slippage: z.number().nullish(),
  originChainTxHashes: z.array(TransactionDetailsSchema),
  destinationChainTxHashes: z.array(TransactionDetailsSchema),
  refundedAmount: z.string().nullish(),
  refundedAmountFormatted: z.string().nullish(),
  refundedAmountUsd: z.string().nullish(),
  refundReason: z.string().nullish(),
  depositedAmount: z.string().nullish(),
  depositedAmountFormatted: z.string().nullish(),
  depositedAmountUsd: z.string().nullish(),
  refundFee: z.string().nullish(),
  referral: z.string().nullish(),
});

const QuoteSchema = z.object({
  depositAddress: z.string().optional(),
  depositMemo: z.string().optional(),
  amountIn: z.string(),
  amountInFormatted: z.string(),
  amountInUsd: z.string(),
  minAmountIn: z.string(),
  amountOut: z.string(),
  amountOutFormatted: z.string(),
  amountOutUsd: z.string(),
  minAmountOut: z.string(),
  deadline: z.string().optional(),
  timeWhenInactive: z.string().optional(),
  timeEstimate: z.number().nonnegative(),
  refundFee: z.string().optional(),
});

// Mirrors the top-level QuoteResponse (correlationId dropped on the nested copy).
const NestedQuoteResponseSchema = z.object({
  correlationId: z.string().optional(),
  timestamp: z.string(),
  signature: z.string().min(1),
  quoteRequest: z.record(z.string(), z.unknown()),
  quote: QuoteSchema,
});

// Raw shape returned by GET /v0/status.
export const NearIntentRawStatusSchema = z.object({
  correlationId: z.string(),
  status: NearIntentStatusCode,
  updatedAt: z.string(),
  swapDetails: SwapDetailsSchema,
  quoteResponse: NestedQuoteResponseSchema.optional(),
});
export type NearIntentRawStatus = z.infer<typeof NearIntentRawStatusSchema>;

// Flattened view built by fetchNearIntentStatus. Holds the fields a verifier
// needs (destination, refund, deadline, amounts) hoisted from the nested
// quoteResponse.quoteRequest / quote.
export interface NearIntentStatusResponse {
  readonly status: NearIntentStatusCode;
  readonly correlationId: string;
  readonly updatedAt: string;
  readonly depositAddress: string | null;
  readonly depositMemo: string | null;
  readonly destinationAddress: string | null;
  readonly destinationAssetId: string | null;
  readonly refundAddress: string | null;
  readonly deadline: string | null;
  readonly expectedOutputAmount: string | null;
  readonly actualOutputAmount: string | null;
  readonly intentHash: string | null;
  readonly originTxHashes: readonly string[];
  readonly destinationTxHashes: readonly string[];
  readonly refundReason: string | null;
}

// NEAR RPC schemas — direct-blockchain near-intents only, NOT the 1Click API.
export const NearRpcResponseSchema = z.object({
  jsonrpc: z.string(),
  id: z.union([z.string(), z.number()]),
  result: z.unknown(),
  error: z.unknown().optional(),
});

export const NearIntentOnChainSchema = z.object({
  destinationAddress: z.string(),
  expectedOutputAmount: z.string(),
});

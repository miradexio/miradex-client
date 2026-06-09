import { z } from 'zod';
import { tolerantEnum, IsoTimestampSchema } from './common.zod.js';
import { swapProviderSchema } from './tokens.zod.js';

const quoteSourceSchema = tolerantEnum(['cache', 'api', 'stale'] as const);
const precisionSchema = tolerantEnum(['exact', 'indicative'] as const);

export const swapFeeSchema = z.object({
  type: z.string(),
  amount: z.string(),
  token: z.string(),
  amountUsd: z.string().nullable(),
});
export type SwapFee = z.infer<typeof swapFeeSchema>;

export const swapQuoteSchema = z.object({
  provider: swapProviderSchema,
  variantId: z.string(),
  variantLabel: z.string(),
  expectedOutput: z.string(),
  fromChain: z.string(),
  toChain: z.string(),
  estimatedDurationSeconds: z.number().int().nullable(),
  fees: z.array(swapFeeSchema),
  recommendedSlippageBps: z.number().int().nullable(),
  minAmount: z.string().nullable(),
  maxAmount: z.string().nullable(),
  expectedOutputUsd: z.string().nullable(),
  priceImpactPct: z.string().nullable(),
  precision: precisionSchema,
});
export type SwapQuote = z.infer<typeof swapQuoteSchema>;

export const quotesResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  amount: z.string(),
  amountInUsd: z.string().nullable(),
  quotes: z.array(swapQuoteSchema),
  cachedAt: IsoTimestampSchema.nullable(),
  source: quoteSourceSchema,
});
export type QuotesResponse = z.infer<typeof quotesResponseSchema>;

export const rateResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  rates: z.array(
    z.object({
      provider: swapProviderSchema,
      rate: z.string(),
      inverseRate: z.string(),
      estimatedDurationSeconds: z.number().int().nullable(),
      cachedAt: IsoTimestampSchema.nullable(),
    }),
  ),
  source: quoteSourceSchema,
});
export type RateResponse = z.infer<typeof rateResponseSchema>;

export const limitsResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  limits: z.array(
    z.object({
      provider: swapProviderSchema,
      minAmount: z.string().nullable(),
      maxAmount: z.string().nullable(),
      minAmountUsd: z.string().nullable(),
      maxAmountUsd: z.string().nullable(),
    }),
  ),
});
export type LimitsResponse = z.infer<typeof limitsResponseSchema>;

export const providerInfoSchema = z.object({
  provider: swapProviderSchema,
  available: z.boolean(),
  latencyMs: z.number().int().nullable(),
  chains: z.array(z.string()),
  lastCheckedAt: IsoTimestampSchema,
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

export const providersResponseSchema = z.object({
  providers: z.array(providerInfoSchema),
});
export type ProvidersResponse = z.infer<typeof providersResponseSchema>;

const liquidityTypeSchema = tolerantEnum(['amm-pool', 'intents', 'p2p-makers'] as const);
export type LiquidityType = z.infer<typeof liquidityTypeSchema>;

const liquiditySourceSchema = tolerantEnum(['cache', 'api'] as const);
export type LiquiditySource = z.infer<typeof liquiditySourceSchema>;

const providerLiquidityOutcomeSchema = tolerantEnum(['ok', 'error', 'unavailable'] as const);
export type ProviderLiquidityOutcome = z.infer<typeof providerLiquidityOutcomeSchema>;

export const liquidityEntrySchema = z.object({
  token: z.string(),
  id: z.string(),
  amount: z.string().nullable(),
  amountUsd: z.string().nullable(),
  volume24hUsd: z.string().nullable(),
  status: z.string(),
});
export type LiquidityEntry = z.infer<typeof liquidityEntrySchema>;

export const providerLiquidityDataSchema = z.object({
  type: liquidityTypeSchema,
  entries: z.array(liquidityEntrySchema),
});
export type ProviderLiquidityData = z.infer<typeof providerLiquidityDataSchema>;

export const providerLiquidityEntrySchema = z.object({
  provider: swapProviderSchema,
  status: providerLiquidityOutcomeSchema,
  error: z.string().nullable(),
  fetchedAt: IsoTimestampSchema,
  liquidity: providerLiquidityDataSchema.nullable(),
});
export type ProviderLiquidityEntry = z.infer<typeof providerLiquidityEntrySchema>;

export const liquidityTotalsSchema = z.object({
  volume24hUsd: z.string().nullable(),
  onlineProviderCount: z.number().int().nonnegative(),
  errorProviderCount: z.number().int().nonnegative(),
  entryCount: z.number().int().nonnegative(),
});
export type LiquidityTotals = z.infer<typeof liquidityTotalsSchema>;

export const liquidityResponseSchema = z.object({
  providers: z.array(providerLiquidityEntrySchema),
  totals: liquidityTotalsSchema,
  cachedAt: IsoTimestampSchema.nullable(),
  source: liquiditySourceSchema,
});
export type LiquidityResponse = z.infer<typeof liquidityResponseSchema>;

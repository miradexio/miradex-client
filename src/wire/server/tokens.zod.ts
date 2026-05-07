import { z } from 'zod';
import { tolerantEnum, NonNegativeDecimalSchema } from './common.zod.js';

export const swapProviderSchema = tolerantEnum([
  'thorchain',
  'chainflip',
  'near_intents',
  'atomicswap',
] as const);
export type SwapProvider = z.infer<typeof swapProviderSchema>;

export const swapTokenInfoSchema = z.object({
  symbol: z.string(),
  priceUsd: z.string().nullable(),
  change24hPct: z.number().nullable(),
});
export type SwapTokenInfo = z.infer<typeof swapTokenInfoSchema>;

export const swapTokenMapSchema = z.record(z.string(), z.array(swapTokenInfoSchema));
export type SwapTokenMap = z.infer<typeof swapTokenMapSchema>;

export const swapPairProviderSchema = z.object({
  provider: swapProviderSchema,
  dex: z.string(),
  isCrossChain: z.boolean(),
  minAmountUsd: NonNegativeDecimalSchema.nullable(),
});

export const swapPairSchema = z.object({
  fromToken: z.string(),
  fromDecimals: z.number().int(),
  toToken: z.string(),
  toDecimals: z.number().int(),
  providers: z.array(swapPairProviderSchema),
});
export type SwapPair = z.infer<typeof swapPairSchema>;

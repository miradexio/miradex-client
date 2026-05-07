import { z } from 'zod';

// Discriminated on `success` so TS narrows the data / error branches.
export const apiEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), data }),
    z.object({
      success: z.literal(false),
      error: z.object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      }),
    }),
  ]);

// Forward-compatible enum: known values parse as literals; unknown strings
// parse as `unknown:${string}` so we don't crash on a new server value.
export function tolerantEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.union([
    z.enum(values),
    z.string().transform((s): `unknown:${string}` => `unknown:${s}`),
  ]);
}

// Narrow a tolerantEnum value to the known literals.
export const isKnownEnumValue = <T extends string>(
  value: T | `unknown:${string}`,
): value is T => !value.startsWith('unknown:');

export const DecimalAmountSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a non-negative decimal amount');

export const NonNegativeDecimalSchema = DecimalAmountSchema;

export const IsoTimestampSchema = z.string().datetime();

export const SwapIdSchema = z.string().uuid();

// Mirrors server-contract SWAP_NUMBER_REGEX at swap.api.zod.ts:350.
export const SwapNumberSchema = z
  .string()
  .regex(/^MIRA-[A-Z0-9]{8}$/, 'Must be a swap number in MIRA-XXXXXXXX format');

export const TxHashSchema = z.string().min(1);

import { z } from 'zod';

export const verifyKeysBodySchema = z.object({
  s_b_bitcoin: z.string().min(1),
  s_b_monero: z.string().min(1),
  dleq_proof: z.string().min(1),
  v_b: z.string().min(1),
});
export type VerifyKeysBody = z.infer<typeof verifyKeysBodySchema>;

export const verifyKeysResponseSchema = z.object({
  valid: z.boolean(),
  reason: z.string(),
});
export type VerifyKeysResponse = z.infer<typeof verifyKeysResponseSchema>;

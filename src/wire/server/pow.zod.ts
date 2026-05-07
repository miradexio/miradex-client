import { z } from 'zod';
import { IsoTimestampSchema } from './common.zod.js';

export const powChallengeSchema = z.object({
  algorithm: z.literal('SHA-256'),
  challenge: z.string().length(64),
  salt: z.string().min(1),
  maxnumber: z.number().int().positive(),
  signature: z.string().length(64),
  expiresAt: IsoTimestampSchema,
});
export type PowChallenge = z.infer<typeof powChallengeSchema>;

export const powPayloadSchema = z.object({
  algorithm: z.literal('SHA-256'),
  challenge: z.string().length(64),
  number: z.number().int().min(0),
  salt: z.string().min(1),
  signature: z.string().length(64),
});
export type PowPayload = z.infer<typeof powPayloadSchema>;

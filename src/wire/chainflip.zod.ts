import { z } from 'zod';

export const ChainflipDepositChannelSchema = z.object({
  id: z.string().optional(),
  depositAddress: z.string(),
  brokerCommissionBps: z.number().int().nonnegative().optional(),
  expiryTime: z.string().datetime().optional(),
  srcChain: z.string().optional(),
  srcAsset: z.string().optional(),
  destChain: z.string().optional(),
  destAsset: z.string().optional(),
  destAddress: z.string().optional(),
  refundAddress: z.string().optional(),
  minBtcAmount: z.string().optional(),
  maxBtcAmount: z.string().optional(),
  channelId: z.string().optional(),
  issuedBlock: z.number().int().nonnegative().optional(),
});

export type ChainflipDepositChannel = z.infer<typeof ChainflipDepositChannelSchema>;

export const ChainflipStatusSchema = z.object({
  state: z.enum([
    'WAITING',
    'RECEIVING',
    'SWAPPING',
    'SENDING',
    'SENT',
    'COMPLETED',
    'FAILED',
  ]),
  depositChannel: ChainflipDepositChannelSchema.optional(),
  destAddress: z.string().optional(),
  egressAmount: z.string().optional(),
  refundAddress: z.string().optional(),
});

export type ChainflipStatus = z.infer<typeof ChainflipStatusSchema>;

import { z } from 'zod';

export const ThornodeInboundAddressSchema = z.object({
  chain: z.string(),
  address: z.string(),
  router: z.string().optional(),
  halted: z.boolean(),
  pub_key: z.string().optional(),
  global_trading_paused: z.boolean().optional(),
  chain_trading_paused: z.boolean().optional(),
  chain_lp_actions_paused: z.boolean().optional(),
  gas_rate: z.string().optional(),
  gas_rate_units: z.string().optional(),
  outbound_fee: z.string().optional(),
  outbound_tx_size: z.string().optional(),
});

export type ThornodeInboundAddress = z.infer<typeof ThornodeInboundAddressSchema>;

export const ThornodeInboundAddressesSchema = z.array(ThornodeInboundAddressSchema);

// /thorchain/vaults/asgard returns every Asgard vault. During churn there
// are typically two active per chain (ActiveVault + RetiringVault, both
// legitimate for in-flight swaps). We only consume status + addresses.
export const AsgardVaultAddressSchema = z.object({
  chain: z.string(),
  address: z.string(),
});

export type AsgardVaultAddress = z.infer<typeof AsgardVaultAddressSchema>;

export const AsgardVaultSchema = z
  .object({
    status: z.string(),
    addresses: z.array(AsgardVaultAddressSchema),
  })
  .passthrough();

export type AsgardVault = z.infer<typeof AsgardVaultSchema>;

export const AsgardVaultsResponseSchema = z.array(AsgardVaultSchema);

export const ThornodeQuoteSchema = z.object({
  expected_amount_out: z.string(),
  inbound_address: z.string().optional(),
  memo: z.string().optional(),
  fees: z
    .object({
      asset: z.string().optional(),
      affiliate: z.string().optional(),
      outbound: z.string().optional(),
      liquidity: z.string().optional(),
      total: z.string().optional(),
    })
    .partial()
    .optional(),
});

export type ThornodeQuote = z.infer<typeof ThornodeQuoteSchema>;

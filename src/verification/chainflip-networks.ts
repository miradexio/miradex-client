// Hardcoded per network so the SDK never trusts a server-supplied
// verification.status_url. Modes:
//   rest     - GET ${statusUrl}/<channelId> at the hosted broker
//              (mainnet/testnet; the testnet flag only governs atomicswap)
//   jsonrpc  - POST cf_deposit_channel_info at the regtest localnet broker
// Single-source on REST is unavoidable: the public mainnet state-chain RPC
// (mainnet-archive.chainflip.io) only exposes "all open channels", not
// per-channel lookup. Returns undefined for unconfigured networks — SDK
// fails closed.

export type ChainflipNetwork = 'mainnet' | 'testnet' | 'regtest';

export type ChainflipVerificationEndpoints =
  | {
      /** Hosted broker REST. SDK appends /<channelId> to statusUrl. */
      readonly mode: 'rest';
      readonly statusUrl: string;
    }
  | {
      /** Regtest localnet broker exposing legacy cf_deposit_channel_info RPC. */
      readonly mode: 'jsonrpc';
      readonly rpcUrl: string;
    };

const DEFAULT_REGTEST_VERIFIER_URL = 'http://127.0.0.1:9099';

// /v2/swaps/<channelId> is the documented public lookup. The bare host is
// also configured as CHAINFLIP_BACKEND_URL in
// apps/crypto-server/src/swap/services/swap.constants.ts:28.
const CHAINFLIP_MAINNET_STATUS = 'https://chainflip-swap.chainflip.io/v2/swaps';

export const CHAINFLIP_VERIFICATION_NETWORKS: Readonly<
  Partial<Record<ChainflipNetwork, ChainflipVerificationEndpoints>>
> = {
  mainnet: {
    mode: 'rest',
    statusUrl: CHAINFLIP_MAINNET_STATUS,
  },
  testnet: {
    mode: 'rest',
    statusUrl: CHAINFLIP_MAINNET_STATUS,
  },
  regtest: {
    mode: 'jsonrpc',
    rpcUrl: DEFAULT_REGTEST_VERIFIER_URL,
  },
};

export function chainflipEndpointsForNetwork(
  network: ChainflipNetwork,
): ChainflipVerificationEndpoints | undefined {
  return CHAINFLIP_VERIFICATION_NETWORKS[network];
}

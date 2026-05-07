// Hardcoded per network so the SDK never trusts a server-supplied
// verification.inbound_addresses_url. On regtest the URL points at the
// system-tests fake-verifier (system-tests/verifier/), which serves a
// ThornodeInboundAddressesSchema-shaped response from the swap row.
// Returns undefined for unconfigured networks — SDK fails closed.

export type ThorchainNetwork = 'mainnet' | 'testnet' | 'regtest';

export interface ThorchainVerificationEndpoints {
  // GET returns an array of primary-per-chain inbounds.
  readonly inboundAddressesUrl: string;
  // GET returns every Asgard vault. Fallback for the churn window where the
  // primary has rotated but the retiring vault still legitimately accepts
  // in-flight deposits. Optional (skipped on regtest).
  readonly asgardVaultsUrl?: string;
}

// Distinct from chainflip's regtest port (9099) so both stacks can run
// side-by-side.
const DEFAULT_REGTEST_VERIFIER_URL = 'http://127.0.0.1:9098/thorchain/inbound_addresses';

// Liquify is primary because *.thorchain.network HTTP-403s some IPs.
// Nine Realms (*.ninerealms.com) was retired April 2025.
const THORCHAIN_MAINNET_INBOUND_ADDRESSES =
  'https://gateway.liquify.com/chain/thorchain_api/thorchain/inbound_addresses';
const THORCHAIN_MAINNET_ASGARD_VAULTS =
  'https://gateway.liquify.com/chain/thorchain_api/thorchain/vaults/asgard';

// No usable public THORChain stagenet exists (legacy stagenet-thornode.ninerealms.com
// was retired April 2025, no replacement). The `testnet` flag governs
// atomicswap only; thorchain/chainflip/near-intents run on mainnet
// regardless. Testnet swaps are real-money — UI shows a banner.
export const THORCHAIN_VERIFICATION_NETWORKS: Readonly<
  Partial<Record<ThorchainNetwork, ThorchainVerificationEndpoints>>
> = {
  mainnet: {
    inboundAddressesUrl: THORCHAIN_MAINNET_INBOUND_ADDRESSES,
    asgardVaultsUrl: THORCHAIN_MAINNET_ASGARD_VAULTS,
  },
  testnet: {
    inboundAddressesUrl: THORCHAIN_MAINNET_INBOUND_ADDRESSES,
    asgardVaultsUrl: THORCHAIN_MAINNET_ASGARD_VAULTS,
  },
  regtest: {
    inboundAddressesUrl: DEFAULT_REGTEST_VERIFIER_URL,
  },
};

export function thorchainEndpointsForNetwork(
  network: ThorchainNetwork,
): ThorchainVerificationEndpoints | undefined {
  return THORCHAIN_VERIFICATION_NETWORKS[network];
}

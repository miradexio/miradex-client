// Per-provider verification dispatcher. Each path validates against the
// provider's own infrastructure (THORNode vaults, Chainflip channels,
// 1Click intent registry, atomic-swap lock script). Common client-side
// checks (address presence, output amount, destination match) run for all.

import type { Logger } from '../interfaces/logger.js';
import { noopLogger } from '../interfaces/logger.js';
import type {
  SwapVerification,
  VerificationResult,
  VerificationCheck,
} from '../types/index.js';
import { VerificationError } from '../types/index.js';
import { verifyAtomicSwap } from './atomic-swap.js';
import { verifyThorchain } from './thorchain.js';
import { verifyChainflip } from './chainflip.js';
import { verifyNearIntents } from './near-intents.js';
import type { ProtocolContext } from './shared.js';
import { check } from './shared.js';
import type { ChainflipNetwork } from './chainflip-networks.js';

export { parseThorchainMemo, requireMemoBindsDestination } from './memo.js';
export type { ParsedThorchainMemo } from './memo.js';
export { verifyAtomicSwap, verifyThorchain, verifyChainflip, verifyNearIntents };
export { fetchThorchainVaults, verifyThorchainQuote } from './thorchain.js';
export type {
  FetchThorchainVaultsInput,
  VerifyThorchainQuoteInput,
} from './thorchain.js';
export { verifyChainflipChannel } from './chainflip.js';
export type { VerifyChainflipChannelInput } from './chainflip.js';
export {
  CHAINFLIP_VERIFICATION_NETWORKS,
  chainflipEndpointsForNetwork,
} from './chainflip-networks.js';
export type {
  ChainflipNetwork,
  ChainflipVerificationEndpoints,
} from './chainflip-networks.js';
export {
  THORCHAIN_VERIFICATION_NETWORKS,
  thorchainEndpointsForNetwork,
} from './thorchain-networks.js';
export type {
  ThorchainNetwork,
  ThorchainVerificationEndpoints,
} from './thorchain-networks.js';
export {
  fetchNearIntentStatus,
  requireIntentBinds,
  requireIntentDeadlineMargin,
  verifyNearIntentOnChain,
} from './near-intents.js';
export type {
  FetchNearIntentStatusInput,
  RequireIntentBindsInput,
  VerifyNearIntentOnChainInput,
} from './near-intents.js';
export { fetchConsensusRate } from './rate-oracle.js';
export type { RateOracleConfig } from './rate-oracle.js';
export { VERIFY_FETCH_TIMEOUT_MS, VERIFY_MAX_ATTEMPTS, VERIFY_RETRY_DELAY_MS } from './constants.js';

export interface VerifyDepositParams {
  readonly depositAddress: string;
  readonly verification: SwapVerification;
  readonly destAddress: string;
  readonly refundAddress: string;
  readonly toToken: string;
  readonly amount: string;
  readonly fromChain?: string;
  readonly toChain?: string;
  readonly fromToken?: string;
  readonly network?: ChainflipNetwork;
  readonly protocol?: ProtocolContext;
  readonly expectedAmountOut?: string;
  readonly expectedDestAddress?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly resume?: boolean;
  readonly logger?: Logger;
  // Wire from the engine's AbortController so engine.destroy() stops
  // verification mid-flight. Without this the chainflip REST retry loop
  // can keep polling for CHAINFLIP_REST_RETRY_TOTAL_MS (120s) past destroy.
  readonly signal?: AbortSignal;
}

// Throws E_PROVIDER_UNKNOWN for an unknown provider, E_UNEXPECTED_TIMELOCK
// when timelock_blocks is set on a non-atomicswap provider.
export async function verifyDepositAddress(
  params: VerifyDepositParams,
): Promise<VerificationResult> {
  const {
    depositAddress,
    verification,
    destAddress,
    refundAddress,
    toToken,
    amount,
    fromChain,
    toChain,
    fromToken,
    network = 'mainnet',
    protocol,
    expectedAmountOut,
    expectedDestAddress,
    fetchFn = globalThis.fetch,
    resume,
    logger = noopLogger,
    signal,
  } = params;

  const verifyParams = {
    destAddress,
    refundAddress,
    toToken,
    amount,
    fromChain,
    toChain,
    fromToken,
  };

  // AV-A.13: timelock_blocks is only meaningful for atomicswap. Anything
  // else is a client bug or a server confusion attempt; fail loud.
  if (verification.provider !== 'atomicswap' && protocol?.timelock_blocks !== undefined) {
    throw new VerificationError(
      'E_UNEXPECTED_TIMELOCK',
      `timelock_blocks is set for non-atomicswap provider ${verification.provider}`,
    );
  }

  let providerResult: VerificationResult;
  switch (verification.provider) {
    case 'thorchain':
      providerResult = await verifyThorchain(
        depositAddress, verification, verifyParams, fetchFn, network, resume, signal,
      );
      break;
    case 'chainflip':
      providerResult = await verifyChainflip(
        depositAddress,
        verification,
        verifyParams,
        fetchFn,
        network,
        signal,
      );
      break;
    case 'near_intents':
      providerResult = await verifyNearIntents(verification, fetchFn, signal);
      break;
    case 'atomicswap':
      providerResult = verifyAtomicSwap(verification, verifyParams, protocol);
      break;
    default: {
      const unknown: never = verification;
      throw new VerificationError('E_PROVIDER_UNKNOWN', `unknown provider: ${String((unknown as { provider: string }).provider)}`);
    }
  }

  const clientChecks: VerificationCheck[] = [];

  clientChecks.push(
    check(
      'Deposit address',
      !!depositAddress && depositAddress.length > 5,
      depositAddress ? `${depositAddress.slice(0, 12)}...` : 'Missing',
    ),
  );

  if (expectedAmountOut) {
    const amt = parseFloat(expectedAmountOut);
    clientChecks.push(check('Output amount', amt > 0, `${expectedAmountOut} ${toToken}`));
  }

  if (expectedDestAddress) {
    const match = expectedDestAddress === destAddress;
    const truncDest =
      expectedDestAddress.length > 20
        ? `${expectedDestAddress.slice(0, 6)}...${expectedDestAddress.slice(-6)}`
        : expectedDestAddress;
    clientChecks.push(
      check('Destination address', match, match ? truncDest : `MISMATCH: ${truncDest}`),
    );
  }

  const allChecks = [...providerResult.checks, ...clientChecks];
  const verified = allChecks.every((c) => c.passed);
  const failed = allChecks.filter((c) => !c.passed).map((c) => c.name);
  if (verified) {
    logger.info({ provider: providerResult.provider, checks: allChecks.length }, 'Verification passed');
  } else {
    logger.warn({ provider: providerResult.provider, failed }, 'Verification failed');
  }
  return {
    verified,
    provider: providerResult.provider,
    checks: allChecks,
    timestamp: Date.now(),
  };
}

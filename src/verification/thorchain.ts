import type { ThorchainVerification, VerificationCheck, VerificationResult } from '../types/index.js';
import type { Logger } from '../interfaces/logger.js';
import { check, errMsg, failOf, resultOf, type VerifyParams } from './shared.js';
import { requireMemoBindsDestination } from './memo.js';
import { VerificationError } from '../types/index.js';
import {
  ThornodeInboundAddressesSchema,
  type ThornodeInboundAddress,
  ThornodeQuoteSchema,
  type ThornodeQuote,
  AsgardVaultsResponseSchema,
} from '../wire/thorchain.zod.js';
import { VERIFY_FETCH_TIMEOUT_MS } from './constants.js';
import { thorchainEndpointsForNetwork, type ThorchainNetwork } from './thorchain-networks.js';

// Nine Realms retired April 2025. Liquify is listed first because
// *.thorchain.network gates some IPs/UAs with HTTP 403 ("the gates of
// Asgard are closed to you"); failover to thorchain.network preserves
// the two-source quorum in fetchThorchainVaults.
const THORNODE_URLS: readonly string[] = [
  'https://gateway.liquify.com/chain/thorchain_api/thorchain/inbound_addresses',
  'https://thornode.thorchain.network/thorchain/inbound_addresses',
];

const MIDGARD_URLS: readonly string[] = [
  'https://gateway.liquify.com/chain/thorchain_midgard/v2/thorchain/inbound_addresses',
  'https://midgard.thorchain.network/v2/thorchain/inbound_addresses',
];

// SDK-owned inbound-addresses endpoint (hardcoded per network in
// thorchain-networks.ts). v.inbound_addresses_url from the server is
// intentionally ignored so a compromised server can't redirect to its own
// infra. Memo parsed strictly per AV-A.14 / AV-K.6. Vault quorum + quote
// cross-check live in separate helpers. Fails closed if the network has
// no configured endpoints.
export async function verifyThorchain(
  depositAddress: string,
  v: ThorchainVerification,
  params: VerifyParams,
  fetchFn: typeof globalThis.fetch,
  network: ThorchainNetwork,
  resume?: boolean,
  externalSignal?: AbortSignal,
): Promise<VerificationResult> {
  const endpoints = thorchainEndpointsForNetwork(network);
  if (!endpoints) {
    return failOf('thorchain', [
      check(
        'THORChain verifier configured',
        false,
        `No verification endpoints registered for network "${network}"`,
      ),
    ]);
  }

  const checks: VerificationCheck[] = [];

  try {
    const res = await fetchFn(endpoints.inboundAddressesUrl, {
      signal: externalSignal !== undefined
        ? AbortSignal.any([AbortSignal.timeout(VERIFY_FETCH_TIMEOUT_MS), externalSignal])
        : AbortSignal.timeout(VERIFY_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return failOf('thorchain', [check('THORNode reachable', false, `HTTP ${res.status}`)]);
    }

    const raw: unknown = await res.json();
    const parsed = ThornodeInboundAddressesSchema.safeParse(raw);
    if (!parsed.success) {
      return failOf('thorchain', [check('THORNode response', false, 'Expected array of vaults')]);
    }
    const vaults = parsed.data;

    checks.push(check('THORNode reachable', true, `${vaults.length} inbound addresses`));

    if (!resume) {
      const primaryMatch = vaults.find((vault) => vault.address === depositAddress);
      let matchedVia: 'primary' | 'asgard-fallback' | null = primaryMatch ? 'primary' : null;
      let matchedAsgardStatus: string | null = null;

      // inbound_addresses only returns the current primary per chain. During
      // churn the previous (retiring) vault is still a valid destination, so
      // cross-check /thorchain/vaults/asgard before failing closed.
      if (!primaryMatch && endpoints.asgardVaultsUrl) {
        try {
          const asgardRes = await fetchFn(endpoints.asgardVaultsUrl, {
            signal: externalSignal !== undefined
              ? AbortSignal.any([AbortSignal.timeout(VERIFY_FETCH_TIMEOUT_MS), externalSignal])
              : AbortSignal.timeout(VERIFY_FETCH_TIMEOUT_MS),
          });
          if (asgardRes.ok) {
            const asgardRaw: unknown = await asgardRes.json();
            const asgardParsed = AsgardVaultsResponseSchema.safeParse(asgardRaw);
            if (asgardParsed.success) {
              for (const vault of asgardParsed.data) {
                const hit = vault.addresses.find((a) => a.address === depositAddress);
                if (hit) {
                  matchedVia = 'asgard-fallback';
                  matchedAsgardStatus = vault.status;
                  break;
                }
              }
            }
          }
        } catch {
          // Fallback failure is non-fatal: we still report the primary miss
          // below; don't escalate a fallback-URL network glitch into a
          // verification failure.
        }
      }

      if (matchedVia === 'primary' && primaryMatch) {
        checks.push(check('Asgard vault match', true, `Matched primary vault for ${primaryMatch.chain}`));
        checks.push(
          check(
            'Vault active',
            !primaryMatch.halted,
            primaryMatch.halted ? 'Vault is halted' : 'Vault is active',
          ),
        );
      } else if (matchedVia === 'asgard-fallback') {
        // Found in the wider asgard list (legitimate during churn).
        // Tag detail so the UI can show "Matched (rotating)".
        checks.push(
          check(
            'Asgard vault match',
            true,
            `Matched asgard (${matchedAsgardStatus ?? 'active'} during rotation)`,
          ),
        );
      } else {
        checks.push(check('Asgard vault match', false, 'Address not in active vaults'));
      }
    }

    if (v.registered_memo) {
      let memoOk = false;
      let memoDetail = 'Memo mismatch';
      try {
        requireMemoBindsDestination(v.registered_memo, params.destAddress);
        memoOk = true;
        memoDetail = 'Memo binds correct destination';
      } catch (err) {
        if (err instanceof VerificationError) {
          memoDetail = `${err.code}: ${err.message}`;
        } else {
          memoDetail = errMsg(err);
        }
      }
      checks.push(check('Memo destination', memoOk, memoDetail));
    }
  } catch (err: unknown) {
    checks.push(check('THORNode verification', false, errMsg(err)));
  }

  return resultOf('thorchain', checks);
}

export interface FetchThorchainVaultsInput {
  readonly fetchFn: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

// Two-source quorum: returns vaults present in >=2 independent sources
// agreeing on (chain, address) and not halted/paused. Throws
// E_THORCHAIN_QUORUM when fewer than 2 sources respond.
export async function fetchThorchainVaults(
  input: FetchThorchainVaultsInput,
): Promise<readonly ThornodeInboundAddress[]> {
  const timeoutMs = input.timeoutMs ?? VERIFY_FETCH_TIMEOUT_MS;
  const urls = [...THORNODE_URLS, ...MIDGARD_URLS];
  const attempts = urls.map((url) => fetchValidatedList(url, input.fetchFn, timeoutMs));
  const settled = await Promise.allSettled(attempts);
  const successes = settled
    .filter((s): s is PromiseFulfilledResult<readonly ThornodeInboundAddress[]> => s.status === 'fulfilled')
    .map((s) => s.value);
  if (successes.length < 2) {
    throw new VerificationError(
      'E_THORCHAIN_QUORUM',
      `only ${String(successes.length)} of ${String(urls.length)} vault sources responded`,
    );
  }
  return reconcileVaults(successes);
}

async function fetchValidatedList(
  url: string,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<readonly ThornodeInboundAddress[]> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const raw = await res.json();
  return ThornodeInboundAddressesSchema.parse(raw);
}

function vaultKey(v: ThornodeInboundAddress): string {
  return `${v.chain}:${v.address}`;
}

function reconcileVaults(
  lists: ReadonlyArray<readonly ThornodeInboundAddress[]>,
): readonly ThornodeInboundAddress[] {
  const counts = new Map<string, { readonly vault: ThornodeInboundAddress; count: number }>();
  for (const list of lists) {
    const seen = new Set<string>();
    for (const v of list) {
      const key = vaultKey(v);
      if (seen.has(key)) continue;
      seen.add(key);
      const slot = counts.get(key);
      if (slot) slot.count += 1;
      else counts.set(key, { vault: v, count: 1 });
    }
  }
  const accepted: ThornodeInboundAddress[] = [];
  for (const [, slot] of counts) {
    if (slot.count < 2) continue;
    if (slot.vault.halted) continue;
    if (slot.vault.chain_trading_paused === true) continue;
    accepted.push(slot.vault);
  }
  return accepted;
}

export interface VerifyThorchainQuoteInput {
  readonly fromAsset: string;
  readonly toAsset: string;
  readonly amountSats: string;
  readonly destAddress: string;
  readonly engineExpectedOut: string;
  readonly slippageBps: number;
  readonly fetchFn: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly thornodeUrls?: readonly string[];
}

// Cross-check engine.expectedOutput against a live THORNode quote from >=1
// source (ideally 2). Throws E_THORNODE_QUOTE_UNAVAILABLE if no source
// responds, E_RATE_DRIFT if engine value is outside the slippage band
// around the node-quote median.
export async function verifyThorchainQuote(input: VerifyThorchainQuoteInput): Promise<void> {
  const timeoutMs = input.timeoutMs ?? VERIFY_FETCH_TIMEOUT_MS;
  const base = input.thornodeUrls ?? [
    'https://gateway.liquify.com/chain/thorchain_api',
    'https://thornode.thorchain.network',
  ];
  const attempts = base.map((root) =>
    fetchThornodeQuote(
      `${root}/thorchain/quote/swap?from_asset=${encodeURIComponent(input.fromAsset)}&to_asset=${encodeURIComponent(input.toAsset)}&amount=${encodeURIComponent(input.amountSats)}&destination=${encodeURIComponent(input.destAddress)}`,
      input.fetchFn,
      timeoutMs,
    ),
  );
  const settled = await Promise.allSettled(attempts);
  const quotes = settled
    .filter((s): s is PromiseFulfilledResult<ThornodeQuote> => s.status === 'fulfilled')
    .map((s) => s.value);
  if (quotes.length < 1) {
    throw new VerificationError(
      'E_THORNODE_QUOTE_UNAVAILABLE',
      'could not fetch a THORNode quote from any source',
    );
  }
  const values = quotes.map((q) => BigInt(q.expected_amount_out));
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted[Math.floor(sorted.length / 2)] ?? values[0] ?? 0n;
  const engine = BigInt(input.engineExpectedOut);
  const tolerance = (mid * BigInt(input.slippageBps)) / 10_000n;
  if (engine < mid - tolerance || engine > mid + tolerance) {
    throw new VerificationError(
      'E_RATE_DRIFT',
      `engine expectedOut ${engine.toString()} outside slippage band ${(mid - tolerance).toString()}..${(mid + tolerance).toString()}`,
    );
  }
}

async function fetchThornodeQuote(
  url: string,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ThornodeQuote> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const raw = await res.json();
  return ThornodeQuoteSchema.parse(raw);
}

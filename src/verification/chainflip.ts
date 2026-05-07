import type { ChainflipVerification, VerificationCheck, VerificationResult } from '../types/index.js';
import { check, errMsg, failOf, resultOf, type VerifyParams } from './shared.js';
import {
  CHAINFLIP_REST_RETRY_BACKOFF_MS,
  CHAINFLIP_REST_RETRY_TOTAL_MS,
  VERIFY_FETCH_TIMEOUT_MS,
} from './constants.js';
import { VerificationError } from '../types/index.js';
import {
  ChainflipDepositChannelSchema,
  type ChainflipDepositChannel,
} from '../wire/chainflip.zod.js';
import {
  chainflipEndpointsForNetwork,
  type ChainflipNetwork,
  type ChainflipVerificationEndpoints,
} from './chainflip-networks.js';

const CHANNEL_SAFETY_MARGIN_MS = 90 * 60 * 1000;

// Reads the SDK-owned broker REST endpoint (hardcoded per network in
// chainflip-networks.ts; v.status_url from the server is ignored).
// Single-source by necessity: the only browser-reachable mainnet
// state-chain RPC has no per-channel lookup. Trust posture: the broker is
// Chainflip's own infra; a misreport can't move funds because the user's
// wallet still holds them. Fails closed when no verifier is configured.
export async function verifyChainflip(
  depositAddress: string,
  v: ChainflipVerification,
  params: VerifyParams,
  fetchFn: typeof globalThis.fetch,
  network: ChainflipNetwork,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const endpoints = chainflipEndpointsForNetwork(network);
  if (!endpoints) {
    return failOf('chainflip', [
      check(
        'Chainflip verifier configured',
        false,
        `No verification endpoints registered for network "${network}"`,
      ),
    ]);
  }

  if (params.fromChain === undefined || params.toChain === undefined) {
    return failOf('chainflip', [
      check(
        'Chainflip verification inputs',
        false,
        'fromChain/toChain required for chainflip channel check',
      ),
    ]);
  }

  const checks: VerificationCheck[] = [];
  try {
    await verifyChainflipChannel({
      channelId: v.channel_id,
      endpoints,
      expected: {
        destAddress: params.destAddress,
        refundAddress: params.refundAddress.length > 0 ? params.refundAddress : undefined,
        srcChain: params.fromChain,
        destChain: params.toChain,
        destAsset: params.toToken,
      },
      fetchFn,
      signal,
    });
    checks.push(check('Chainflip channel verified', true, 'Broker binding matches expected'));
    const channelDepositOk = depositAddress.length > 0;
    checks.push(
      check(
        'Deposit address present',
        channelDepositOk,
        channelDepositOk ? `${depositAddress.slice(0, 12)}...` : 'Missing',
      ),
    );
  } catch (err: unknown) {
    checks.push(check('Chainflip channel verified', false, errMsg(err)));
  }
  return resultOf('chainflip', checks);
}

export interface VerifyChainflipChannelInput {
  readonly channelId: string;
  // Discriminated on mode:
  //   rest    - GET ${statusUrl}/<channelId> at the hosted broker (mainnet/testnet)
  //   jsonrpc - POST cf_deposit_channel_info at a localnet broker (regtest)
  readonly endpoints: ChainflipVerificationEndpoints;
  readonly expected: {
    readonly destAddress: string;
    readonly refundAddress?: string;
    readonly srcChain: string;
    readonly destChain: string;
    readonly destAsset: string;
  };
  readonly depositAmountSats?: string;
  readonly fetchFn: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  // Bails the retry loop immediately so we don't burn the
  // CHAINFLIP_REST_RETRY_TOTAL_MS budget after destroy().
  readonly signal?: AbortSignal;
}

// Throws E_CHAINFLIP_CHANNEL_MISBINDING on dest/refund mismatch,
// E_CHAINFLIP_CHANNEL_EXPIRING within the safety margin,
// E_CHAINFLIP_AMOUNT_BELOW_MIN / _ABOVE_MAX out of band.
export async function verifyChainflipChannel(
  input: VerifyChainflipChannelInput,
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? VERIFY_FETCH_TIMEOUT_MS;
  const channel =
    input.endpoints.mode === 'rest'
      ? await fetchBrokerChannelRest(
          input.endpoints.statusUrl,
          input.channelId,
          input.fetchFn,
          timeoutMs,
          input.signal,
        )
      : await fetchBrokerChannelJsonRpc(
          input.endpoints.rpcUrl,
          input.channelId,
          input.fetchFn,
          timeoutMs,
          input.signal,
        );
  requireBindsExpected(channel, input.expected);
  if (input.depositAmountSats !== undefined) {
    requireAmountInBand(channel, input.depositAmountSats);
  }
  if (channel.expiryTime) {
    requireExpiryMargin(channel.expiryTime);
  }
}

// v2 hosted broker returns a status wrapper with a nested depositChannel and
// the binding fields (srcChain, destChain, destAsset, destAddress,
// refundAddress) at the wrapper top level. Localnet / older brokers still
// emit the flat channel shape. Try flat first, then merge nested + wrapper
// with wrapper winning for fields the channel omits. Tolerates unknown
// fields / unknown state values; v2 evolves faster than we'd hardcode.
function parseBrokerResponse(raw: unknown): ChainflipDepositChannel {
  const flat = ChainflipDepositChannelSchema.safeParse(raw);
  if (flat.success && flat.data.srcChain && flat.data.destChain) {
    return flat.data;
  }

  if (typeof raw !== 'object' || raw === null) {
    throw flat.error ?? new Error('Chainflip broker response is not an object');
  }

  const wrapper = raw as Record<string, unknown>;
  const nestedRaw = wrapper['depositChannel'];
  if (typeof nestedRaw !== 'object' || nestedRaw === null) {
    throw flat.error;
  }
  const channel = ChainflipDepositChannelSchema.parse(nestedRaw);

  // Hoist the binding fields. Wrapper wins when the channel omits them
  // (typical on v2). refundAddress lives at several nested paths depending
  // on the Chainflip API revision (fillOrKillParams.refundAddress,
  // refundParameters.refundAddress, top-level, under depositChannel).
  // Walk all known paths before declaring it missing.
  return {
    ...channel,
    srcChain: channel.srcChain ?? readPath(wrapper, [['srcChain']]),
    srcAsset: channel.srcAsset ?? readPath(wrapper, [['srcAsset']]),
    destChain: channel.destChain ?? readPath(wrapper, [['destChain']]),
    destAsset: channel.destAsset ?? readPath(wrapper, [['destAsset']]),
    destAddress: channel.destAddress ?? readPath(wrapper, [['destAddress']]),
    refundAddress:
      channel.refundAddress ??
      readPath(wrapper, [
        ['refundAddress'],
        ['refundParameters', 'refundAddress'],
        ['refundParameters', 'refund_address'],
        ['fillOrKillParams', 'refundAddress'],
        ['fillOrKillParams', 'refund_address'],
        ['depositChannel', 'refundParameters', 'refundAddress'],
        ['depositChannel', 'refundParameters', 'refund_address'],
        ['depositChannel', 'fillOrKillParams', 'refundAddress'],
        ['depositChannel', 'fillOrKillParams', 'refund_address'],
      ]),
  };
}

// Returns the first non-empty string found at any of the listed paths.
function readPath(
  obj: Record<string, unknown>,
  paths: readonly (readonly string[])[],
): string | undefined {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const key of path) {
      if (typeof cur !== 'object' || cur === null) {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[key];
    }
    if (typeof cur === 'string' && cur.length > 0) return cur;
  }
  return undefined;
}

async function fetchBrokerChannelRest(
  baseUrl: string,
  channelId: string,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<ChainflipDepositChannel> {
  // GET ${baseUrl}/${channelId}; trim trailing slash so callers can pass
  // either form. cache:'no-store' avoids a 304 Not Modified with empty body
  // on page reload (the conditional request would have nothing to parse).
  const url = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(channelId)}`;
  const start = Date.now();
  let attempt = 0;
  let lastError: VerificationError = new VerificationError(
    'E_CHAINFLIP_HTTP',
    'broker request not yet attempted',
  );

  while (Date.now() - start < CHAINFLIP_REST_RETRY_TOTAL_MS) {
    if (externalSignal?.aborted) {
      throw new VerificationError(
        'E_CHAINFLIP_HTTP',
        'verification aborted by caller',
      );
    }
    try {
      // `cache` is browser-only; no-op in Node where ES2022 lib types
      // omit it. Combined signal so either timeout or external abort
      // cancels the in-flight request.
      const init: RequestInit & { readonly cache?: 'no-store' } = {
        signal: combineSignals(AbortSignal.timeout(timeoutMs), externalSignal),
        cache: 'no-store',
      };
      const res = await fetchFn(url, init);
      if (res.ok) {
        const raw = await res.json();
        // parseBrokerResponse handles both v2 (nested) and legacy (flat).
        return parseBrokerResponse(raw);
      }
      // 304 only happens if the no-store directive is bypassed
      // (older browsers, service workers, intermediary proxies). Body
      // is empty, fall through to a fresh retry.
      if (res.status === 304) {
        lastError = new VerificationError(
          'E_CHAINFLIP_HTTP',
          'broker returned 304 — cache directive bypassed, retrying',
        );
      } else if (res.status >= 400 && res.status < 500 && res.status !== 404) {
        // 4xx (excluding 404) means bad path / malformed id; retrying won't help.
        throw new VerificationError(
          'E_CHAINFLIP_HTTP',
          `broker HTTP ${String(res.status)}`,
        );
      } else {
        // 404 (channel not yet ingested by REST) and 5xx (gateway / state
        // chain RPC blip) are transient — keep retrying.
        lastError = new VerificationError(
          'E_CHAINFLIP_HTTP',
          `broker HTTP ${String(res.status)}`,
        );
      }
    } catch (err) {
      if (err instanceof VerificationError) throw err;
      // Network / timeout / zod parse — treat as transient.
      lastError = new VerificationError(
        'E_CHAINFLIP_HTTP',
        err instanceof Error ? err.message : String(err),
      );
    }

    const backoffMs =
      CHAINFLIP_REST_RETRY_BACKOFF_MS[attempt] ??
      CHAINFLIP_REST_RETRY_BACKOFF_MS[CHAINFLIP_REST_RETRY_BACKOFF_MS.length - 1] ??
      30_000;
    attempt += 1;
    if (Date.now() - start + backoffMs >= CHAINFLIP_REST_RETRY_TOTAL_MS) break;
    await sleepAbortable(backoffMs, externalSignal);
    if (externalSignal?.aborted) {
      throw new VerificationError(
        'E_CHAINFLIP_HTTP',
        'verification aborted by caller',
      );
    }
  }

  throw lastError;
}

// Returns the timeout signal alone if no external is provided so older
// runtimes without AbortSignal.any still work in the common case.
function combineSignals(
  timeout: AbortSignal,
  external?: AbortSignal,
): AbortSignal {
  if (external === undefined) return timeout;
  // AbortSignal.any is in Node 20+ and all modern browsers (same baseline
  // as AbortSignal.timeout above).
  return AbortSignal.any([timeout, external]);
}

// Resolves early on abort. Does NOT throw — caller checks signal.aborted
// after the await and decides how to fail.
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal.addEventListener('abort', onAbort);
  });
}

// Regtest only: the localnet broker exposes the legacy
// cf_deposit_channel_info state-chain RPC that the public broker doesn't.
async function fetchBrokerChannelJsonRpc(
  rpcUrl: string,
  channelId: string,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<ChainflipDepositChannel> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'cf_deposit_channel_info',
    params: { channel_id: channelId },
  };
  const res = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: combineSignals(AbortSignal.timeout(timeoutMs), externalSignal),
  });
  if (!res.ok) {
    throw new VerificationError('E_CHAINFLIP_HTTP', `state-chain HTTP ${String(res.status)}`);
  }
  const raw = (await res.json()) as { result?: unknown };
  return ChainflipDepositChannelSchema.parse(raw.result);
}

// crypto-server emits 'ethereum'; Chainflip REST returns 'Ethereum'.
function canonicalChain(chain: string | undefined): string | undefined {
  return chain ? chain.toLowerCase() : undefined;
}

// Chainflip is uppercase but callers sometimes pass mixed case.
function canonicalAsset(asset: string | undefined): string | undefined {
  return asset ? asset.toLowerCase() : undefined;
}

// Hex addresses come back in unspecified case; compare case-insensitively.
// Bitcoin/Polkadot/Solana are case-sensitive and pass through unchanged.
function canonicalAddress(addr: string | undefined): string | undefined {
  if (!addr) return undefined;
  return addr.startsWith('0x') ? addr.toLowerCase() : addr;
}

function requireBindsExpected(
  channel: ChainflipDepositChannel,
  expected: VerifyChainflipChannelInput['expected'],
): void {
  if (canonicalAddress(channel.destAddress) !== canonicalAddress(expected.destAddress)) {
    throw new VerificationError(
      'E_CHAINFLIP_CHANNEL_MISBINDING',
      `channel destAddress ${String(channel.destAddress)} != expected ${expected.destAddress}`,
    );
  }
  if (canonicalChain(channel.srcChain) !== canonicalChain(expected.srcChain)) {
    throw new VerificationError(
      'E_CHAINFLIP_CHANNEL_MISBINDING',
      `channel srcChain ${String(channel.srcChain)} != expected ${expected.srcChain}`,
    );
  }
  if (canonicalChain(channel.destChain) !== canonicalChain(expected.destChain)) {
    throw new VerificationError(
      'E_CHAINFLIP_CHANNEL_MISBINDING',
      `channel destChain ${String(channel.destChain)} != expected ${expected.destChain}`,
    );
  }
  if (canonicalAsset(channel.destAsset) !== canonicalAsset(expected.destAsset)) {
    throw new VerificationError(
      'E_CHAINFLIP_CHANNEL_MISBINDING',
      `channel destAsset ${String(channel.destAsset)} != expected ${expected.destAsset}`,
    );
  }
  // Soft check: /v2/swaps/<id> doesn't always expose refundAddress. When
  // present we strictly require a match (catches a broker rebind attack);
  // when absent we skip rather than fail on a check we can't perform.
  if (
    expected.refundAddress !== undefined &&
    channel.refundAddress !== undefined &&
    canonicalAddress(channel.refundAddress) !== canonicalAddress(expected.refundAddress)
  ) {
    throw new VerificationError(
      'E_CHAINFLIP_CHANNEL_MISBINDING',
      `channel refundAddress ${String(channel.refundAddress)} != expected ${expected.refundAddress}`,
    );
  }
}

function requireAmountInBand(channel: ChainflipDepositChannel, amountSats: string): void {
  const amount = BigInt(amountSats);
  if (channel.minBtcAmount !== undefined && amount < BigInt(channel.minBtcAmount)) {
    throw new VerificationError(
      'E_CHAINFLIP_AMOUNT_BELOW_MIN',
      `deposit ${amount.toString()} below channel min ${channel.minBtcAmount}`,
    );
  }
  if (channel.maxBtcAmount !== undefined && amount > BigInt(channel.maxBtcAmount)) {
    throw new VerificationError(
      'E_CHAINFLIP_AMOUNT_ABOVE_MAX',
      `deposit ${amount.toString()} above channel max ${channel.maxBtcAmount}`,
    );
  }
}

function requireExpiryMargin(expiryTime: string): void {
  const expiryMs = new Date(expiryTime).getTime();
  if (Number.isNaN(expiryMs)) return;
  const remaining = expiryMs - Date.now();
  if (remaining < CHANNEL_SAFETY_MARGIN_MS) {
    throw new VerificationError(
      'E_CHAINFLIP_CHANNEL_EXPIRING',
      `channel expires in ${(remaining / 60_000).toFixed(1)} minutes, below safety margin`,
    );
  }
}

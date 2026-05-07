import type { NearIntentsVerification, VerificationCheck, VerificationResult } from '../types/index.js';
import { check, errMsg, failOf, resultOf } from './shared.js';
import { VerificationError } from '../types/index.js';
import {
  NearIntentRawStatusSchema,
  NearIntentOnChainSchema,
  NearRpcResponseSchema,
  type NearIntentStatusResponse,
} from '../wire/near-intents.zod.js';
import { VERIFY_FETCH_TIMEOUT_MS } from './constants.js';

// 1Click status enum (7 values). INCOMPLETE_DEPOSIT means "deposit observed
// but below bridge minimum" — intent is registered and the address is real,
// so it counts as active here. Source: 1Click OpenAPI v0.1.10.
const ACTIVE_STATUSES: readonly string[] = [
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
];

const INTENT_DEADLINE_MARGIN_MS = 90 * 60 * 1000;

// Explicit status enum switch (no '!== NOT_FOUND' substring matching).
export async function verifyNearIntents(
  v: NearIntentsVerification,
  fetchFn: typeof globalThis.fetch,
  externalSignal?: AbortSignal,
): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];

  // Schema permits null status_url; surface explicitly rather than fetch(null).
  if (!v.status_url) {
    return failOf('near_intents', [
      check('NEAR reachable', false, 'No public status URL available'),
    ]);
  }

  try {
    const res = await fetchFn(v.status_url, {
      signal: externalSignal !== undefined
        ? AbortSignal.any([AbortSignal.timeout(VERIFY_FETCH_TIMEOUT_MS), externalSignal])
        : AbortSignal.timeout(VERIFY_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return failOf('near_intents', [check('NEAR reachable', false, `HTTP ${res.status}`)]);
    }

    const rawNear: unknown = await res.json();
    if (typeof rawNear !== 'object' || rawNear === null) {
      return failOf('near_intents', [check('NEAR response', false, 'Expected object')]);
    }
    const data = rawNear as { status?: string };
    checks.push(check('NEAR reachable', true, 'Status endpoint responded'));

    const status = data.status;
    const registered = typeof status === 'string' && ACTIVE_STATUSES.includes(status);
    checks.push(
      check(
        'Intent registered',
        registered,
        registered ? `Status: ${status}` : `Status: ${status ?? 'unknown'}`,
      ),
    );
  } catch (err: unknown) {
    checks.push(check('NEAR verification', false, errMsg(err)));
  }

  return resultOf('near_intents', checks);
}

export interface FetchNearIntentStatusInput {
  readonly statusUrl: string;
  readonly fetchFn: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

// HTTP/status -> error code:
//   404                          -> E_NEAR_INTENT_NOT_REGISTERED
//   non-2xx (non-404)            -> E_NEAR_INTENT_FAILED
//   status === FAILED            -> E_NEAR_INTENT_FAILED
//   PENDING_DEPOSIT/PROCESSING/SUCCESS/REFUNDED/... -> flattened response
// 1Click has no EXPIRED status; past-deadline is detected via
// requireIntentDeadlineMargin against quote.deadline.
export async function fetchNearIntentStatus(
  input: FetchNearIntentStatusInput,
): Promise<NearIntentStatusResponse> {
  const timeoutMs = input.timeoutMs ?? VERIFY_FETCH_TIMEOUT_MS;
  const res = await input.fetchFn(input.statusUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) {
    throw new VerificationError(
      'E_NEAR_INTENT_NOT_REGISTERED',
      'deposit address unknown to 1Click (HTTP 404)',
    );
  }
  if (!res.ok) {
    throw new VerificationError('E_NEAR_INTENT_FAILED', `HTTP ${String(res.status)}`);
  }
  const raw = await res.json();
  const parsed = NearIntentRawStatusSchema.parse(raw);
  if (parsed.status === 'FAILED') {
    throw new VerificationError(
      'E_NEAR_INTENT_FAILED',
      `intent failed on 1Click${
        parsed.swapDetails.refundReason ? ` (${parsed.swapDetails.refundReason})` : ''
      }`,
    );
  }

  // Binding fields live under quoteResponse.quoteRequest (recipient, refundTo,
  // originAsset, ...) and quoteResponse.quote (depositAddress, depositMemo,
  // deadline, amounts).
  const qr = parsed.quoteResponse;
  const request = qr?.quoteRequest ?? {};
  const quote = qr?.quote;

  const recipient = typeof request.recipient === 'string' ? request.recipient : null;
  const refundTo = typeof request.refundTo === 'string' ? request.refundTo : null;
  const destinationAsset =
    typeof request.destinationAsset === 'string' ? request.destinationAsset : null;

  return {
    status: parsed.status,
    correlationId: parsed.correlationId,
    updatedAt: parsed.updatedAt,
    depositAddress: quote?.depositAddress ?? null,
    depositMemo: quote?.depositMemo ?? null,
    destinationAddress: recipient,
    destinationAssetId: destinationAsset,
    refundAddress: refundTo,
    deadline: quote?.deadline ?? null,
    expectedOutputAmount: quote?.amountOut ?? null,
    actualOutputAmount: parsed.swapDetails.amountOut ?? null,
    intentHash: parsed.swapDetails.intentHashes[0] ?? null,
    originTxHashes: parsed.swapDetails.originChainTxHashes.map((t) => t.hash),
    destinationTxHashes: parsed.swapDetails.destinationChainTxHashes.map((t) => t.hash),
    refundReason: parsed.swapDetails.refundReason ?? null,
  };
}

export interface RequireIntentBindsInput {
  readonly destinationAddress: string;
  // 1Click only exposes the destination chain inside this asset ID
  // (e.g. nep141:eth-0xa0b8...omft.near), not as a separate field.
  // Pass it to assert the intent targets the destination chain you expect.
  readonly destinationAssetId?: string;
  readonly refundAddress?: string;
}

// Throws E_NEAR_INTENT_MISBINDING on any mismatch.
export function requireIntentBinds(
  intent: NearIntentStatusResponse,
  expected: RequireIntentBindsInput,
): void {
  if (intent.destinationAddress !== expected.destinationAddress) {
    throw new VerificationError(
      'E_NEAR_INTENT_MISBINDING',
      `intent destination ${String(intent.destinationAddress)} != expected ${expected.destinationAddress}`,
    );
  }
  if (
    expected.destinationAssetId !== undefined &&
    intent.destinationAssetId !== expected.destinationAssetId
  ) {
    throw new VerificationError(
      'E_NEAR_INTENT_MISBINDING',
      `intent destinationAsset ${String(intent.destinationAssetId)} != expected ${expected.destinationAssetId}`,
    );
  }
  if (
    expected.refundAddress !== undefined &&
    intent.refundAddress !== expected.refundAddress
  ) {
    throw new VerificationError(
      'E_NEAR_INTENT_MISBINDING',
      `intent refund ${String(intent.refundAddress)} != expected ${expected.refundAddress}`,
    );
  }
}

// 90-minute safety margin against intent.deadline. Silent no-op when
// deadline is null (1Click dry-run quotes). Throws E_NEAR_INTENT_EXPIRING
// when remaining < margin.
export function requireIntentDeadlineMargin(
  intent: NearIntentStatusResponse,
): void {
  if (intent.deadline === null) return;
  const deadlineMs = new Date(intent.deadline).getTime();
  if (Number.isNaN(deadlineMs)) return;
  const remaining = deadlineMs - Date.now();
  if (remaining < INTENT_DEADLINE_MARGIN_MS) {
    throw new VerificationError(
      'E_NEAR_INTENT_EXPIRING',
      `intent deadline in ${(remaining / 60_000).toFixed(1)} minutes, below safety margin`,
    );
  }
}

export interface VerifyNearIntentOnChainInput {
  readonly intentHash: string;
  readonly expected: { readonly destinationAddress: string; readonly expectedOutputAmount: string };
  readonly nearRpcUrl: string;
  readonly fetchFn: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

// Direct-blockchain near-intents only, NOT for 1Click. Queries
// intents.near via JSON-RPC get_intent and confirms the intent hash binds
// the expected destination + amount. Kept around for a future
// direct-blockchain provider; 1Click swaps use fetchNearIntentStatus +
// requireIntentBinds against /v0/status instead.
// Throws E_NEAR_INTENT_FAILED (RPC), E_NEAR_INTENT_CHAIN_DEST, E_NEAR_INTENT_CHAIN_AMOUNT.
export async function verifyNearIntentOnChain(
  input: VerifyNearIntentOnChainInput,
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? VERIFY_FETCH_TIMEOUT_MS;
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: 'intents.near',
      method_name: 'get_intent',
      args_base64: Buffer.from(JSON.stringify({ hash: input.intentHash })).toString('base64'),
    },
  };
  const res = await input.fetchFn(input.nearRpcUrl, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new VerificationError('E_NEAR_INTENT_FAILED', `NEAR RPC HTTP ${String(res.status)}`);
  }
  const raw = await res.json();
  const envelope = NearRpcResponseSchema.parse(raw);
  const result = envelope.result as { result?: number[] } | null;
  if (!result || !Array.isArray(result.result)) {
    throw new VerificationError('E_NEAR_INTENT_CHAIN_AMOUNT', 'NEAR RPC returned no function result');
  }
  const bytes = new Uint8Array(result.result);
  const decoded = new TextDecoder().decode(bytes);
  const parsed = NearIntentOnChainSchema.parse(JSON.parse(decoded));
  if (parsed.destinationAddress !== input.expected.destinationAddress) {
    throw new VerificationError(
      'E_NEAR_INTENT_CHAIN_DEST',
      `on-chain destination ${parsed.destinationAddress} != expected`,
    );
  }
  if (BigInt(parsed.expectedOutputAmount) !== BigInt(input.expected.expectedOutputAmount)) {
    throw new VerificationError(
      'E_NEAR_INTENT_CHAIN_AMOUNT',
      `on-chain amount ${parsed.expectedOutputAmount} != expected ${input.expected.expectedOutputAmount}`,
    );
  }
}

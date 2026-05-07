import { describe, it, expect, afterEach } from 'vitest';
import {
  fetchNearIntentStatus,
  requireIntentBinds,
  requireIntentDeadlineMargin,
  verifyNearIntents,
} from '../../../src/verification/near-intents.js';
import { VerificationError } from '../../../src/types/index.js';
import type { NearIntentStatusResponse } from '../../../src/wire/near-intents.zod.js';

// Representative shape of a real 1Click /v0/status response, mirroring the
// captured fixture at apps/swap-engine/tests/fixtures/oneclick/status-pending-real.json.
// Only the fields the verifier reads are populated; the rest are `null` /
// empty arrays as the real API emits for not-yet-applicable values.
function realPendingResponse(overrides?: {
  readonly status?: string;
  readonly recipient?: string;
  readonly refundTo?: string;
  readonly destinationAsset?: string;
  readonly deadline?: string;
  readonly amountOut?: string;
  readonly intentHash?: string;
  readonly originHashes?: readonly string[];
  readonly destHashes?: readonly string[];
  readonly refundReason?: string;
}): unknown {
  const recipient = overrides?.recipient ?? '0xUserDestEth';
  const refundTo = overrides?.refundTo ?? 'bc1qUserRefund';
  const destinationAsset =
    overrides?.destinationAsset ?? 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
  return {
    correlationId: 'corr-test',
    status: overrides?.status ?? 'PENDING_DEPOSIT',
    updatedAt: '2026-04-30T12:00:00Z',
    swapDetails: {
      intentHashes: overrides?.intentHash ? [overrides.intentHash] : [],
      nearTxHashes: [],
      originChainTxHashes: (overrides?.originHashes ?? []).map((h) => ({
        hash: h,
        explorerUrl: `https://explorer/${h}`,
      })),
      destinationChainTxHashes: (overrides?.destHashes ?? []).map((h) => ({
        hash: h,
        explorerUrl: `https://explorer/${h}`,
      })),
      amountIn: null,
      amountInFormatted: null,
      amountInUsd: null,
      amountOut: null,
      amountOutFormatted: null,
      amountOutUsd: null,
      slippage: null,
      refundedAmount: '0',
      refundedAmountFormatted: '0',
      refundedAmountUsd: '0',
      refundReason: overrides?.refundReason ?? null,
      depositedAmount: null,
      depositedAmountFormatted: null,
      depositedAmountUsd: null,
      refundFee: '1500',
      referral: null,
    },
    quoteResponse: {
      timestamp: '2026-04-30T12:00:00Z',
      signature: 'ed25519:somesig',
      quoteRequest: {
        dry: false,
        swapType: 'FLEX_INPUT',
        depositMode: 'SIMPLE',
        slippageTolerance: 100,
        originAsset: 'nep141:btc.omft.near',
        depositType: 'ORIGIN_CHAIN',
        destinationAsset,
        amount: '20000',
        recipient,
        recipientType: 'DESTINATION_CHAIN',
        refundTo,
        refundType: 'ORIGIN_CHAIN',
        deadline: '2026-04-30T12:30:00Z',
      },
      quote: {
        depositAddress: '1NWBrwD8AW2CXrSjQHLAPP7NWYhzEom25g',
        depositMemo: undefined,
        amountIn: '20000',
        amountInFormatted: '0.0002',
        amountInUsd: '15.00',
        minAmountIn: '19800',
        amountOut: overrides?.amountOut ?? '14704646',
        amountOutFormatted: '14.704646',
        amountOutUsd: '14.70',
        minAmountOut: '14557599',
        deadline: overrides?.deadline ?? '2026-05-01T12:00:00Z',
        timeWhenInactive: '2026-05-01T11:55:00Z',
        timeEstimate: 412,
      },
    },
  };
}

function mockOk(payload: unknown): typeof globalThis.fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }) as unknown as Response) as unknown as typeof globalThis.fetch;
}

function mockHttp(status: number, payload: unknown = {}): typeof globalThis.fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }) as unknown as Response) as unknown as typeof globalThis.fetch;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
});

describe('fetchNearIntentStatus (real 1Click /v0/status shape)', () => {
  it('throws E_NEAR_INTENT_NOT_REGISTERED for HTTP 404', async () => {
    let caught: VerificationError | undefined;
    try {
      await fetchNearIntentStatus({
        statusUrl: 'http://x',
        fetchFn: mockHttp(404, { message: 'Deposit address not found' }),
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_NEAR_INTENT_NOT_REGISTERED');
  });

  it('throws E_NEAR_INTENT_FAILED for non-2xx, non-404 HTTP', async () => {
    let caught: VerificationError | undefined;
    try {
      await fetchNearIntentStatus({
        statusUrl: 'http://x',
        fetchFn: mockHttp(503, { message: 'Service Unavailable' }),
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_NEAR_INTENT_FAILED');
    expect(caught?.message).toMatch(/503/);
  });

  it('throws E_NEAR_INTENT_FAILED for status=FAILED, surfacing refundReason', async () => {
    let caught: VerificationError | undefined;
    try {
      await fetchNearIntentStatus({
        statusUrl: 'http://x',
        fetchFn: mockOk(realPendingResponse({ status: 'FAILED', refundReason: 'TIMEOUT' })),
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_NEAR_INTENT_FAILED');
    expect(caught?.message).toMatch(/TIMEOUT/);
  });

  it('returns flattened intent for PENDING_DEPOSIT, sourcing nested fields correctly', async () => {
    const intent = await fetchNearIntentStatus({
      statusUrl: 'http://x',
      fetchFn: mockOk(realPendingResponse({ recipient: '0xUserA', refundTo: 'bc1qUserB' })),
    });
    expect(intent.status).toBe('PENDING_DEPOSIT');
    expect(intent.correlationId).toBe('corr-test');
    expect(intent.depositAddress).toBe('1NWBrwD8AW2CXrSjQHLAPP7NWYhzEom25g');
    expect(intent.destinationAddress).toBe('0xUserA');
    expect(intent.refundAddress).toBe('bc1qUserB');
    expect(intent.destinationAssetId).toMatch(/^nep141:/);
    expect(intent.deadline).toBeTruthy();
    expect(intent.expectedOutputAmount).toBe('14704646');
    expect(intent.intentHash).toBeNull();
  });

  it('returns flattened intent for INCOMPLETE_DEPOSIT (recoverable, not a failure)', async () => {
    const intent = await fetchNearIntentStatus({
      statusUrl: 'http://x',
      fetchFn: mockOk(realPendingResponse({ status: 'INCOMPLETE_DEPOSIT' })),
    });
    expect(intent.status).toBe('INCOMPLETE_DEPOSIT');
  });

  it('exposes intent hash when SUCCESS includes one', async () => {
    const intent = await fetchNearIntentStatus({
      statusUrl: 'http://x',
      fetchFn: mockOk(
        realPendingResponse({
          status: 'SUCCESS',
          intentHash: 'ih-abc',
          originHashes: ['oh-1'],
          destHashes: ['dh-1'],
        }),
      ),
    });
    expect(intent.status).toBe('SUCCESS');
    expect(intent.intentHash).toBe('ih-abc');
    expect(intent.originTxHashes).toEqual(['oh-1']);
    expect(intent.destinationTxHashes).toEqual(['dh-1']);
  });
});

describe('requireIntentBinds', () => {
  function flattened(overrides: Partial<NearIntentStatusResponse>): NearIntentStatusResponse {
    return {
      status: 'PROCESSING',
      correlationId: 'c',
      updatedAt: 'u',
      depositAddress: 'addr',
      depositMemo: null,
      destinationAddress: '0xUser',
      destinationAssetId: 'nep141:eth-…',
      refundAddress: 'bc1qRefund',
      deadline: null,
      expectedOutputAmount: null,
      actualOutputAmount: null,
      intentHash: null,
      originTxHashes: [],
      destinationTxHashes: [],
      refundReason: null,
      ...overrides,
    };
  }

  it('throws E_NEAR_INTENT_MISBINDING on dest mismatch', () => {
    let caught: VerificationError | undefined;
    try {
      requireIntentBinds(flattened({ destinationAddress: 'attacker' }), {
        destinationAddress: 'user',
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_NEAR_INTENT_MISBINDING');
  });

  it('throws E_NEAR_INTENT_MISBINDING on destinationAssetId mismatch when expected is provided', () => {
    let caught: VerificationError | undefined;
    try {
      requireIntentBinds(flattened({ destinationAssetId: 'nep141:wrong-chain' }), {
        destinationAddress: '0xUser',
        destinationAssetId: 'nep141:eth-…',
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_NEAR_INTENT_MISBINDING');
  });

  it('throws E_NEAR_INTENT_MISBINDING on refund mismatch when expected is provided', () => {
    let caught: VerificationError | undefined;
    try {
      requireIntentBinds(flattened({ refundAddress: 'bc1qAttackerRefund' }), {
        destinationAddress: '0xUser',
        refundAddress: 'bc1qUserRefund',
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_NEAR_INTENT_MISBINDING');
  });

  it('passes when destination matches and optional fields are not asserted', () => {
    expect(() =>
      requireIntentBinds(flattened({}), { destinationAddress: '0xUser' }),
    ).not.toThrow();
  });
});

describe('requireIntentDeadlineMargin', () => {
  it('throws E_NEAR_INTENT_EXPIRING when deadline is closer than the safety margin', () => {
    const deadline = new Date(Date.now() + 30_000).toISOString();
    let caught: VerificationError | undefined;
    try {
      requireIntentDeadlineMargin({
        status: 'PROCESSING',
        correlationId: 'c',
        updatedAt: 'u',
        depositAddress: 'addr',
        depositMemo: null,
        destinationAddress: '0xUser',
        destinationAssetId: null,
        refundAddress: null,
        deadline,
        expectedOutputAmount: null,
        actualOutputAmount: null,
        intentHash: null,
        originTxHashes: [],
        destinationTxHashes: [],
        refundReason: null,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_NEAR_INTENT_EXPIRING');
  });

  it('returns silently when deadline is null (e.g. dry-run quote)', () => {
    expect(() =>
      requireIntentDeadlineMargin({
        status: 'PENDING_DEPOSIT',
        correlationId: 'c',
        updatedAt: 'u',
        depositAddress: 'addr',
        depositMemo: null,
        destinationAddress: null,
        destinationAssetId: null,
        refundAddress: null,
        deadline: null,
        expectedOutputAmount: null,
        actualOutputAmount: null,
        intentHash: null,
        originTxHashes: [],
        destinationTxHashes: [],
        refundReason: null,
      }),
    ).not.toThrow();
  });
});

// verifyNearIntents reads only `data.status` from the real 1Click /v0/status
// response. It must accept all 6 active 1Click statuses, including
// INCOMPLETE_DEPOSIT (deposit observed but below bridge minimum — recoverable).
describe('verifyNearIntents (production status check)', () => {
  const verification = {
    provider: 'near_intents' as const,
    status_url: 'https://1click.chaindefuser.com/v0/status?depositAddress=x',
    deposit_memo: null,
    explorer_url: null,
  };

  function fetchStatus(status: string): typeof globalThis.fetch {
    return (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status }),
    }) as unknown as Response) as unknown as typeof globalThis.fetch;
  }

  it.each([
    'PENDING_DEPOSIT',
    'KNOWN_DEPOSIT_TX',
    'INCOMPLETE_DEPOSIT',
    'PROCESSING',
    'SUCCESS',
    'REFUNDED',
  ])('marks "Intent registered" true for status=%s', async (status) => {
    const result = await verifyNearIntents(verification, fetchStatus(status));
    const registeredCheck = result.checks.find((c) => c.name === 'Intent registered');
    expect(registeredCheck?.passed, `${status} should be active`).toBe(true);
  });

  it('marks "Intent registered" false for FAILED', async () => {
    const result = await verifyNearIntents(verification, fetchStatus('FAILED'));
    const registeredCheck = result.checks.find((c) => c.name === 'Intent registered');
    expect(registeredCheck?.passed).toBe(false);
  });

  it('returns a failed result with explicit reason when status_url is null', async () => {
    const fetchSpy = (() => {
      throw new Error('fetch should not be called when status_url is null');
    }) as unknown as typeof globalThis.fetch;
    const result = await verifyNearIntents(
      { ...verification, status_url: null as unknown as string },
      fetchSpy,
    );
    expect(result.verified).toBe(false);
    const reachableCheck = result.checks.find((c) => c.name === 'NEAR reachable');
    expect(reachableCheck?.passed).toBe(false);
    expect(reachableCheck?.detail).toMatch(/no public status url/i);
  });
});

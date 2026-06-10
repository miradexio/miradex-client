import { describe, it, expect, vi } from 'vitest';
import { ApiClient, createAuthorizedSwapApi } from '../../../src/api/index.js';

const baseUrl = 'https://example.invalid';

function fullDetail(): Record<string, unknown> {
  return {
    swapNumber: 'MIRA-ABCD1234',
    access: 'full',
    status: 'completed',
    provider: 'thorchain',
    fromToken: 'BTC',
    fromChain: 'bitcoin',
    toToken: 'ETH',
    toChain: 'ethereum',
    amountIn: '0.1',
    amountInUsd: null,
    expectedAmountOut: null,
    expectedAmountOutUsd: null,
    actualAmountOut: '1.68',
    actualAmountOutUsd: null,
    priceImpactPct: null,
    depositAddress: 'bc1qdeposit',
    fundingAddress: null,
    destAddress: '0xabc',
    refundAddress: null,
    depositTxHash: null,
    outputTxHash: null,
    refundTxHash: null,
    expiresAt: null,
    createdAt: '2026-04-18T10:00:00.000Z',
    updatedAt: '2026-04-18T11:00:00.000Z',
    completedAt: '2026-04-18T11:00:00.000Z',
    durationSeconds: 3600,
    requiresFunding: false,
    verification: null,
    protocolData: null,
  };
}

function actionResponse(): Record<string, unknown> {
  return {
    swapNumber: 'MIRA-ABCD1234',
    status: 'failed',
    message: 'Swap cancelled.',
    protocolData: null,
  };
}

interface CapturingFetch {
  readonly fetchFn: typeof fetch;
  urls(): readonly string[];
}

function makeCapturingFetch(body: unknown): CapturingFetch {
  const captured: string[] = [];
  const fetchFn = vi.fn(async (url: unknown) => {
    captured.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: body }),
    };
  }) as unknown as typeof fetch;
  return { fetchFn, urls: () => captured };
}

describe('ApiClient — ownership proof query param', () => {
  it('appends destAddress to getSwapDetail when a proof is given', async () => {
    const capture = makeCapturingFetch(fullDetail());
    const client = new ApiClient({ baseUrl, fetchFn: capture.fetchFn });

    await client.getSwapDetail('MIRA-ABCD1234', { destAddress: '0x AbC/123' });

    expect(capture.urls()[0]).toBe(
      `${baseUrl}/api/v1/swap/MIRA-ABCD1234?destAddress=0x+AbC%2F123`,
    );
  });

  it('omits the query entirely when no proof is given', async () => {
    const capture = makeCapturingFetch(fullDetail());
    const client = new ApiClient({ baseUrl, fetchFn: capture.fetchFn });

    await client.getSwapDetail('MIRA-ABCD1234');

    expect(capture.urls()[0]).toBe(`${baseUrl}/api/v1/swap/MIRA-ABCD1234`);
  });

  it('appends destAddress to executeAction when opts.proof is given', async () => {
    const capture = makeCapturingFetch(actionResponse());
    const client = new ApiClient({ baseUrl, fetchFn: capture.fetchFn });

    await client.executeAction(
      'MIRA-ABCD1234',
      { type: 'cancel' },
      { proof: { destAddress: '0xabc' } },
    );

    expect(capture.urls()[0]).toBe(
      `${baseUrl}/api/v1/swap/MIRA-ABCD1234/action?destAddress=0xabc`,
    );
  });

  it('sends executeAction without a query when opts.proof is absent', async () => {
    const capture = makeCapturingFetch(actionResponse());
    const client = new ApiClient({ baseUrl, fetchFn: capture.fetchFn });

    await client.executeAction('MIRA-ABCD1234', { type: 'cancel' }, { timeoutMs: 5_000 });

    expect(capture.urls()[0]).toBe(`${baseUrl}/api/v1/swap/MIRA-ABCD1234/action`);
  });
});

describe('createAuthorizedSwapApi', () => {
  it('binds the proof to every getSwapDetail call', async () => {
    const capture = makeCapturingFetch(fullDetail());
    const client = new ApiClient({ baseUrl, fetchFn: capture.fetchFn });
    const swapApi = createAuthorizedSwapApi(client, { destAddress: '0xabc' });

    await swapApi.getSwapDetail('MIRA-ABCD1234');

    expect(capture.urls()[0]).toBe(`${baseUrl}/api/v1/swap/MIRA-ABCD1234?destAddress=0xabc`);
  });

  it('binds the proof to every executeAction call and keeps opts', async () => {
    const capture = makeCapturingFetch(actionResponse());
    const client = new ApiClient({ baseUrl, fetchFn: capture.fetchFn });
    const swapApi = createAuthorizedSwapApi(client, { destAddress: '0xabc' });

    await swapApi.executeAction('MIRA-ABCD1234', { type: 'cancel' }, { timeoutMs: 9_000 });

    expect(capture.urls()[0]).toBe(
      `${baseUrl}/api/v1/swap/MIRA-ABCD1234/action?destAddress=0xabc`,
    );
  });
});

import { describe, it, expect, vi } from 'vitest';
import { ApiClient, ApiError } from '../../../src/api/index.js';

const baseUrl = 'https://example.invalid';

function makeFetchMock(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('ApiClient — schema validation', () => {
  it('returns parsed data on a valid response', async () => {
    const client = new ApiClient({
      baseUrl,
      fetchFn: makeFetchMock({
        success: true,
        data: {
          tokens: {
            bitcoin: [{ symbol: 'BTC', priceUsd: '50000', change24hPct: 1.2 }],
          },
        },
      }),
    });
    const tokens = await client.getTokens();
    expect(tokens.bitcoin?.[0]?.symbol).toBe('BTC');
  });

  it('throws ApiError(SCHEMA_MISMATCH, 502) on drifted response', async () => {
    const client = new ApiClient({
      baseUrl,
      fetchFn: makeFetchMock({
        success: true,
        data: {
          tokens: {
            bitcoin: [{ symbol: 'BTC', priceUsd: 50000 /* should be string */, change24hPct: 0 }],
          },
        },
      }),
    });
    await expect(client.getTokens()).rejects.toMatchObject({
      name: 'ApiError',
      code: 'SCHEMA_MISMATCH',
      statusCode: 502,
    });
  });

  it('throws ApiError with server code after exhausting bounded retries on rate-limit', async () => {
    // 429 is now `rate-limit` → retried up to maxRetries (default 3) before
    // surfacing. Override retryBaseMs to keep the test fast.
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ success: false, error: { code: 'RATE_LIMITED', message: 'slow down' } }),
    })) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl, fetchFn, retryBaseMs: 1 });
    await expect(client.getTokens()).rejects.toMatchObject({
      name: 'ApiError',
      code: 'RATE_LIMITED',
      message: 'slow down',
      statusCode: 429,
    });
    // 1 initial attempt + 3 bounded retries.
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('throws ZodError on createSwap with malformed body (client-side)', async () => {
    const client = new ApiClient({
      baseUrl,
      fetchFn: makeFetchMock({ success: true, data: {} }),
    });
    await expect(
      // @ts-expect-error intentional malformed input
      client.createSwap({ from: 'BTC' }),
    ).rejects.toThrow();
  });

  it('populates details.issues on SCHEMA_MISMATCH', async () => {
    const client = new ApiClient({
      baseUrl,
      fetchFn: makeFetchMock({
        success: true,
        data: { tokens: { bitcoin: [{ symbol: 'BTC', priceUsd: 50000, change24hPct: 0 }] } },
      }),
    });
    try {
      await client.getTokens();
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as ApiError;
      expect(e.code).toBe('SCHEMA_MISMATCH');
      expect(e.details).toHaveProperty('issues');
    }
  });

  it('maps unknown status in response to unknown-tagged (forward-compat)', async () => {
    const client = new ApiClient({
      baseUrl,
      fetchFn: makeFetchMock({
        success: true,
        data: {
          recents: [
            {
              swapNumber: 'MIRA-ABCD1234',
              fromToken: 'BTC',
              toToken: 'ETH',
              provider: 'thorchain',
              status: 'new_future_status',
              amountIn: '0.1',
              amountInUsd: null,
              expectedAmountOut: null,
              expectedAmountOutUsd: null,
              createdAt: '2026-04-18T10:00:00.000Z',
              completedAt: null,
              durationSeconds: null,
            },
          ],
        },
      }),
    });
    const recents = await client.getRecents();
    expect(recents[0]?.status).toBe('unknown:new_future_status');
  });
});

import { describe, it, expect } from 'vitest';
import {
  swapQuoteSchema,
  quotesResponseSchema,
  rateResponseSchema,
  limitsResponseSchema,
  providersResponseSchema,
  liquidityResponseSchema,
} from '../../../../src/wire/server/quotes.zod.js';

describe('swapQuoteSchema', () => {
  const golden = {
    provider: 'thorchain',
    variantId: 'streaming',
    variantLabel: 'Streaming Swap',
    expectedOutput: '1061.99',
    fromChain: 'ethereum',
    toChain: 'bitcoin',
    estimatedDurationSeconds: 600,
    fees: [{ type: 'network', amount: '0.001', token: 'BTC', amountUsd: '80.00' }],
    recommendedSlippageBps: 300,
    minAmount: '0.01',
    maxAmount: '10',
    expectedOutputUsd: '49750.00',
    priceImpactPct: '-0.5',
    precision: 'exact' as const,
  };

  it('parses a golden quote', () => {
    expect(swapQuoteSchema.parse(golden)).toMatchObject(golden);
  });

  it('rejects missing required fields', () => {
    const { expectedOutput: _omit, ...bad } = golden;
    expect(() => swapQuoteSchema.parse(bad)).toThrow();
  });

  it('parses fees with per-fee amountUsd (server-side USD enrichment)', () => {
    const parsed = swapQuoteSchema.parse({
      ...golden,
      fees: [
        { type: 'IngressFee', amount: '0.00000328', token: 'BTC', amountUsd: '0.26' },
        { type: 'NetworkFee', amount: '8.03143', token: 'USDC', amountUsd: '8.03' },
        { type: 'WeirdFee', amount: '5', token: 'XYZ', amountUsd: null },
      ],
    });
    expect(parsed.fees[0]?.amountUsd).toBe('0.26');
    expect(parsed.fees[1]?.amountUsd).toBe('8.03');
    expect(parsed.fees[2]?.amountUsd).toBeNull();
  });
});

describe('quotesResponseSchema', () => {
  it('parses a full quotes response', () => {
    const parsed = quotesResponseSchema.parse({
      from: 'BTC',
      to: 'ETH',
      amount: '1',
      amountInUsd: '50000.00',
      quotes: [],
      cachedAt: '2026-04-18T12:00:00.000Z',
      source: 'api',
    });
    expect(parsed.source).toBe('api');
  });

  it('maps unknown source enum to unknown-tagged', () => {
    const parsed = quotesResponseSchema.parse({
      from: 'BTC',
      to: 'ETH',
      amount: '1',
      amountInUsd: null,
      quotes: [],
      cachedAt: null,
      source: 'future-backend',
    });
    expect(parsed.source).toBe('unknown:future-backend');
  });
});

describe('rateResponseSchema', () => {
  it('parses rates', () => {
    const parsed = rateResponseSchema.parse({
      from: 'BTC',
      to: 'ETH',
      rates: [
        {
          provider: 'thorchain',
          rate: '16.7',
          inverseRate: '0.06',
          estimatedDurationSeconds: 600,
          cachedAt: null,
        },
      ],
      source: 'cache',
    });
    expect(parsed.rates).toHaveLength(1);
  });
});

describe('limitsResponseSchema', () => {
  it('parses limits with nullable min/max', () => {
    const parsed = limitsResponseSchema.parse({
      from: 'BTC',
      to: 'ETH',
      limits: [
        {
          provider: 'chainflip',
          minAmount: '0.0001',
          maxAmount: null,
          minAmountUsd: '5',
          maxAmountUsd: null,
        },
      ],
    });
    expect(parsed.limits[0]?.maxAmount).toBeNull();
  });
});

describe('providersResponseSchema', () => {
  it('parses a providers list', () => {
    const parsed = providersResponseSchema.parse({
      providers: [
        {
          provider: 'thorchain',
          available: true,
          latencyMs: 120,
          chains: ['bitcoin', 'ethereum'],
          lastCheckedAt: '2026-04-18T12:00:00.000Z',
        },
      ],
    });
    expect(parsed.providers[0]?.available).toBe(true);
  });
});

describe('liquidityResponseSchema', () => {
  it('parses a liquidity response with one ok provider', () => {
    const parsed = liquidityResponseSchema.parse({
      providers: [
        {
          provider: 'thorchain',
          status: 'ok',
          error: null,
          fetchedAt: '2026-04-18T12:00:00.000Z',
          liquidity: {
            type: 'amm-pool',
            entries: [
              {
                token: 'BTC',
                id: 'btc-pool',
                amount: '100',
                amountUsd: '5000000',
                volume24hUsd: '1000000',
                status: 'active',
              },
            ],
          },
        },
      ],
      totals: {
        volume24hUsd: '5000000',
        onlineProviderCount: 1,
        errorProviderCount: 0,
        entryCount: 1,
      },
      cachedAt: null,
      source: 'api',
    });
    expect(parsed.providers[0]?.status).toBe('ok');
  });

  it('parses a provider in error state with null liquidity', () => {
    const parsed = liquidityResponseSchema.parse({
      providers: [
        {
          provider: 'chainflip',
          status: 'error',
          error: 'timeout',
          fetchedAt: '2026-04-18T12:00:00.000Z',
          liquidity: null,
        },
      ],
      totals: {
        volume24hUsd: null,
        onlineProviderCount: 0,
        errorProviderCount: 1,
        entryCount: 0,
      },
      cachedAt: null,
      source: 'api',
    });
    expect(parsed.providers[0]?.liquidity).toBeNull();
  });
});

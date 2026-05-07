import { describe, it, expect } from 'vitest';
import {
  swapTokenInfoSchema,
  swapTokenMapSchema,
  swapPairSchema,
} from '../../../../src/wire/server/tokens.zod.js';

describe('swapTokenInfoSchema', () => {
  it('parses a minimal token info', () => {
    expect(
      swapTokenInfoSchema.parse({ symbol: 'BTC', priceUsd: '50000.00', change24hPct: 1.25 }),
    ).toEqual({ symbol: 'BTC', priceUsd: '50000.00', change24hPct: 1.25 });
  });

  it('allows null priceUsd and change24hPct', () => {
    const parsed = swapTokenInfoSchema.parse({
      symbol: 'XMR',
      priceUsd: null,
      change24hPct: null,
    });
    expect(parsed.priceUsd).toBeNull();
    expect(parsed.change24hPct).toBeNull();
  });
});

describe('swapTokenMapSchema', () => {
  it('maps chain -> list of tokens', () => {
    const parsed = swapTokenMapSchema.parse({
      bitcoin: [{ symbol: 'BTC', priceUsd: '50000', change24hPct: 0 }],
      ethereum: [{ symbol: 'ETH', priceUsd: '3000', change24hPct: 0.1 }],
    });
    expect(parsed.bitcoin?.[0]?.symbol).toBe('BTC');
  });
});

describe('swapPairSchema', () => {
  it('parses a pair with providers', () => {
    const parsed = swapPairSchema.parse({
      fromToken: 'BTC',
      fromDecimals: 8,
      toToken: 'ETH',
      toDecimals: 18,
      providers: [
        { provider: 'thorchain', dex: 'thor', isCrossChain: true, minAmountUsd: '10' },
      ],
    });
    expect(parsed.providers[0]?.provider).toBe('thorchain');
  });

  it('maps unknown provider to unknown-tagged value (forward-compat)', () => {
    const parsed = swapPairSchema.parse({
      fromToken: 'BTC',
      fromDecimals: 8,
      toToken: 'ETH',
      toDecimals: 18,
      providers: [
        {
          provider: 'new_provider',
          dex: 'x',
          isCrossChain: false,
          minAmountUsd: null,
        },
      ],
    });
    expect(parsed.providers[0]?.provider).toBe('unknown:new_provider');
  });

  it('rejects a malformed pair (fromDecimals missing)', () => {
    expect(() =>
      swapPairSchema.parse({
        fromToken: 'BTC',
        toToken: 'ETH',
        toDecimals: 18,
        providers: [],
      }),
    ).toThrow();
  });
});

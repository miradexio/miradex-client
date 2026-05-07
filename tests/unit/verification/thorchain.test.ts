import { describe, it, expect, afterEach } from 'vitest';
import {
  fetchThorchainVaults,
  verifyThorchainQuote,
} from '../../../src/verification/thorchain.js';
import { VerificationError } from '../../../src/types/index.js';

type FetchRouter = (url: string) => unknown;

function mockFetch(router: FetchRouter): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    try {
      const body = router(url);
      if (body === 'http_error') {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    } catch {
      throw new Error(`mockFetch: no route for ${url}`);
    }
  }) as unknown as typeof globalThis.fetch;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
});

describe('fetchThorchainVaults (AV-D.5)', () => {
  it('returns vaults that appear in at least two sources', async () => {
    const honest = [{ chain: 'BTC', address: 'bc1qhonest', halted: false }];
    const fetchFn = mockFetch((url) => {
      if (url.includes('thornode') || url.includes('midgard')) return honest;
      return [];
    });
    const out = await fetchThorchainVaults({ fetchFn, timeoutMs: 1_000 });
    expect(out).toHaveLength(1);
    expect(out[0]?.address).toBe('bc1qhonest');
  });

  it('throws E_THORCHAIN_QUORUM when fewer than 2 sources respond', async () => {
    const fetchFn: typeof globalThis.fetch = (async () => {
      throw new Error('down');
    }) as unknown as typeof globalThis.fetch;
    let caught: VerificationError | undefined;
    try {
      await fetchThorchainVaults({ fetchFn, timeoutMs: 1_000 });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_THORCHAIN_QUORUM');
  });

  it('drops halted vaults', async () => {
    const vaults = [
      { chain: 'BTC', address: 'bc1qactive', halted: false },
      { chain: 'ETH', address: '0xhalted', halted: true },
    ];
    const fetchFn = mockFetch(() => vaults);
    const out = await fetchThorchainVaults({ fetchFn, timeoutMs: 1_000 });
    expect(out.map((v) => v.address)).not.toContain('0xhalted');
  });
});

describe('verifyThorchainQuote (AV-D.4)', () => {
  function quote(amount: string): unknown {
    return { expected_amount_out: amount };
  }

  it('passes when engine is inside the slippage band', async () => {
    const fetchFn = mockFetch(() => quote('10000'));
    await expect(
      verifyThorchainQuote({
        fromAsset: 'BTC.BTC',
        toAsset: 'ETH.ETH',
        amountSats: '1000000',
        destAddress: '0xabc',
        engineExpectedOut: '10000',
        slippageBps: 100,
        fetchFn,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();
  });

  it('throws E_RATE_DRIFT when the engine value is outside the band', async () => {
    const fetchFn = mockFetch(() => quote('10000'));
    let caught: VerificationError | undefined;
    try {
      await verifyThorchainQuote({
        fromAsset: 'BTC.BTC',
        toAsset: 'ETH.ETH',
        amountSats: '1000000',
        destAddress: '0xabc',
        engineExpectedOut: '5000',
        slippageBps: 100,
        fetchFn,
        timeoutMs: 1_000,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_RATE_DRIFT');
  });

  it('throws E_THORNODE_QUOTE_UNAVAILABLE when every source fails', async () => {
    const fetchFn: typeof globalThis.fetch = (async () => {
      throw new Error('down');
    }) as unknown as typeof globalThis.fetch;
    let caught: VerificationError | undefined;
    try {
      await verifyThorchainQuote({
        fromAsset: 'BTC.BTC',
        toAsset: 'ETH.ETH',
        amountSats: '1000000',
        destAddress: '0xabc',
        engineExpectedOut: '5000',
        slippageBps: 100,
        fetchFn,
        timeoutMs: 1_000,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_THORNODE_QUOTE_UNAVAILABLE');
  });
});

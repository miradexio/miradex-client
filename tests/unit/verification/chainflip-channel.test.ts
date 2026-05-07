import { describe, it, expect, afterEach } from 'vitest';
import { verifyChainflipChannel } from '../../../src/verification/chainflip.js';
import { VerificationError } from '../../../src/types/index.js';

type FetchFn = typeof globalThis.fetch;

function mockFetch(body: unknown): FetchFn {
  return (async () =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as unknown as FetchFn;
}

function channel(overrides: Record<string, unknown> = {}): unknown {
  return {
    depositAddress: 'bc1qdeposit',
    srcChain: 'Bitcoin',
    srcAsset: 'BTC',
    destChain: 'Ethereum',
    destAsset: 'USDC',
    destAddress: '0xdest',
    refundAddress: 'bc1qrefund',
    expiryTime: new Date(Date.now() + 120 * 60 * 1000).toISOString(),
    minBtcAmount: '10000',
    maxBtcAmount: '100000000',
    ...overrides,
  };
}

const REST_ENDPOINTS = { mode: 'rest', statusUrl: 'http://broker' } as const;

const originalFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as unknown as { fetch: FetchFn }).fetch = originalFetch;
});

describe('verifyChainflipChannel', () => {
  const expected = {
    destAddress: '0xdest',
    refundAddress: 'bc1qrefund',
    srcChain: 'Bitcoin',
    destChain: 'Ethereum',
    destAsset: 'USDC',
  };

  it('passes when the broker channel binds the expected destination', async () => {
    await expect(
      verifyChainflipChannel({
        channelId: '42',
        endpoints: REST_ENDPOINTS,
        expected,
        depositAmountSats: '50000',
        fetchFn: mockFetch(channel()),
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();
  });

  it('throws E_CHAINFLIP_CHANNEL_MISBINDING when broker dest-address does not match expected', async () => {
    let caught: VerificationError | undefined;
    try {
      await verifyChainflipChannel({
        channelId: '42',
        endpoints: REST_ENDPOINTS,
        expected,
        fetchFn: mockFetch(channel({ destAddress: '0xattacker' })),
        timeoutMs: 1_000,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_CHAINFLIP_CHANNEL_MISBINDING');
  });

  it('throws E_CHAINFLIP_AMOUNT_BELOW_MIN on below-min deposit', async () => {
    let caught: VerificationError | undefined;
    try {
      await verifyChainflipChannel({
        channelId: '42',
        endpoints: REST_ENDPOINTS,
        expected,
        depositAmountSats: '1',
        fetchFn: mockFetch(channel()),
        timeoutMs: 1_000,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_CHAINFLIP_AMOUNT_BELOW_MIN');
  });

  it('throws E_CHAINFLIP_CHANNEL_EXPIRING when expiry is close', async () => {
    const close = new Date(Date.now() + 30_000).toISOString();
    let caught: VerificationError | undefined;
    try {
      await verifyChainflipChannel({
        channelId: '42',
        endpoints: REST_ENDPOINTS,
        expected,
        fetchFn: mockFetch(channel({ expiryTime: close })),
        timeoutMs: 1_000,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_CHAINFLIP_CHANNEL_EXPIRING');
  });
});

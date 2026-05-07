import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchTransactionQuorum } from '../../../src/lib/monero/rpc.js';
import { VerificationError } from '../../../src/types/index.js';

function responseFor(overrides: {
  readonly extra?: readonly number[];
  readonly unlock_time?: number;
  readonly vout?: readonly unknown[];
  readonly ecdhInfo?: readonly unknown[];
  readonly outPk?: readonly unknown[];
  readonly confirmations?: number;
  readonly inPool?: boolean;
}) {
  const txJson = {
    extra: overrides.extra ?? [],
    unlock_time: overrides.unlock_time ?? 0,
    vout: overrides.vout ?? [],
    rct_signatures: {
      type: 5,
      ecdhInfo: overrides.ecdhInfo ?? [],
      outPk: overrides.outPk ?? [],
    },
  };
  return {
    status: 'OK',
    txs: [
      {
        as_json: JSON.stringify(txJson),
        block_height: 100,
        confirmations: overrides.confirmations ?? 42,
        in_pool: overrides.inPool ?? false,
        tx_hash: 'de'.repeat(32),
        output_indices: [],
      },
    ],
  };
}

function mockFetchWithRouter(router: (url: string) => unknown): void {
  const realFetch = globalThis.fetch;
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = router(url);
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  });
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = spy as unknown as typeof globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _unused = realFetch;
}

describe('fetchTransactionQuorum (AV-E.5)', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
  });

  it('returns tx when ≥2 of 3 nodes return byte-identical data', async () => {
    mockFetchWithRouter((url) => {
      if (url.startsWith('http://honest-1')) return responseFor({ extra: [1, 2, 3] });
      if (url.startsWith('http://honest-2')) return responseFor({ extra: [1, 2, 3] });
      return responseFor({ extra: [9, 9, 9] });
    });

    const result = await fetchTransactionQuorum(
      { nodes: ['http://honest-1', 'http://honest-2', 'http://liar'], quorum: 2, timeoutMs: 1_000 },
      'de'.repeat(32),
    );
    expect(result.txJson.extra).toEqual([1, 2, 3]);
  });

  it('throws E_MONERO_QUORUM when no bucket has quorum', async () => {
    mockFetchWithRouter((url) => {
      if (url.startsWith('http://a')) return responseFor({ extra: [1] });
      if (url.startsWith('http://b')) return responseFor({ extra: [2] });
      return responseFor({ extra: [3] });
    });

    let caught: VerificationError | undefined;
    try {
      await fetchTransactionQuorum(
        { nodes: ['http://a', 'http://b', 'http://c'], quorum: 2, timeoutMs: 1_000 },
        'de'.repeat(32),
      );
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_MONERO_QUORUM');
  });

  it('throws E_MONERO_QUORUM when too few nodes respond', async () => {
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch =
      (async () => { throw new Error('network down'); }) as unknown as typeof globalThis.fetch;

    let caught: VerificationError | undefined;
    try {
      await fetchTransactionQuorum(
        { nodes: ['http://a', 'http://b', 'http://c'], quorum: 2, timeoutMs: 1_000 },
        'de'.repeat(32),
      );
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_MONERO_QUORUM');
  });
});

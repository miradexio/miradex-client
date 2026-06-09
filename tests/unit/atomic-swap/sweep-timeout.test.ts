import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/lib/crypto/wasm.js', () => ({
  ensureWasm: vi.fn().mockResolvedValue(undefined),
  encsignDigest: vi.fn(),
  verifyDleqProof: vi.fn(),
}));

const { sweepMonero } = await import('../../../src/atomic-swap/monero-sweep/index.js');
const { createMockApi } = await import('../../helpers/mock-api.js');

const OLD_SWEEP_SYNC_TIMEOUT_MS = 120_000;

function isSweepKeyTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === 'Sweep key retrieval timed out';
}

describe('sweepMonero key-retrieval cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not throw "Sweep key retrieval timed out" when waiting past the old 2-min limit', async () => {
    const api = createMockApi();

    const ac = new AbortController();
    const promise = sweepMonero(api, {
      swapId: 's-sweep',
      s_b: new Uint8Array(32),
      receiveAddress: '4xmraddress',
      expectedSAMonero: 'a'.repeat(64),
      signal: ac.signal,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(OLD_SWEEP_SYNC_TIMEOUT_MS + 60_000);

    ac.abort();
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await promise.catch((err: unknown) => err);
    expect(isSweepKeyTimeout(result)).toBe(false);
  }, 30_000);

  it('rejects when the abort signal fires while waiting for sweep data', async () => {
    const api = createMockApi();

    const ac = new AbortController();
    ac.abort();

    await expect(
      sweepMonero(api, {
        swapId: 's-aborted',
        s_b: new Uint8Array(32),
        receiveAddress: '4xmraddress',
        expectedSAMonero: 'a'.repeat(64),
        signal: ac.signal,
      }),
    ).rejects.toThrow();
  }, 30_000);
});

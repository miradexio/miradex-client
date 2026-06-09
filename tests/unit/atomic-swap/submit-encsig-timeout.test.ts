import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitEncsigWhenReady } from '../../../src/atomic-swap/submit-encsig.js';
import { createMockApi, buildSwapDetail } from '../../helpers/mock-api.js';
import type { SwapStatus } from '../../../src/types/index.js';

const SUBMIT_ENCSIG_TIMEOUT_MS = 3_600_000;

function isDriveTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'E_DRIVE_TIMEOUT'
  );
}

describe('submitEncsigWhenReady deadline enforcement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws E_DRIVE_TIMEOUT when status is pre-funding past the deadline', async () => {
    const api = createMockApi();
    api.setSwapDetail('s-pre', buildSwapDetail({ status: 'pending' as SwapStatus }));

    const ac = new AbortController();
    const promise = submitEncsigWhenReady({
      api,
      swapId: 's-pre',
      keys: { b: 'b'.repeat(64), B: '02' + 'b'.repeat(64) },
      signedPsbtBase64: 'cHNidP8BAAA=',
      network: 'mainnet',
      onProgress: () => {},
      signal: ac.signal,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(SUBMIT_ENCSIG_TIMEOUT_MS + 60_000);

    await expect(promise).rejects.toMatchObject({ code: 'E_DRIVE_TIMEOUT' });
  });

  it('does not throw E_DRIVE_TIMEOUT when BTC is locked (post-funding) past deadline', async () => {
    const api = createMockApi();
    api.setSwapDetail('s-post', buildSwapDetail({ status: 'swapping' as SwapStatus }));

    const ac = new AbortController();
    const promise = submitEncsigWhenReady({
      api,
      swapId: 's-post',
      keys: { b: 'b'.repeat(64), B: '02' + 'b'.repeat(64) },
      signedPsbtBase64: 'cHNidP8BAAA=',
      network: 'mainnet',
      onProgress: () => {},
      signal: ac.signal,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(SUBMIT_ENCSIG_TIMEOUT_MS + 60_000);

    ac.abort();
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await promise.catch((err: unknown) => err);
    expect(isDriveTimeout(result)).toBe(false);
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  ApiError,
  NetworkError,
  SwapCancelledError,
} from '../../../src/lib/errors.js';
import { ProtocolError } from '../../../src/types/protocol.js';
import { VerificationError } from '../../../src/types/verification.js';
import { withRetry, computeBackoffMs } from '../../../src/lib/retry.js';

describe('computeBackoffMs', () => {
  it('returns 0 for retry 0', () => {
    expect(computeBackoffMs(0, 500, 60_000)).toBe(0);
  });
  it('doubles each retry up to the cap', () => {
    expect(computeBackoffMs(1, 500, 60_000)).toBe(500);
    expect(computeBackoffMs(2, 500, 60_000)).toBe(1_000);
    expect(computeBackoffMs(3, 500, 60_000)).toBe(2_000);
    expect(computeBackoffMs(4, 500, 60_000)).toBe(4_000);
    expect(computeBackoffMs(7, 500, 60_000)).toBe(32_000);
    expect(computeBackoffMs(8, 500, 60_000)).toBe(60_000);
    expect(computeBackoffMs(20, 500, 60_000)).toBe(60_000);
  });
});

describe('withRetry', () => {
  it('returns the resolved value when fn succeeds first try', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { baseMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries network errors indefinitely until success', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 5) throw new NetworkError('flaky');
      return 'ok';
    });
    const result = await withRetry(fn, { baseMs: 1, maxBackoffMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('retries 5xx server errors indefinitely', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 4) throw new ApiError('boom', 503, 'UPSTREAM_DOWN');
      return 'ok';
    });
    const result = await withRetry(fn, { baseMs: 1, maxBackoffMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('throws fatal client errors immediately without retry', async () => {
    const fn = vi.fn(async () => {
      throw new ApiError('bad input', 400, 'BAD_REQUEST');
    });
    await expect(withRetry(fn, { baseMs: 1 })).rejects.toMatchObject({
      name: 'ApiError',
      statusCode: 400,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws SCHEMA_MISMATCH immediately as protocol error', async () => {
    const fn = vi.fn(async () => {
      throw new ApiError('schema', 502, 'SCHEMA_MISMATCH');
    });
    await expect(withRetry(fn, { baseMs: 1 })).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws VerificationError + ProtocolError immediately', async () => {
    const ve = vi.fn(async () => {
      throw new VerificationError('E_LOCK_ADDR_MISMATCH', 'mismatch');
    });
    await expect(withRetry(ve, { baseMs: 1 })).rejects.toMatchObject({
      name: 'VerificationError',
    });
    expect(ve).toHaveBeenCalledTimes(1);

    const pe = vi.fn(async () => {
      throw new ProtocolError('E_TERMINAL', 'done');
    });
    await expect(withRetry(pe, { baseMs: 1 })).rejects.toMatchObject({
      name: 'ProtocolError',
    });
    expect(pe).toHaveBeenCalledTimes(1);
  });

  it('retries client-bounded errors up to maxBoundedRetries then surfaces', async () => {
    const fn = vi.fn(async () => {
      throw new ApiError('not yet', 404, 'NOT_FOUND');
    });
    await expect(
      withRetry(fn, { maxBoundedRetries: 2, baseMs: 1, maxBackoffMs: 1 }),
    ).rejects.toMatchObject({ name: 'ApiError', statusCode: 404 });
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries 429 as bounded', async () => {
    const fn = vi.fn(async () => {
      throw new ApiError('slow down', 429, 'RATE_LIMITED');
    });
    await expect(
      withRetry(fn, { maxBoundedRetries: 1, baseMs: 1, maxBackoffMs: 1 }),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('aborts mid-retry when signal fires', async () => {
    const ac = new AbortController();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 2) {
        ac.abort();
      }
      throw new NetworkError('still down');
    });
    await expect(
      withRetry(fn, { baseMs: 5, maxBackoffMs: 5, signal: ac.signal }),
    ).rejects.toBeInstanceOf(SwapCancelledError);
  });

  it('aborts immediately when signal already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn(async () => 'ok');
    await expect(
      withRetry(fn, { signal: ac.signal }),
    ).rejects.toBeInstanceOf(SwapCancelledError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('promotes a foreign TypeError("fetch failed") to network category', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new TypeError('fetch failed');
      return 'ok';
    });
    const result = await withRetry(fn, { baseMs: 1, maxBackoffMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('reports retries through onRetry hook', async () => {
    const seen: number[] = [];
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new NetworkError('flaky');
      return 'ok';
    });
    await withRetry(fn, {
      baseMs: 1,
      maxBackoffMs: 1,
      onRetry: (info) => {
        seen.push(info.attempt);
      },
    });
    expect(seen).toEqual([1, 2]);
  });
});

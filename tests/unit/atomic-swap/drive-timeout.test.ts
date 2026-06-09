import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { driveSwapToCompletion } from '../../../src/atomic-swap/drive.js';
import { SWEEP_TIMEOUT_MS } from '../../../src/lib/default-config.js';
import { createMockApi, buildSwapDetail } from '../../helpers/mock-api.js';
import type { SwapStatus } from '../../../src/types/index.js';
import type { DriveSwapOptions } from '../../../src/atomic-swap/types.js';
import type { TempBtcWallet } from '../../../src/lib/bitcoin/wallet.js';
import type { DetectedDeposit } from '../../../src/lib/bitcoin/deposit-watcher.js';
import type { SwapKeystore } from '../../../src/lib/keystore.js';

function isDriveTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'E_DRIVE_TIMEOUT'
  );
}

function silentLogger(): DriveSwapOptions['logger'] {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
  };
}

function buildOptions(swapId: string, signal: AbortSignal): DriveSwapOptions {
  const api = createMockApi();
  api.setSwapDetail(swapId, buildSwapDetail({ status: 'pending' as SwapStatus }));
  return {
    api,
    swapId,
    keystoreId: 'k1',
    wallet: {} as unknown as TempBtcWallet,
    deposit: {} as unknown as DetectedDeposit,
    keystore: {} as unknown as SwapKeystore,
    network: 'mainnet',
    onProgress: () => {},
    signal,
    logger: silentLogger(),
  };
}

function setStatus(opts: DriveSwapOptions, status: SwapStatus): void {
  const api = opts.api as unknown as ReturnType<typeof createMockApi>;
  api.setSwapDetail(opts.swapId, buildSwapDetail({ status }));
}

describe('driveSwapToCompletion deadline enforcement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws E_DRIVE_TIMEOUT when status is pre-funding past the deadline', async () => {
    const ac = new AbortController();
    const opts = buildOptions('s-pre', ac.signal);
    setStatus(opts, 'pending' as SwapStatus);

    const promise = driveSwapToCompletion(opts);
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(SWEEP_TIMEOUT_MS + 60_000);

    await expect(promise).rejects.toMatchObject({ code: 'E_DRIVE_TIMEOUT' });
  });

  it('does not throw E_DRIVE_TIMEOUT when BTC is locked (status deposited)', async () => {
    const ac = new AbortController();
    const opts = buildOptions('s-post', ac.signal);
    setStatus(opts, 'deposited' as SwapStatus);

    const promise = driveSwapToCompletion(opts);
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(SWEEP_TIMEOUT_MS + 60_000);

    ac.abort();
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await promise.catch((err: unknown) => err);
    expect(isDriveTimeout(result)).toBe(false);
  });

  it('does not throw E_DRIVE_TIMEOUT for swapping/sending/punished statuses past deadline', async () => {
    for (const status of ['swapping', 'sending', 'punished'] as SwapStatus[]) {
      const ac = new AbortController();
      const opts = buildOptions(`s-${status}`, ac.signal);
      setStatus(opts, status);

      const promise = driveSwapToCompletion(opts);
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(SWEEP_TIMEOUT_MS + 60_000);

      ac.abort();
      await vi.advanceTimersByTimeAsync(60_000);

      const result = await promise.catch((err: unknown) => err);
      expect(isDriveTimeout(result)).toBe(false);
    }
  });
});

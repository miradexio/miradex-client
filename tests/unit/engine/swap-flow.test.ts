import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SwapFlowState } from '../../../src/engine/flows/swap-flow-state.js';
import type { ResolvedEngineConfig } from '../../../src/engine/miradex-engine.js';
import type { SwapQuote, SwapStatus, PowChallenge } from '../../../src/../../src/types/index.js';
import { createMockApi, buildSwapDetail, buildStatusProgression } from '../../helpers/mock-api.js';
import { createMockPlatform } from '../../helpers/mock-platform.js';

vi.mock('../../../src/lib/pow-solver.js', () => ({
  solveChallenge: async (challenge: PowChallenge) => ({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    number: 42,
    salt: challenge.salt,
    signature: challenge.signature,
  }),
  encodePowHeader: () => 'mock-pow-header',
}));

const { SwapFlow } = await import('../../../src/engine/flows/swap-flow.js');

function defaultConfig(): ResolvedEngineConfig {
  return {
    apiUrl: 'https://test.api',
    apiTimeout: 30_000,
    apiMaxRetries: 3,
    fetchFn: globalThis.fetch,
    network: 'testnet',
    slippageBps: 100,
  };
}

function defaultQuote(): SwapQuote {
  return {
    provider: 'thorchain',
    variantId: 'tc-1',
    variantLabel: 'THORChain',
    expectedOutput: '0.25',
    expectedOutputUsd: '500.00',
    fromChain: 'BTC',
    toChain: 'ETH',
    estimatedDurationSeconds: 300,
    fees: [],
    recommendedSlippageBps: null,
    priceImpactPct: null,
    minAmount: null,
    maxAmount: null,
  };
}

function defaultParams(): {
  readonly fromToken: string;
  readonly fromChain: string;
  readonly toToken: string;
  readonly toChain: string;
  readonly amount: string;
  readonly destAddress: string;
  readonly refundAddress: string;
  readonly selectedQuote: SwapQuote;
} {
  return {
    fromToken: 'BTC',
    fromChain: 'BTC',
    toToken: 'ETH',
    toChain: 'ETH',
    amount: '0.01',
    destAddress: '0xdest',
    refundAddress: 'bc1qrefund',
    selectedQuote: defaultQuote(),
  };
}

describe('SwapFlow', () => {
  let api: ReturnType<typeof createMockApi>;
  let platform: ReturnType<typeof createMockPlatform>;
  let emissions: SwapFlowState[];
  let flow: InstanceType<typeof SwapFlow>;

  beforeEach(() => {
    api = createMockApi();
    platform = createMockPlatform();
    emissions = [];
    flow = new SwapFlow(api, platform, defaultConfig(), (s: SwapFlowState) => emissions.push(s), {
      pollMs: 10,
      pollTimeoutMs: 5_000,
    });
  });

  describe('start()', () => {
    it('emits solving-pow → creating-swap phases', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'completed' as SwapStatus }));
      await flow.start(defaultParams());

      const phases = emissions.map((e) => e.phase);
      expect(phases[0]).toBe('solving-pow');
      expect(phases[1]).toBe('creating-swap');
    });

    it('emits awaiting-deposit with snapshot containing all fields', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'completed' as SwapStatus }));
      await flow.start(defaultParams());

      const deposit = emissions.find((e) => e.phase === 'awaiting-deposit');
      expect(deposit).toBeDefined();
      if (deposit?.phase === 'awaiting-deposit') {
        expect(deposit.snapshot).toBeDefined();
        expect(deposit.snapshot.swapId).toBe('swap-test-1');
        expect(deposit.snapshot.swapNumber).toBe('swap-test-1');
        expect(deposit.snapshot.provider).toBe('thorchain');
        expect(deposit.snapshot.qr).toBe('MOCK_QR_CODE');
        expect(deposit.snapshot.depositAmount).toBeTruthy();
        expect(deposit.snapshot.verification).toBeDefined();
        // When the server hasn't populated verification yet, the flow emits a
        // pending sentinel (verified: false) instead of silently passing.
        // The poll loop upgrades it once detail.verification shows up.
        expect(deposit.snapshot.verification?.verified).toBe(false);
        expect(deposit.snapshot.verification?.checks[0]?.detail).toBe('Pending');
      }
    });

    it('emits completed with snapshot', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({
        status: 'completed' as SwapStatus,
        actualAmountOut: '0.24',
        outputTxHash: 'txhash2',
        durationSeconds: 120,
      }));
      await flow.start(defaultParams());

      const completed = emissions.find((e) => e.phase === 'completed');
      expect(completed).toBeDefined();
      if (completed?.phase === 'completed') {
        expect(completed.actualOut).toBe('0.24');
        expect(completed.outputTxHash).toBe('txhash2');
        expect(completed.snapshot).toBeDefined();
      }
    });

    it('emits cancelled on abort', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'pending' as SwapStatus }));
      const promise = flow.start(defaultParams());
      await new Promise((r) => setTimeout(r, 50));
      flow.cancel();
      await promise;

      const cancelled = emissions.find((e) => e.phase === 'cancelled');
      expect(cancelled).toBeDefined();
    });
  });

  describe('resume()', () => {
    it('emits awaiting-deposit with snapshot for non-terminal swap', async () => {
      api.setSwapDetail('swap-resume-1', [
        buildSwapDetail({
          swapNumber: 'swap-resume-1',
          status: 'pending' as SwapStatus,
          depositAddress: 'bc1qdeposit',
        }),
        buildSwapDetail({
          swapNumber: 'swap-resume-1',
          status: 'completed' as SwapStatus,
        }),
      ]);
      await flow.resume('swap-resume-1', 'thorchain', 'BTC', 'ETH');

      const deposit = emissions.find((e) => e.phase === 'awaiting-deposit');
      expect(deposit).toBeDefined();
      if (deposit?.phase === 'awaiting-deposit') {
        expect(deposit.snapshot.swapId).toBe('swap-resume-1');
        expect(deposit.snapshot.qr).toBe('MOCK_QR_CODE');
      }
    });

    it('shows completed for terminal swaps', async () => {
      api.setSwapDetail('swap-done', buildSwapDetail({
        swapNumber: 'swap-done',
        status: 'completed' as SwapStatus,
        actualAmountOut: '0.24',
      }));
      await flow.resume('swap-done', 'thorchain', 'BTC', 'ETH');

      const completed = emissions.find((e) => e.phase === 'completed');
      expect(completed).toBeDefined();
      if (completed?.phase === 'completed') {
        expect(completed.actualOut).toBe('0.24');
      }
    });

    it('shows failed for failed terminal swaps', async () => {
      api.setSwapDetail('swap-fail', buildSwapDetail({
        swapNumber: 'swap-fail',
        status: 'failed' as SwapStatus,
      }));
      await flow.resume('swap-fail', 'thorchain', 'BTC', 'ETH');

      const failed = emissions.find((e) => e.phase === 'failed');
      expect(failed).toBeDefined();
    });
  });

  describe('snapshot carries forward', () => {
    it('all phases have snapshot after swap creation', async () => {
      api.setSwapDetail('swap-test-1', [
        buildSwapDetail({ status: 'deposited' as SwapStatus }),
        buildSwapDetail({ status: 'completed' as SwapStatus }),
      ]);
      await flow.start(defaultParams());

      const executionPhases = emissions.filter(
        (e) => e.phase !== 'idle' && e.snapshot !== null,
      );
      expect(executionPhases.length).toBeGreaterThan(0);
      for (const phase of executionPhases) {
        expect(phase.snapshot).toBeDefined();
        expect(phase.snapshot?.fromToken).toBe('BTC');
      }
    });
  });

  describe('error handling', () => {
    it('emits failed on API error', async () => {
      (api as Record<string, unknown>).createSwap = async (): Promise<never> => {
        throw new Error('Network timeout');
      };
      await flow.start(defaultParams());

      const failed = emissions.find((e) => e.phase === 'failed');
      expect(failed).toBeDefined();
      if (failed?.phase === 'failed') {
        expect(failed.error).toContain('Network timeout');
        expect(failed.snapshot?.extra?.type).toBe('error');
      }
    });

    it('emits failed on getChallenge error', async () => {
      (api as Record<string, unknown>).getChallenge = async (): Promise<never> => {
        throw new Error('Challenge service unavailable');
      };
      await flow.start(defaultParams());

      const failed = emissions.find((e) => e.phase === 'failed');
      expect(failed).toBeDefined();
      if (failed?.phase === 'failed') {
        expect(failed.error).toContain('Challenge service unavailable');
      }
    });

    it('failed phase includes error message in snapshot extra', async () => {
      (api as Record<string, unknown>).createSwap = async (): Promise<never> => {
        throw new Error('Server 500');
      };
      await flow.start(defaultParams());

      const failed = emissions.find((e) => e.phase === 'failed');
      expect(failed).toBeDefined();
      if (failed?.phase === 'failed') {
        expect(failed.snapshot).toBeDefined();
        expect(failed.snapshot?.extra?.type).toBe('error');
      }
    });
  });

  describe('start() status progression', () => {
    it('progresses through deposited, swapping, sending, completed', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildStatusProgression('swap-test-1', [
          'pending' as SwapStatus,
          'deposited' as SwapStatus,
          'swapping' as SwapStatus,
          'sending' as SwapStatus,
          'completed' as SwapStatus,
        ]),
      );
      await flow.start(defaultParams());

      const phases = emissions.map((e) => e.phase);
      expect(phases).toContain('confirming');
      expect(phases).toContain('swapping');
      expect(phases).toContain('sending');
      expect(phases).toContain('completed');
    });

    it('progresses to failed when server returns failed', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildStatusProgression('swap-test-1', [
          'pending' as SwapStatus,
          'failed' as SwapStatus,
        ]),
      );
      await flow.start(defaultParams());

      const failed = emissions.find((e) => e.phase === 'failed');
      expect(failed).toBeDefined();
      if (failed?.phase === 'failed') {
        expect(failed.error).toContain('failed');
      }
    });

    it('handles refunded terminal', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildStatusProgression('swap-test-1', [
          'pending' as SwapStatus,
          'refunded' as SwapStatus,
        ]),
      );
      await flow.start(defaultParams());

      const refunded = emissions.find((e) => e.phase === 'refunded');
      expect(refunded).toBeDefined();
    });

    it('handles expired terminal', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildSwapDetail({ status: 'expired' as SwapStatus }),
      );
      await flow.start(defaultParams());

      const expired = emissions.find((e) => e.phase === 'expired');
      expect(expired).toBeDefined();
    });
  });

  describe('poll loop behavior', () => {
    it('skips pending status poll ticks without emitting intermediate phases', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildStatusProgression('swap-test-1', [
          'pending' as SwapStatus,
          'pending' as SwapStatus,
          'pending' as SwapStatus,
          'completed' as SwapStatus,
        ]),
      );
      await flow.start(defaultParams());

      const confirming = emissions.filter((e) => e.phase === 'confirming');
      const swapping = emissions.filter((e) => e.phase === 'swapping');
      const sending = emissions.filter((e) => e.phase === 'sending');
      expect(confirming.length).toBe(0);
      expect(swapping.length).toBe(0);
      expect(sending.length).toBe(0);

      const completed = emissions.find((e) => e.phase === 'completed');
      expect(completed).toBeDefined();
    });

    it('emits confirming when status is deposited', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildStatusProgression('swap-test-1', [
          'deposited' as SwapStatus,
          'completed' as SwapStatus,
        ]),
      );
      await flow.start(defaultParams());

      const confirming = emissions.find((e) => e.phase === 'confirming');
      expect(confirming).toBeDefined();
    });

    it('emits swapping when status is swapping', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildStatusProgression('swap-test-1', [
          'swapping' as SwapStatus,
          'completed' as SwapStatus,
        ]),
      );
      await flow.start(defaultParams());

      const swappingPhase = emissions.find((e) => e.phase === 'swapping');
      expect(swappingPhase).toBeDefined();
    });

    it('emits sending when status is sending', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildStatusProgression('swap-test-1', [
          'sending' as SwapStatus,
          'completed' as SwapStatus,
        ]),
      );
      await flow.start(defaultParams());

      const sendingPhase = emissions.find((e) => e.phase === 'sending');
      expect(sendingPhase).toBeDefined();
    });
  });

  describe('cancellation', () => {
    it('cancels during poll loop', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildSwapDetail({ status: 'pending' as SwapStatus }),
      );
      const promise = flow.start(defaultParams());
      await new Promise((r) => setTimeout(r, 50));
      flow.cancel();
      await promise;

      const cancelled = emissions.find((e) => e.phase === 'cancelled');
      expect(cancelled).toBeDefined();
    });

    it('cancel is idempotent', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildSwapDetail({ status: 'pending' as SwapStatus }),
      );
      const promise = flow.start(defaultParams());
      await new Promise((r) => setTimeout(r, 50));
      flow.cancel();
      flow.cancel();
      await promise;

      const cancelledCount = emissions.filter((e) => e.phase === 'cancelled').length;
      expect(cancelledCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('resume() scenarios', () => {
    it('resumes deposited swap at confirming', async () => {
      api.setSwapDetail('swap-resume-dep', [
        buildSwapDetail({
          swapNumber: 'swap-resume-dep',
          status: 'deposited' as SwapStatus,
          depositAddress: 'bc1qdeposit',
        }),
        buildSwapDetail({
          swapNumber: 'swap-resume-dep',
          status: 'deposited' as SwapStatus,
          depositAddress: 'bc1qdeposit',
        }),
        buildSwapDetail({
          swapNumber: 'swap-resume-dep',
          status: 'completed' as SwapStatus,
        }),
      ]);
      await flow.resume('swap-resume-dep', 'thorchain', 'BTC', 'ETH');

      const confirming = emissions.find((e) => e.phase === 'confirming');
      expect(confirming).toBeDefined();

      const completed = emissions.find((e) => e.phase === 'completed');
      expect(completed).toBeDefined();
    });

    it('immediately shows refunded phase for refunded swap', async () => {
      api.setSwapDetail(
        'swap-refunded',
        buildSwapDetail({
          swapNumber: 'swap-refunded',
          status: 'refunded' as SwapStatus,
        }),
      );
      await flow.resume('swap-refunded', 'thorchain', 'BTC', 'ETH');

      const refunded = emissions.find((e) => e.phase === 'refunded');
      expect(refunded).toBeDefined();
    });

    it('immediately shows expired phase for expired swap', async () => {
      api.setSwapDetail(
        'swap-expired',
        buildSwapDetail({
          swapNumber: 'swap-expired',
          status: 'expired' as SwapStatus,
        }),
      );
      await flow.resume('swap-expired', 'thorchain', 'BTC', 'ETH');

      const expired = emissions.find((e) => e.phase === 'expired');
      expect(expired).toBeDefined();
    });
  });

  describe('logging', () => {
    it('logs phase transitions at info level', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildSwapDetail({ status: 'completed' as SwapStatus }),
      );
      await flow.start(defaultParams());

      const logs = platform.getLogs();
      const transitionLogs = logs.filter(
        (l) => l.level === 'info' && l.message === 'Swap phase transition',
      );
      expect(transitionLogs.length).toBeGreaterThan(0);
    });

    it('logs poll ticks at debug level', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildStatusProgression('swap-test-1', [
          'pending' as SwapStatus,
          'completed' as SwapStatus,
        ]),
      );
      await flow.start(defaultParams());

      const logs = platform.getLogs();
      const pollLogs = logs.filter(
        (l) => l.level === 'debug' && l.message === 'Poll tick',
      );
      expect(pollLogs.length).toBeGreaterThan(0);
    });
  });
});

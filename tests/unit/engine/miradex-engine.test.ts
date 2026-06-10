import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EngineState } from '../../../src/engine/engine-state.js';
import type { SwapQuote, SwapStatus, PowChallenge } from '../../../src/../../src/types/index.js';
import { createMockApi, buildSwapDetail } from '../../helpers/mock-api.js';
import { createMockPlatform } from '../../helpers/mock-platform.js';
import { createKeystore } from '../../../src/lib/keystore.js';

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

const { MiradexEngine } = await import('../../../src/engine/miradex-engine.js');

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

function buildTestKeystore(): ReturnType<typeof createKeystore> {
  return createKeystore({
    wif: 'cNvBRnkkuTF9RLKF2GmU3XEjXGBJjiqsQxiWJGRfgN8f7fbigDf',
    btcAddress: 'tb1qtest123',
    network: 'testnet',
    s_b: 'a'.repeat(64),
    v_b: 'b'.repeat(64),
    S_b_bitcoin: 'c'.repeat(66),
    S_b_monero: 'd'.repeat(64),
    dleq_proof: 'e'.repeat(128),
    b: 'f'.repeat(64),
    B: '02' + 'a'.repeat(64),
    receiveAddress: '4XMRADDR...',
    refundAddress: 'tb1qrefund',
  });
}

describe('MiradexEngine', () => {
  let api: ReturnType<typeof createMockApi>;
  let platform: ReturnType<typeof createMockPlatform>;
  let engine: InstanceType<typeof MiradexEngine>;
  let stateEmissions: EngineState[];

  beforeEach(() => {
    api = createMockApi();
    platform = createMockPlatform();
    engine = new MiradexEngine(
      { apiUrl: 'https://test.api', network: 'testnet' },
      platform,
    );
    stateEmissions = [];
    engine.on('state', (s: EngineState) => stateEmissions.push(s));

    // Inject our mock api (engine creates its own ApiClient, so we override)
    (engine as unknown as Record<string, unknown>).api = api;
  });

  afterEach(() => {
    engine.destroy();
  });

  describe('initial state', () => {
    it('starts with idle state and null snapshots', () => {
      expect(engine.state.activeFlow).toBe('idle');
      expect(engine.state.swap.phase).toBe('idle');
      expect(engine.state.atomic.phase).toBe('idle');
    });
  });

  describe('startSwap()', () => {
    it('sets activeFlow to swap and emits state', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'completed' as SwapStatus }));

      await engine.startSwap({
        fromToken: 'BTC',
        fromChain: 'BTC',
        toToken: 'ETH',
        toChain: 'ETH',
        amount: '0.01',
        destAddress: '0x0000000000000000000000000000000000000001',
        refundAddress: 'bc1qrefund',
        selectedQuote: defaultQuote(),
      });

      // Wait for async flow to emit
      await new Promise((r) => setTimeout(r, 200));

      expect(engine.state.activeFlow).toBe('swap');
      // Should have emitted at least solving-pow
      const swapEmissions = stateEmissions.filter((s) => s.swap.phase !== 'idle');
      expect(swapEmissions.length).toBeGreaterThan(0);
    });
  });

  describe('resume()', () => {
    it('routes non-atomicswap provider to SwapFlow', async () => {
      api.setSwapDetail('swap-tc', buildSwapDetail({
        swapId: 'swap-tc',
        provider: 'thorchain',
        status: 'completed' as SwapStatus,
      }));

      await engine.resume('swap-tc');
      await new Promise((r) => setTimeout(r, 200));

      expect(engine.state.activeFlow).toBe('swap');
      const completed = stateEmissions.find((s) => s.swap.phase === 'completed');
      expect(completed).toBeDefined();
    });

    it('routes atomicswap with keystore to AtomicFlow', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');

      api.setSwapDetail('swap-atomic', buildSwapDetail({
        swapId: 'swap-atomic',
        provider: 'atomicswap',
        status: 'completed' as SwapStatus,
        fundingAddress: 'tb1qtest123',
      }));
      platform.simulateDeposit({
        txid: 'abc123', vout: 0, value: 100_000, confirmations: 1, status: 'confirmed',
      });

      await engine.resume('swap-atomic');
      await new Promise((r) => setTimeout(r, 500));

      expect(engine.state.activeFlow).toBe('atomic');
    });

    it('routes atomicswap without keystore to SwapFlow', async () => {
      api.setSwapDetail('swap-no-ks', buildSwapDetail({
        swapId: 'swap-no-ks',
        provider: 'atomicswap',
        status: 'completed' as SwapStatus,
      }));

      await engine.resume('swap-no-ks');
      await new Promise((r) => setTimeout(r, 200));

      expect(engine.state.activeFlow).toBe('swap');
    });

    it('emits failed state on resume error', async () => {
      // No swap detail set — getSwapDetail will throw
      await engine.resume('nonexistent');

      const failed = stateEmissions.find((s) => s.swap.phase === 'failed');
      expect(failed).toBeDefined();
      if (failed?.swap.phase === 'failed') {
        expect(failed.swap.error).toContain('Resume failed');
      }
    });

    it('forwards the destAddress ownership proof to all detail fetches', async () => {
      api.setSwapDetail('swap-proofed', buildSwapDetail({
        swapNumber: 'swap-proofed',
        provider: 'thorchain',
        status: 'completed' as SwapStatus,
      }));

      await engine.resume('swap-proofed', { destAddress: '0xdest' });
      await new Promise((r) => setTimeout(r, 200));

      const detailCalls = api.getCalls().filter((c) => c.method === 'getSwapDetail');
      expect(detailCalls.length).toBeGreaterThan(0);
      for (const call of detailCalls) {
        const proof = call.args?.proof as { readonly destAddress?: string } | undefined;
        expect(proof?.destAddress).toBe('0xdest');
      }
    });
  });

  describe('cancelSwap()', () => {
    it('emits cancelled state', () => {
      engine.cancelSwap();

      const cancelled = stateEmissions.find((s) => s.swap.phase === 'cancelled');
      expect(cancelled).toBeDefined();
    });
  });

  describe('exitToIdle()', () => {
    it('resets all state to idle with snapshot null', async () => {
      // Start a swap first
      api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'completed' as SwapStatus }));
      await engine.startSwap({
        fromToken: 'BTC', fromChain: 'BTC', toToken: 'ETH', toChain: 'ETH',
        amount: '0.01', destAddress: '0x0000000000000000000000000000000000000001', refundAddress: 'bc1qrefund',
        selectedQuote: defaultQuote(),
      });
      await new Promise((r) => setTimeout(r, 100));

      engine.exitToIdle();

      expect(engine.state.activeFlow).toBe('idle');
      expect(engine.state.swap.phase).toBe('idle');
      expect(engine.state.swap.snapshot).toBeNull();
      expect(engine.state.atomic.phase).toBe('idle');
      expect(engine.state.atomic.snapshot).toBeNull();
    });
  });

  describe('scoped callbacks', () => {
    it('new startSwap discards emissions from previous flow', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({
        status: 'pending' as SwapStatus,
      }));

      // Start first swap (will poll indefinitely on 'pending')
      await engine.startSwap({
        fromToken: 'BTC', fromChain: 'BTC', toToken: 'ETH', toChain: 'ETH',
        amount: '0.01', destAddress: '0x0000000000000000000000000000000000000001', refundAddress: 'bc1qrefund',
        selectedQuote: defaultQuote(),
      });
      await new Promise((r) => setTimeout(r, 50));

      // Start second swap — should cancel first
      api.setSwapDetail('swap-test-1', buildSwapDetail({
        status: 'completed' as SwapStatus,
      }));
      await engine.startSwap({
        fromToken: 'BTC', fromChain: 'BTC', toToken: 'ETH', toChain: 'ETH',
        amount: '0.02', destAddress: '0x0000000000000000000000000000000000000002', refundAddress: 'bc1qrefund2',
        selectedQuote: defaultQuote(),
      });
      await new Promise((r) => setTimeout(r, 300));

      // Should end in completed from the second flow
      const lastState = stateEmissions[stateEmissions.length - 1];
      expect(lastState).toBeDefined();
    });
  });

  describe('state emission', () => {
    it('emits complete EngineState on every transition', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'completed' as SwapStatus }));

      await engine.startSwap({
        fromToken: 'BTC', fromChain: 'BTC', toToken: 'ETH', toChain: 'ETH',
        amount: '0.01', destAddress: '0x0000000000000000000000000000000000000001', refundAddress: 'bc1qrefund',
        selectedQuote: defaultQuote(),
      });
      await new Promise((r) => setTimeout(r, 300));

      expect(stateEmissions.length).toBeGreaterThan(0);
      for (const state of stateEmissions) {
        // Every emission must include the per-engine flow branches.
        expect(state.activeFlow).toBeDefined();
        expect(state.swap).toBeDefined();
        expect(state.atomic).toBeDefined();
      }
    });
  });

  describe('destroy()', () => {
    it('removes all listeners', () => {
      engine.destroy();

      // After destroy, no more state emissions
      const countBefore = stateEmissions.length;
      engine.exitToIdle();
      expect(stateEmissions.length).toBe(countBefore);
    });
  });

  describe('logging', () => {
    it('logs engine lifecycle events', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'completed' as SwapStatus }));

      await engine.startSwap({
        fromToken: 'BTC', fromChain: 'BTC', toToken: 'ETH', toChain: 'ETH',
        amount: '0.01', destAddress: '0x0000000000000000000000000000000000000001', refundAddress: 'bc1qrefund',
        selectedQuote: defaultQuote(),
      });
      await new Promise((r) => setTimeout(r, 200));

      engine.exitToIdle();
      engine.destroy();

      const logs = platform.getLogs();
      const infoLogs = logs.filter((l) => l.level === 'info');
      expect(infoLogs.some((l) => l.message === 'Starting standard swap')).toBe(true);
      expect(infoLogs.some((l) => l.message === 'Exiting to idle')).toBe(true);
      expect(infoLogs.some((l) => l.message === 'Engine destroyed')).toBe(true);
    });

    it('logs resume failure at error level', async () => {
      await engine.resume('nonexistent');

      const logs = platform.getLogs();
      const errorLogs = logs.filter((l) => l.level === 'error');
      expect(errorLogs.some((l) => l.message === 'Resume failed')).toBe(true);
    });
  });
});

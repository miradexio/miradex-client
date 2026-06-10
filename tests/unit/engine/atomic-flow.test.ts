import { describe, it, expect, beforeEach } from 'vitest';
import { AtomicFlow } from '../../../src/engine/flows/atomic-flow.js';
import {
  createMockApi,
  buildSwapDetail,
  buildAtomicSwapDetail,
  buildCancelResponse,
  buildRefundResponse,
  buildRequiredAction,
} from '../../helpers/mock-api.js';
import { createMockPlatform } from '../../helpers/mock-platform.js';
import type { AtomicFlowState } from '../../../src/engine/flows/atomic-flow-state.js';
import type { ResolvedEngineConfig } from '../../../src/engine/miradex-engine.js';
import type { SwapStatus } from '../../../src/../../src/types/index.js';
import { createKeystore } from '../../../src/lib/keystore.js';

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

function mockDeposit(): {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  readonly confirmations: number;
  readonly status: 'mempool' | 'confirmed';
  readonly utxos: readonly { readonly txid: string; readonly vout: number; readonly value: number; readonly height: number }[];
} {
  return {
    txid: 'abc123def456',
    vout: 0,
    value: 100_000,
    confirmations: 0,
    status: 'mempool',
    utxos: [{ txid: 'abc123def456', vout: 0, value: 100_000, height: 0 }],
  };
}

describe('AtomicFlow', () => {
  let api: ReturnType<typeof createMockApi>;
  let platform: ReturnType<typeof createMockPlatform>;
  let emissions: AtomicFlowState[];
  let flow: AtomicFlow;

  beforeEach(() => {
    api = createMockApi();
    platform = createMockPlatform();
    emissions = [];
    flow = new AtomicFlow(
      api as Parameters<typeof AtomicFlow.prototype.constructor>[0],
      platform,
      defaultConfig(),
      (s: AtomicFlowState) => emissions.push(s),
      { pollMs: 10 },
    );
  });

  describe('resumeFromKeystore() with existingSwapId (Path A)', () => {
    it('shows completed for terminal swaps', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-1', buildSwapDetail({
        swapNumber: 'swap-1',
        status: 'completed' as SwapStatus,
        actualAmountOut: '0.05',
        outputTxHash: 'xmr-hash',
      }));

      await flow.resumeFromKeystore(id, 'swap-1');

      const completed = emissions.find((e) => e.phase === 'completed');
      expect(completed).toBeDefined();
      if (completed?.phase === 'completed') {
        expect(completed.actualOut).toBe('0.05');
        expect(completed.outputTxHash).toBe('xmr-hash');
        expect(completed.snapshot).toBeDefined();
        expect(completed.snapshot.swapId).toBe('swap-1');
      }
    });

    it('sends the keystore receive address as ownership proof on every swap-scoped call', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-1', buildSwapDetail({
        swapNumber: 'swap-1',
        status: 'completed' as SwapStatus,
        actualAmountOut: '0.05',
        outputTxHash: 'xmr-hash',
      }));

      await flow.resumeFromKeystore(id, 'swap-1');

      const detailCalls = api.getCalls().filter((c) => c.method === 'getSwapDetail');
      expect(detailCalls.length).toBeGreaterThan(0);
      for (const call of detailCalls) {
        const proof = call.args?.proof as { readonly destAddress?: string } | undefined;
        expect(proof?.destAddress).toBe(ks.swap.receiveAddress);
      }
    });

    it('enters creating-swap phase for non-terminal swap', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('*', buildSwapDetail({
        swapNumber: 'swap-active',
        status: 'swapping' as SwapStatus,
      }));

      const promise = flow.resumeFromKeystore(id, 'swap-active');
      await new Promise((r) => setTimeout(r, 100));

      // Path A resumes with creating-swap phase first, then core drives further
      const creating = emissions.find((e) => e.phase === 'creating-swap');
      expect(creating).toBeDefined();
      if (creating?.phase === 'creating-swap') {
        expect(creating.snapshot).toBeDefined();
        expect(creating.snapshot.destAddress).toBe('4XMRADDR...');
      }

      flow.cancel();
      await promise.catch(() => {});
    });
  });

  describe('resumeFromKeystore() without swapId (Path B)', () => {
    it('shows awaiting-deposit when no deposit exists', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      // Don't simulate deposit — fetchUtxo returns null

      const promise = flow.resumeFromKeystore(id);
      await new Promise((r) => setTimeout(r, 100));

      const awaiting = emissions.find((e) => e.phase === 'awaiting-deposit');
      expect(awaiting).toBeDefined();
      if (awaiting?.phase === 'awaiting-deposit') {
        expect(awaiting.snapshot).toBeDefined();
        expect(awaiting.snapshot.qr).toBe('MOCK_QR_CODE');
        expect(awaiting.snapshot.depositAddr).toBe('tb1qtest123');
      }

      flow.cancel();
      await promise.catch(() => {});
    });

    it('shows deposit-detected when deposit exists', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('*', buildSwapDetail({ status: 'completed' as SwapStatus }));

      const promise = flow.resumeFromKeystore(id);
      await new Promise((r) => setTimeout(r, 100));

      const detected = emissions.find((e) => e.phase === 'deposit-detected');
      expect(detected).toBeDefined();

      flow.cancel();
      await promise.catch(() => {});
    });
  });

  describe('cancel()', () => {
    it('transitions to cancelled', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');

      const promise = flow.resumeFromKeystore(id);
      await new Promise((r) => setTimeout(r, 50));
      flow.cancel();
      await promise.catch(() => {});

      const terminal = emissions.find(
        (e) => e.phase === 'cancelled' || e.phase === 'failed',
      );
      expect(terminal).toBeDefined();
    });
  });

  describe('snapshot persistence', () => {
    it('snapshot carries BTC/XMR tokens through all phases', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-1', buildSwapDetail({
        swapNumber: 'swap-1',
        status: 'completed' as SwapStatus,
      }));

      await flow.resumeFromKeystore(id, 'swap-1');

      const withSnapshot = emissions.filter((e) => e.snapshot !== null);
      for (const phase of withSnapshot) {
        expect(phase.snapshot?.fromToken).toBe('BTC');
        expect(phase.snapshot?.toToken).toBe('XMR');
        expect(phase.snapshot?.provider).toBe('atomicswap');
      }
    });

    it('non-terminal resume generates QR in snapshot', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('*', buildSwapDetail({
        swapNumber: 'swap-active',
        status: 'swapping' as SwapStatus,
      }));

      const promise = flow.resumeFromKeystore(id, 'swap-active');
      await new Promise((r) => setTimeout(r, 100));

      const withQr = emissions.filter((e) => e.snapshot !== null && e.snapshot.qr);
      expect(withQr.length).toBeGreaterThan(0);

      flow.cancel();
      await promise.catch(() => {});
    });
  });

  describe('refunded terminal', () => {
    it('emits refunded for refunded status', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-ref', buildSwapDetail({
        swapNumber: 'swap-ref',
        status: 'refunded' as SwapStatus,
        refundTxHash: 'ref-txid',
      }));

      await flow.resumeFromKeystore(id, 'swap-ref');

      const refunded = emissions.find((e) => e.phase === 'refunded');
      expect(refunded).toBeDefined();
      if (refunded?.phase === 'refunded') {
        expect(refunded.refundTxid).toBe('ref-txid');
      }
    });
  });

  describe('resume Path A - terminal statuses', () => {
    it('shows failed for failed status', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-fail', buildAtomicSwapDetail({
        swapNumber: 'swap-fail',
        status: 'failed' as SwapStatus,
      }));

      await flow.resumeFromKeystore(id, 'swap-fail');

      const failed = emissions.find((e) => e.phase === 'failed');
      expect(failed).toBeDefined();
      if (failed?.phase === 'failed') {
        expect(failed.error).toContain('failed');
      }
    });

    it('shows failed for expired status', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-exp', buildAtomicSwapDetail({
        swapNumber: 'swap-exp',
        status: 'expired' as SwapStatus,
      }));

      await flow.resumeFromKeystore(id, 'swap-exp');

      const failed = emissions.find((e) => e.phase === 'failed');
      expect(failed).toBeDefined();
      if (failed?.phase === 'failed') {
        expect(failed.error).toContain('expired');
      }
    });
  });

  describe('resume Path A - action routing', () => {
    it('cancels during active resume', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('*', buildAtomicSwapDetail({
        swapNumber: 'swap-active-cancel',
        status: 'swapping' as SwapStatus,
      }));

      const promise = flow.resumeFromKeystore(id, 'swap-active-cancel');
      await new Promise((r) => setTimeout(r, 50));
      flow.cancel();
      await promise.catch(() => {});

      const terminal = emissions.find(
        (e) => e.phase === 'cancelled' || e.phase === 'failed',
      );
      expect(terminal).toBeDefined();
    });
  });

  describe('cancel() at various points', () => {
    it('cancels during awaiting-deposit (Path B, no deposit)', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      // No deposit simulated — will enter awaiting-deposit

      const promise = flow.resumeFromKeystore(id);
      await new Promise((r) => setTimeout(r, 100));

      const awaiting = emissions.find((e) => e.phase === 'awaiting-deposit');
      expect(awaiting).toBeDefined();

      flow.cancel();
      await promise.catch(() => {});

      const terminal = emissions.find(
        (e) => e.phase === 'cancelled' || e.phase === 'failed',
      );
      expect(terminal).toBeDefined();
    });

    it('cancels during creating-swap (Path A)', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('*', buildAtomicSwapDetail({
        swapNumber: 'swap-cancel-creating',
        status: 'swapping' as SwapStatus,
      }));

      const promise = flow.resumeFromKeystore(id, 'swap-cancel-creating');
      await new Promise((r) => setTimeout(r, 30));
      flow.cancel();
      await promise.catch(() => {});

      const creating = emissions.find((e) => e.phase === 'creating-swap');
      expect(creating).toBeDefined();

      const terminal = emissions.find(
        (e) => e.phase === 'cancelled' || e.phase === 'failed',
      );
      expect(terminal).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('emits failed on loadKeystore error', async () => {
      await flow.resumeFromKeystore('nonexistent-keystore-id', 'swap-1');

      const failed = emissions.find((e) => e.phase === 'failed');
      expect(failed).toBeDefined();
      if (failed?.phase === 'failed') {
        expect(failed.error).toContain('nonexistent-keystore-id');
      }
    });

    it('emits failed on API error during Path A', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      // Set swap detail to throw an error
      api.setSwapDetail('swap-api-err', []);

      await flow.resumeFromKeystore(id, 'swap-api-err');

      const failed = emissions.find((e) => e.phase === 'failed');
      expect(failed).toBeDefined();
    });

    it('includes error message in failed emission', async () => {
      await flow.resumeFromKeystore('missing-ks-42');

      const failed = emissions.find((e) => e.phase === 'failed');
      expect(failed).toBeDefined();
      if (failed?.phase === 'failed') {
        expect(typeof failed.error).toBe('string');
        expect(failed.error.length).toBeGreaterThan(0);
        expect(failed.error).toContain('missing-ks-42');
      }
    });
  });

  describe('snapshot data integrity', () => {
    it('completed phase has outputTxHash and actualOut', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-complete-data', buildAtomicSwapDetail({
        swapNumber: 'swap-complete-data',
        status: 'completed' as SwapStatus,
        actualAmountOut: '1.234',
        outputTxHash: 'xmr-output-hash-abc',
      }));

      await flow.resumeFromKeystore(id, 'swap-complete-data');

      const completed = emissions.find((e) => e.phase === 'completed');
      expect(completed).toBeDefined();
      if (completed?.phase === 'completed') {
        expect(completed.outputTxHash).toBe('xmr-output-hash-abc');
        expect(completed.actualOut).toBe('1.234');
        expect(completed.snapshot).toBeDefined();
      }
    });

    it('refunded phase has swapId and refundTxid', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-refund-data', buildAtomicSwapDetail({
        swapNumber: 'swap-refund-data',
        status: 'refunded' as SwapStatus,
        refundTxHash: 'btc-refund-hash-xyz',
      }));

      await flow.resumeFromKeystore(id, 'swap-refund-data');

      const refunded = emissions.find((e) => e.phase === 'refunded');
      expect(refunded).toBeDefined();
      if (refunded?.phase === 'refunded') {
        expect(refunded.swapId).toBe('swap-refund-data');
        expect(refunded.refundTxid).toBe('btc-refund-hash-xyz');
      }
    });

    it('awaiting-deposit snapshot has depositAddr and qr', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      // No deposit — enters awaiting-deposit

      const promise = flow.resumeFromKeystore(id);
      await new Promise((r) => setTimeout(r, 100));

      const awaiting = emissions.find((e) => e.phase === 'awaiting-deposit');
      expect(awaiting).toBeDefined();
      if (awaiting?.phase === 'awaiting-deposit') {
        expect(awaiting.snapshot.depositAddr).toBe('tb1qtest123');
        expect(awaiting.snapshot.qr).toBe('MOCK_QR_CODE');
      }

      flow.cancel();
      await promise.catch(() => {});
    });

    it('creating-swap snapshot has destAddress from keystore', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('*', buildAtomicSwapDetail({
        swapNumber: 'swap-dest-check',
        status: 'swapping' as SwapStatus,
      }));

      const promise = flow.resumeFromKeystore(id, 'swap-dest-check');
      await new Promise((r) => setTimeout(r, 100));

      const creating = emissions.find((e) => e.phase === 'creating-swap');
      expect(creating).toBeDefined();
      if (creating?.phase === 'creating-swap') {
        expect(creating.snapshot).toBeDefined();
        expect(creating.snapshot.destAddress).toBe('4XMRADDR...');
      }

      flow.cancel();
      await promise.catch(() => {});
    });

    it('completed snapshot carries provider as atomicswap', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-prov', buildAtomicSwapDetail({
        swapNumber: 'swap-prov',
        status: 'completed' as SwapStatus,
      }));

      await flow.resumeFromKeystore(id, 'swap-prov');

      const completed = emissions.find((e) => e.phase === 'completed');
      expect(completed).toBeDefined();
      if (completed?.phase === 'completed') {
        expect(completed.snapshot?.provider).toBe('atomicswap');
      }
    });

    it('failed phase snapshot retains fromToken and toToken', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-fail-tokens', buildAtomicSwapDetail({
        swapNumber: 'swap-fail-tokens',
        status: 'failed' as SwapStatus,
      }));

      await flow.resumeFromKeystore(id, 'swap-fail-tokens');

      const failed = emissions.find((e) => e.phase === 'failed');
      expect(failed).toBeDefined();
      if (failed?.phase === 'failed' && failed.snapshot) {
        expect(failed.snapshot.fromToken).toBe('BTC');
        expect(failed.snapshot.toToken).toBe('XMR');
      }
    });

    it('withheld status produces failed phase', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-withheld', buildAtomicSwapDetail({
        swapNumber: 'swap-withheld',
        status: 'withheld' as SwapStatus,
      }));

      await flow.resumeFromKeystore(id, 'swap-withheld');

      const failed = emissions.find((e) => e.phase === 'failed');
      expect(failed).toBeDefined();
      if (failed?.phase === 'failed') {
        expect(failed.error).toContain('withheld');
      }
    });
  });

  describe('user actions - userCancel()', () => {
    it('userCancel is a no-op when not in awaiting-user-action', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-noop-cancel', buildAtomicSwapDetail({
        status: 'completed' as SwapStatus,
      }));

      await flow.resumeFromKeystore(id, 'swap-noop-cancel');

      const countBefore = emissions.length;
      await flow.userCancel();
      expect(emissions.length).toBe(countBefore);
    });

    it('userRefund is a no-op when not in awaiting-user-action', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-noop-refund', buildAtomicSwapDetail({
        status: 'completed' as SwapStatus,
      }));

      await flow.resumeFromKeystore(id, 'swap-noop-refund');

      const countBefore = emissions.length;
      await flow.userRefund();
      expect(emissions.length).toBe(countBefore);
    });

    it('userRetrySweep is a no-op when no swapId is set', async () => {
      // Fresh flow with no swapId set — userRetrySweep should bail out
      const countBefore = emissions.length;
      await flow.userRetrySweep();
      expect(emissions.length).toBe(countBefore);
    });

    it('cancel does not throw when called on idle flow', () => {
      expect(() => flow.cancel()).not.toThrow();
    });
  });

  describe('logging', () => {
    it('logs phase transitions at info level', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-log-1', buildAtomicSwapDetail({
        swapNumber: 'swap-log-1',
        status: 'completed' as SwapStatus,
      }));

      platform.clearLogs();
      await flow.resumeFromKeystore(id, 'swap-log-1');

      const transitionLogs = platform.getLogs().filter(
        (l) => l.message === 'Atomic phase transition',
      );
      expect(transitionLogs.length).toBeGreaterThan(0);
      expect(transitionLogs.every((l) => l.level === 'info')).toBe(true);
    });

    it('logs resume path info', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-log-2', buildAtomicSwapDetail({
        swapNumber: 'swap-log-2',
        status: 'completed' as SwapStatus,
      }));

      platform.clearLogs();
      await flow.resumeFromKeystore(id, 'swap-log-2');

      const resumeLog = platform.getLogs().find(
        (l) => l.message === 'AtomicFlow.resumeFromKeystore()',
      );
      expect(resumeLog).toBeDefined();
      expect(resumeLog?.level).toBe('info');
    });

    it('logs resume Path A identifier', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-log-pathA', buildAtomicSwapDetail({
        swapNumber: 'swap-log-pathA',
        status: 'completed' as SwapStatus,
      }));

      platform.clearLogs();
      await flow.resumeFromKeystore(id, 'swap-log-pathA');

      const pathALog = platform.getLogs().find(
        (l) => l.message === 'Resume Path A: existing swap',
      );
      expect(pathALog).toBeDefined();
      expect(pathALog?.level).toBe('info');
    });

    it('logs resume Path B identifier', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      // No deposit — enters Path B

      platform.clearLogs();
      const promise = flow.resumeFromKeystore(id);
      await new Promise((r) => setTimeout(r, 100));

      const pathBLog = platform.getLogs().find(
        (l) => l.message === 'Resume Path B: local keystore',
      );
      expect(pathBLog).toBeDefined();
      expect(pathBLog?.level).toBe('info');

      flow.cancel();
      await promise.catch(() => {});
    });

    it('transition log includes phase and prevPhase', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-log-prev', buildAtomicSwapDetail({
        swapNumber: 'swap-log-prev',
        status: 'completed' as SwapStatus,
      }));

      platform.clearLogs();
      await flow.resumeFromKeystore(id, 'swap-log-prev');

      const transitionLogs = platform.getLogs().filter(
        (l) => l.message === 'Atomic phase transition',
      );
      expect(transitionLogs.length).toBeGreaterThan(0);
      for (const log of transitionLogs) {
        expect(log.data).toHaveProperty('phase');
        expect(log.data).toHaveProperty('prevPhase');
      }
    });
  });
});

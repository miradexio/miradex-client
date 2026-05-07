/**
 * Snapshot contract tests.
 *
 * Each phase in SwapFlow / AtomicFlow declares a snapshot type:
 *   FlowContext          — base, all fields nullable
 *   PopulatedFlowContext — depositAddr, destAddress, fromToken, toToken, qr, provider non-empty
 *   VerifiedFlowContext  — populated + verification (VerificationResult) non-null
 *
 * These tests drive the flows to each reachable phase and validate the emitted
 * snapshot against the actual Zod schema — not individual fields.
 * If a test fails, the engine code is buggy (not the test).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FlowContextBaseSchema,
  PopulatedFlowContextSchema,
  VerifiedFlowContextSchema,
} from '../../../src/engine/flow-context.js';
import type { SwapFlowState } from '../../../src/engine/flows/swap-flow-state.js';
import type { AtomicFlowState } from '../../../src/engine/flows/atomic-flow-state.js';
import type { ResolvedEngineConfig } from '../../../src/engine/miradex-engine.js';
import type { SwapQuote, SwapStatus, PowChallenge } from '../../../src/../../src/types/index.js';
import { createMockApi, buildSwapDetail, buildStatusProgression } from '../../helpers/mock-api.js';
import { createMockPlatform } from '../../helpers/mock-platform.js';
import { createKeystore } from '../../../src/lib/keystore.js';
import { AtomicFlow } from '../../../src/engine/flows/atomic-flow.js';

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

// ── Helpers ────────────────────────────────────────────────────────

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

/**
 * Validate a snapshot against a Zod schema.
 * Returns the Zod error details if validation fails, null if OK.
 */
function zodErrors(schema: typeof FlowContextBaseSchema | typeof PopulatedFlowContextSchema | typeof VerifiedFlowContextSchema, snapshot: unknown): string | null {
  const result = schema.safeParse(snapshot);
  if (result.success) return null;
  return result.error.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}

// ── SwapFlow snapshot contracts ────────────────────────────────────

describe('SwapFlow snapshot contracts', () => {
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
      retryMs: 10,
      maxRetries: 5,
    });
  });

  function findPhase<P extends SwapFlowState['phase']>(phase: P): Extract<SwapFlowState, { phase: P }> | undefined {
    return emissions.find((e): e is Extract<SwapFlowState, { phase: P }> => e.phase === phase);
  }

  describe('solving-pow — FlowContext', () => {
    it('snapshot passes FlowContextBaseSchema', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'completed' as SwapStatus }));
      await flow.start(defaultParams());

      const phase = findPhase('solving-pow');
      expect(phase).toBeDefined();
      expect(zodErrors(FlowContextBaseSchema, phase!.snapshot)).toBeNull();
    });
  });

  describe('creating-swap — FlowContext', () => {
    it('snapshot passes FlowContextBaseSchema', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'completed' as SwapStatus }));
      await flow.start(defaultParams());

      const phase = findPhase('creating-swap');
      expect(phase).toBeDefined();
      expect(zodErrors(FlowContextBaseSchema, phase!.snapshot)).toBeNull();
    });
  });

  describe('awaiting-deposit — PopulatedFlowContext', () => {
    it('snapshot passes PopulatedFlowContextSchema', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'completed' as SwapStatus }));
      await flow.start(defaultParams());

      const phase = findPhase('awaiting-deposit');
      expect(phase).toBeDefined();
      const err = zodErrors(PopulatedFlowContextSchema, phase!.snapshot);
      expect(err).toBeNull();
    });

    it('snapshot has verification as valid VerificationResult', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'completed' as SwapStatus }));
      await flow.start(defaultParams());

      const phase = findPhase('awaiting-deposit');
      expect(phase).toBeDefined();
      const v = phase!.snapshot.verification;
      expect(v).not.toBeNull();
      expect(typeof v?.verified).toBe('boolean');
      expect(typeof v?.provider).toBe('string');
      expect(Array.isArray(v?.checks)).toBe(true);
      expect(typeof v?.timestamp).toBe('number');
    });
  });

  describe('confirming — VerifiedFlowContext', () => {
    it('snapshot passes VerifiedFlowContextSchema', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildStatusProgression('swap-test-1', [
          'deposited' as SwapStatus,
          'completed' as SwapStatus,
        ]),
      );
      await flow.start(defaultParams());

      const phase = findPhase('confirming');
      expect(phase).toBeDefined();
      const err = zodErrors(VerifiedFlowContextSchema, phase!.snapshot);
      expect(err).toBeNull();
    });

    it('has requiredAction field (may be null)', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildStatusProgression('swap-test-1', [
          'deposited' as SwapStatus,
          'completed' as SwapStatus,
        ]),
      );
      await flow.start(defaultParams());

      const phase = findPhase('confirming');
      expect(phase).toBeDefined();
      expect('requiredAction' in phase!).toBe(true);
    });
  });

  describe('swapping — VerifiedFlowContext', () => {
    it('snapshot passes VerifiedFlowContextSchema', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildStatusProgression('swap-test-1', [
          'swapping' as SwapStatus,
          'completed' as SwapStatus,
        ]),
      );
      await flow.start(defaultParams());

      const phase = findPhase('swapping');
      expect(phase).toBeDefined();
      const err = zodErrors(VerifiedFlowContextSchema, phase!.snapshot);
      expect(err).toBeNull();
    });
  });

  describe('sending — VerifiedFlowContext', () => {
    it('snapshot passes VerifiedFlowContextSchema', async () => {
      api.setSwapDetail(
        'swap-test-1',
        buildStatusProgression('swap-test-1', [
          'sending' as SwapStatus,
          'completed' as SwapStatus,
        ]),
      );
      await flow.start(defaultParams());

      const phase = findPhase('sending');
      expect(phase).toBeDefined();
      const err = zodErrors(VerifiedFlowContextSchema, phase!.snapshot);
      expect(err).toBeNull();
    });
  });

  describe('completed — FlowContext + terminal fields', () => {
    it('snapshot passes FlowContextBaseSchema', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({
        status: 'completed' as SwapStatus,
        actualAmountOut: '0.24',
        outputTxHash: 'out-hash',
        durationSeconds: 120,
      }));
      await flow.start(defaultParams());

      const phase = findPhase('completed');
      expect(phase).toBeDefined();
      expect(zodErrors(FlowContextBaseSchema, phase!.snapshot)).toBeNull();
    });

    it('carries actualOut, outputTxHash, durationSec', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({
        status: 'completed' as SwapStatus,
        actualAmountOut: '0.24',
        outputTxHash: 'out-hash',
        durationSeconds: 120,
      }));
      await flow.start(defaultParams());

      const phase = findPhase('completed');
      expect(phase).toBeDefined();
      expect(typeof phase!.actualOut).toBe('string');
      expect(phase!.actualOut).toBe('0.24');
      expect(phase!.outputTxHash).toBe('out-hash');
      expect(phase!.durationSec).toBe(120);
    });
  });

  describe('failed — FlowContext | null + error', () => {
    it('snapshot passes FlowContextBaseSchema when present', async () => {
      (api as Record<string, unknown>).createSwap = async (): Promise<never> => {
        throw new Error('Bad request');
      };
      await flow.start(defaultParams());

      const phase = findPhase('failed');
      expect(phase).toBeDefined();
      if (phase!.snapshot !== null) {
        expect(zodErrors(FlowContextBaseSchema, phase!.snapshot)).toBeNull();
      }
    });

    it('has non-empty error string', async () => {
      (api as Record<string, unknown>).createSwap = async (): Promise<never> => {
        throw new Error('Server exploded');
      };
      await flow.start(defaultParams());

      const phase = findPhase('failed');
      expect(phase).toBeDefined();
      expect(typeof phase!.error).toBe('string');
      expect(phase!.error.length).toBeGreaterThan(0);
    });
  });

  describe('cancelled — FlowContext | null', () => {
    it('snapshot passes FlowContextBaseSchema when present', async () => {
      api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'pending' as SwapStatus }));
      const promise = flow.start(defaultParams());
      await new Promise((r) => setTimeout(r, 50));
      flow.cancel();
      await promise;

      const phase = findPhase('cancelled');
      expect(phase).toBeDefined();
      if (phase!.snapshot !== null) {
        expect(zodErrors(FlowContextBaseSchema, phase!.snapshot)).toBeNull();
      }
    });
  });
});

// ── AtomicFlow snapshot contracts ──────────────────────────────────

describe('AtomicFlow snapshot contracts', () => {
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

  function findPhase<P extends AtomicFlowState['phase']>(phase: P): Extract<AtomicFlowState, { phase: P }> | undefined {
    return emissions.find((e): e is Extract<AtomicFlowState, { phase: P }> => e.phase === phase);
  }

  describe('creating-swap — FlowContext', () => {
    it('snapshot passes FlowContextBaseSchema', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-1', buildSwapDetail({
        swapNumber: 'swap-1',
        status: 'completed' as SwapStatus,
      }));

      await flow.resumeFromKeystore(id, 'swap-1');

      const phase = findPhase('creating-swap');
      expect(phase).toBeDefined();
      expect(zodErrors(FlowContextBaseSchema, phase!.snapshot)).toBeNull();
    });

    it('snapshot carries keystore-derived fields', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-1', buildSwapDetail({
        swapNumber: 'swap-1',
        status: 'completed' as SwapStatus,
      }));

      await flow.resumeFromKeystore(id, 'swap-1');

      const phase = findPhase('creating-swap');
      expect(phase).toBeDefined();
      // These fields come from the keystore, not the server
      expect(phase!.snapshot.destAddress).toBe('4XMRADDR...');
      expect(phase!.snapshot.refundAddress).toBe('tb1qrefund');
      expect(phase!.snapshot.depositAddr).toBe('tb1qtest123');
      expect(phase!.snapshot.fromToken).toBe('BTC');
      expect(phase!.snapshot.toToken).toBe('XMR');
      expect(phase!.snapshot.provider).toBe('atomicswap');
    });
  });

  describe('awaiting-deposit — PopulatedFlowContext', () => {
    it('snapshot passes PopulatedFlowContextSchema', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');

      const promise = flow.resumeFromKeystore(id);
      await new Promise((r) => setTimeout(r, 100));

      const phase = findPhase('awaiting-deposit');
      expect(phase).toBeDefined();
      const err = zodErrors(PopulatedFlowContextSchema, phase!.snapshot);
      expect(err).toBeNull();

      flow.cancel();
      await promise.catch(() => {});
    });

    it('has message field', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');

      const promise = flow.resumeFromKeystore(id);
      await new Promise((r) => setTimeout(r, 100));

      const phase = findPhase('awaiting-deposit');
      expect(phase).toBeDefined();
      expect(typeof phase!.message).toBe('string');
      expect(phase!.message.length).toBeGreaterThan(0);

      flow.cancel();
      await promise.catch(() => {});
    });
  });

  describe('deposit-detected — PopulatedFlowContext + deposit', () => {
    it('snapshot passes PopulatedFlowContextSchema', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('*', buildSwapDetail({ status: 'completed' as SwapStatus }));

      const promise = flow.resumeFromKeystore(id);
      await new Promise((r) => setTimeout(r, 200));

      const phase = findPhase('deposit-detected');
      expect(phase).toBeDefined();
      const err = zodErrors(PopulatedFlowContextSchema, phase!.snapshot);
      expect(err).toBeNull();

      flow.cancel();
      await promise.catch(() => {});
    });

    it('deposit object has txid, vout, value', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('*', buildSwapDetail({ status: 'completed' as SwapStatus }));

      const promise = flow.resumeFromKeystore(id);
      await new Promise((r) => setTimeout(r, 200));

      const phase = findPhase('deposit-detected');
      expect(phase).toBeDefined();
      expect(phase!.deposit.txid).toBe('abc123def456');
      expect(phase!.deposit.vout).toBe(0);
      expect(phase!.deposit.value).toBe(100_000);

      flow.cancel();
      await promise.catch(() => {});
    });
  });

  describe('completed — FlowContext + terminal fields', () => {
    it('snapshot passes FlowContextBaseSchema', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-1', buildSwapDetail({
        swapNumber: 'swap-1',
        status: 'completed' as SwapStatus,
        actualAmountOut: '1.5',
        outputTxHash: 'xmr-hash',
        durationSeconds: 600,
      }));

      await flow.resumeFromKeystore(id, 'swap-1');

      const phase = findPhase('completed');
      expect(phase).toBeDefined();
      expect(zodErrors(FlowContextBaseSchema, phase!.snapshot)).toBeNull();
    });

    it('carries actualOut, outputTxHash, durationSec', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-1', buildSwapDetail({
        swapNumber: 'swap-1',
        status: 'completed' as SwapStatus,
        actualAmountOut: '1.5',
        outputTxHash: 'xmr-hash',
        durationSeconds: 600,
      }));

      await flow.resumeFromKeystore(id, 'swap-1');

      const phase = findPhase('completed');
      expect(phase).toBeDefined();
      expect(phase!.actualOut).toBe('1.5');
      expect(phase!.outputTxHash).toBe('xmr-hash');
      expect(phase!.durationSec).toBe(600);
    });
  });

  describe('refunded — terminal fields', () => {
    it('snapshot passes FlowContextBaseSchema when present', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-ref', buildSwapDetail({
        swapNumber: 'swap-ref',
        status: 'refunded' as SwapStatus,
        refundTxHash: 'ref-hash',
      }));

      await flow.resumeFromKeystore(id, 'swap-ref');

      const phase = findPhase('refunded');
      expect(phase).toBeDefined();
      if (phase!.snapshot !== null) {
        expect(zodErrors(FlowContextBaseSchema, phase!.snapshot)).toBeNull();
      }
    });

    it('carries swapId and refundTxid', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-ref', buildSwapDetail({
        swapNumber: 'swap-ref',
        status: 'refunded' as SwapStatus,
        refundTxHash: 'ref-hash',
      }));

      await flow.resumeFromKeystore(id, 'swap-ref');

      const phase = findPhase('refunded');
      expect(phase).toBeDefined();
      expect(phase!.swapId).toBe('swap-ref');
      expect(phase!.refundTxid).toBe('ref-hash');
    });
  });

  describe('cancelled — terminal fields', () => {
    it('has swapId and txCancelTxid (may be null)', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');

      const promise = flow.resumeFromKeystore(id);
      await new Promise((r) => setTimeout(r, 50));
      flow.cancel();
      await promise.catch(() => {});

      const phase = findPhase('cancelled');
      expect(phase).toBeDefined();
      expect('swapId' in phase!).toBe(true);
      expect('txCancelTxid' in phase!).toBe(true);
    });
  });

  describe('failed — error field', () => {
    it('has non-empty error string', async () => {
      await flow.resumeFromKeystore('nonexistent');

      const phase = findPhase('failed');
      expect(phase).toBeDefined();
      expect(typeof phase!.error).toBe('string');
      expect(phase!.error.length).toBeGreaterThan(0);
    });

    it('snapshot passes FlowContextBaseSchema when present', async () => {
      const ks = buildTestKeystore();
      const { id } = await platform.saveKeystore(ks, '0.001');
      platform.simulateDeposit(mockDeposit());

      api.setSwapDetail('swap-fail', buildSwapDetail({
        swapNumber: 'swap-fail',
        status: 'failed' as SwapStatus,
      }));

      await flow.resumeFromKeystore(id, 'swap-fail');

      const phase = findPhase('failed');
      expect(phase).toBeDefined();
      if (phase!.snapshot !== null) {
        expect(zodErrors(FlowContextBaseSchema, phase!.snapshot)).toBeNull();
      }
    });
  });
});

// ── Validation gate tests ──────────────────────────────────────────
// Test that when Zod validation fails, flows emit 'failed' instead of
// the target phase. These exercise requirePopulated() / requireVerified().

describe('SwapFlow validation gates', () => {
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
      retryMs: 10,
      maxRetries: 5,
    });
  });

  it('emits failed when depositAddress is empty (PopulatedFlowContext gate fails)', async () => {
    // Server returns empty depositAddress → qr will be empty → requirePopulated fails
    api = createMockApi({
      createSwapResponse: {
        swapNumber: 'swap-gate',
        status: 'pending',
        provider: 'thorchain',
        depositAddress: '',
        fromToken: 'BTC',
        toToken: 'ETH',
        amountIn: '0.01',
        amountInUsd: '500.00',
        expectedAmountOut: '0.25',
        expectedAmountOutUsd: '500.00',
        priceImpactPct: '0.1',
        expiresAt: null,
        requiresFunding: false,
        verification: null,
      },
    });
    // Rebuild flow with new api
    flow = new SwapFlow(api, platform, defaultConfig(), (s: SwapFlowState) => emissions.push(s), {
      pollMs: 10,
      pollTimeoutMs: 5_000,
      retryMs: 10,
      maxRetries: 5,
    });

    api.setSwapDetail('swap-gate', buildSwapDetail({ status: 'completed' as SwapStatus }));
    await flow.start(defaultParams());

    const failed = emissions.find((e) => e.phase === 'failed');
    expect(failed).toBeDefined();
    if (failed?.phase === 'failed') {
      expect(failed.error).toContain('FlowContext validation failed');
    }

    // awaiting-deposit should NOT have been emitted
    const deposit = emissions.find((e) => e.phase === 'awaiting-deposit');
    expect(deposit).toBeUndefined();
  });
});

describe('AtomicFlow validation gates', () => {
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

  it('emits failed when QR generation returns empty string (PopulatedFlowContext gate fails)', async () => {
    // Override generateQr to return empty string
    (platform as Record<string, unknown>).generateQr = async (): Promise<string> => '';

    const ks = buildTestKeystore();
    const { id } = await platform.saveKeystore(ks, '0.001');

    const promise = flow.resumeFromKeystore(id);
    await new Promise((r) => setTimeout(r, 200));

    const failed = emissions.find((e) => e.phase === 'failed');
    expect(failed).toBeDefined();
    if (failed?.phase === 'failed') {
      expect(failed.error).toContain('FlowContext validation failed');
    }

    // awaiting-deposit should NOT have been emitted
    const deposit = emissions.find((e) => e.phase === 'awaiting-deposit');
    expect(deposit).toBeUndefined();

    flow.cancel();
    await promise.catch(() => {});
  });
});

// ── Server error resilience tests ──────────────────────────────────

describe('SwapFlow server error resilience', () => {
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
      retryMs: 10,
      maxRetries: 5,
    });
  });

  it('stays at creating-swap on 500 and retries until success', async () => {
    let callCount = 0;
    const originalCreateSwap = api.createSwap.bind(api);
    (api as Record<string, unknown>).createSwap = async (...args: readonly unknown[]): Promise<unknown> => {
      callCount++;
      if (callCount <= 2) {
        const { ApiError } = await import('../../../src/api/index.js');
        throw new ApiError('Internal Server Error', 500, 'SERVER_ERROR');
      }
      return (originalCreateSwap as (...a: readonly unknown[]) => Promise<unknown>)(...args);
    };

    api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'completed' as SwapStatus }));
    await flow.start(defaultParams());

    // Should have eventually succeeded
    const completed = emissions.find((e) => e.phase === 'completed');
    expect(completed).toBeDefined();

    // Should have retried (retry warning logs)
    const logs = platform.getLogs();
    const retryLogs = logs.filter((l) => l.message.includes('retrying'));
    expect(retryLogs.length).toBeGreaterThan(0);
  });

  it('does NOT retry on 400 (client error) — fails immediately', async () => {
    (api as Record<string, unknown>).createSwap = async (): Promise<never> => {
      const { ApiError } = await import('../../../src/api/index.js');
      throw new ApiError('Bad Request', 400, 'BAD_REQUEST');
    };

    await flow.start(defaultParams());

    const failed = emissions.find((e) => e.phase === 'failed');
    expect(failed).toBeDefined();

    // Should NOT have retried — only 1 creating-swap emission
    const creatingPhases = emissions.filter((e) => e.phase === 'creating-swap');
    expect(creatingPhases.length).toBe(1);
  });

  it('does NOT retry on 404 — fails immediately', async () => {
    (api as Record<string, unknown>).getSwapDetail = async (): Promise<never> => {
      const { ApiError } = await import('../../../src/api/index.js');
      throw new ApiError('Not Found', 404, 'NOT_FOUND');
    };

    await flow.resume('swap-404', 'thorchain', 'BTC', 'ETH');

    const failed = emissions.find((e) => e.phase === 'failed');
    expect(failed).toBeDefined();
  });

  it('retries getSwapDetail on NetworkError during resume', async () => {
    let callCount = 0;
    const originalGetDetail = api.getSwapDetail.bind(api);
    (api as Record<string, unknown>).getSwapDetail = async (...args: readonly unknown[]): Promise<unknown> => {
      callCount++;
      if (callCount <= 2) {
        const { NetworkError } = await import('../../../src/api/index.js');
        throw new NetworkError('Connection refused');
      }
      return (originalGetDetail as (...a: readonly unknown[]) => Promise<unknown>)(...args);
    };

    api.setSwapDetail('swap-retry', buildSwapDetail({
      swapNumber: 'swap-retry',
      status: 'completed' as SwapStatus,
    }));

    await flow.resume('swap-retry', 'thorchain', 'BTC', 'ETH');

    // Should have eventually succeeded
    const completed = emissions.find((e) => e.phase === 'completed');
    expect(completed).toBeDefined();

    // Should have retried (warning extras during retry)
    const logs = platform.getLogs();
    const retryLogs = logs.filter((l) => l.message.includes('retrying'));
    expect(retryLogs.length).toBeGreaterThan(0);
  });

  it('poll loop continues on server errors without failing', async () => {
    let pollCount = 0;
    const originalGetDetail = api.getSwapDetail.bind(api);
    (api as Record<string, unknown>).getSwapDetail = async (...args: readonly unknown[]): Promise<unknown> => {
      pollCount++;
      // First call succeeds (for initial createSwap flow), then 2 poll errors, then success
      if (pollCount === 2 || pollCount === 3) {
        throw new Error('Connection reset');
      }
      return (originalGetDetail as (...a: readonly unknown[]) => Promise<unknown>)(...args);
    };

    api.setSwapDetail('swap-test-1', buildSwapDetail({ status: 'completed' as SwapStatus }));
    await flow.start(defaultParams());

    // Poll loop should have recovered and completed
    const completed = emissions.find((e) => e.phase === 'completed');
    expect(completed).toBeDefined();
  });
});

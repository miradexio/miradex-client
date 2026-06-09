import { describe, it, expect, beforeEach } from 'vitest';
import { AtomicFlow } from '../../../src/engine/flows/atomic-flow.js';
import { SwapCancelledError } from '../../../src/atomic-swap/types.js';
import { VerificationError } from '../../../src/types/index.js';
import { createMockApi } from '../../helpers/mock-api.js';
import { createMockPlatform } from '../../helpers/mock-platform.js';
import type { AtomicFlowState } from '../../../src/engine/flows/atomic-flow-state.js';
import type { ResolvedEngineConfig } from '../../../src/engine/miradex-engine.js';

interface FlowInternals {
  lastSeenStatus: string | null;
  handleError: (err: unknown) => void;
  abortController: AbortController | null;
}

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

describe('AtomicFlow.handleError routing', () => {
  let api: ReturnType<typeof createMockApi>;
  let platform: ReturnType<typeof createMockPlatform>;
  let emissions: AtomicFlowState[];
  let flow: AtomicFlow;
  let internals: FlowInternals;

  beforeEach(() => {
    api = createMockApi();
    platform = createMockPlatform();
    emissions = [];
    flow = new AtomicFlow(
      api as Parameters<typeof AtomicFlow.prototype.constructor>[0],
      platform,
      defaultConfig(),
      (s: AtomicFlowState) => emissions.push(s),
    );
    internals = flow as unknown as FlowInternals;
    internals.abortController = new AbortController();
  });

  it('routes a generic error to stalled when lastSeenStatus is post-funding', () => {
    internals.lastSeenStatus = 'deposited';
    internals.handleError(new Error('network blip'));

    const last = emissions[emissions.length - 1];
    expect(last?.phase).toBe('stalled');
    if (last?.phase === 'stalled') {
      expect(last.error).toBe('network blip');
    }
  });

  it('routes a generic error to failed when lastSeenStatus is pre-funding', () => {
    internals.lastSeenStatus = 'pending';
    internals.handleError(new Error('boom'));

    const last = emissions[emissions.length - 1];
    expect(last?.phase).toBe('failed');
    if (last?.phase === 'failed') {
      expect(last.error).toBe('boom');
    }
  });

  it('routes VerificationError to failed even when post-funding', () => {
    internals.lastSeenStatus = 'swapping';
    internals.handleError(new VerificationError('E_DLEQ_PROOF_INVALID', 'dleq invalid'));

    const last = emissions[emissions.length - 1];
    expect(last?.phase).toBe('failed');
  });

  it('routes SwapCancelledError to cancelled', () => {
    internals.lastSeenStatus = 'deposited';
    internals.handleError(new SwapCancelledError());

    const last = emissions[emissions.length - 1];
    expect(last?.phase).toBe('cancelled');
  });

  it('routes any error to cancelled when the signal is aborted', () => {
    internals.lastSeenStatus = 'swapping';
    internals.abortController?.abort();
    internals.handleError(new Error('mid-flight'));

    const last = emissions[emissions.length - 1];
    expect(last?.phase).toBe('cancelled');
  });
});

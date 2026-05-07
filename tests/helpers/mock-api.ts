import type { ApiClient } from '../../src/api/index.js';
import type {
  SwapDetail,
  CreateSwapResponse,
  SwapActionResponse,
  PowChallenge,
  QuotesResponse,
  SwapAction,
  SwapStatus,
  SwapProvider,
  RequiredAction,
} from '../../src/types/index.js';

export interface ApiCall {
  readonly method: string;
  readonly args?: Record<string, unknown>;
}

export interface MockApiConfig {
  createSwapResponse: CreateSwapResponse;
  swapDetailResponses: Map<string, SwapDetail | SwapDetail[]>;
  actionResponses: Map<string, SwapActionResponse>;
  challengeResponse: PowChallenge;
  verifyKeysResponse: { readonly valid: boolean; readonly reason: string };
  quotesResponse: QuotesResponse;
}

export interface MockApiControls {
  getCalls(): ApiCall[];
  clearCalls(): void;
  setSwapDetail(id: string, detail: SwapDetail | SwapDetail[]): void;
  setActionResponse(swapId: string, type: string, response: SwapActionResponse): void;
}

function defaultChallenge(): PowChallenge {
  return {
    algorithm: 'SHA-256',
    challenge: 'test-challenge',
    salt: 'test-salt',
    maxnumber: 100000,
    signature: 'test-sig',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

function defaultCreateSwapResponse(): CreateSwapResponse {
  return {
    swapNumber: 'swap-test-1',
    status: 'pending',
    provider: 'thorchain',
    depositAddress: 'bc1qdeposit',
    fromToken: 'BTC',
    toToken: 'ETH',
    amountIn: '0.01',
    amountInUsd: '500.00',
    expectedAmountOut: '0.25',
    expectedAmountOutUsd: '500.00',
    priceImpactPct: '0.1',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    requiresFunding: false,
    verification: null,
  };
}

function defaultQuotesResponse(): QuotesResponse {
  return {
    from: 'BTC',
    to: 'XMR',
    amount: '0.01',
    amountInUsd: '500.00',
    quotes: [
      {
        provider: 'atomicswap',
        variantId: 'atomic-1',
        variantLabel: 'Atomic Swap',
        expectedOutput: '1.5',
        expectedOutputUsd: '500.00',
        fromChain: 'BTC',
        toChain: 'XMR',
        estimatedDurationSeconds: 600,
        fees: [],
        recommendedSlippageBps: null,
        priceImpactPct: null,
        minAmount: '0.001',
        maxAmount: '1.0',
      },
    ],
    cachedAt: null,
    source: 'mock',
  };
}

function defaultActionResponse(swapId: string, _actionType: string): SwapActionResponse {
  return {
    swapId,
    status: 'swapping',
    message: 'Action executed',
    protocolData: null,
  };
}

/**
 * Creates a mock ApiClient that returns pre-configured responses.
 * Use this in ALL flow tests to avoid real network calls.
 */
export function createMockApi(
  overrides?: Partial<MockApiConfig>,
): ApiClient & MockApiControls {
  const config: MockApiConfig = {
    createSwapResponse: defaultCreateSwapResponse(),
    swapDetailResponses: new Map(),
    actionResponses: new Map(),
    challengeResponse: defaultChallenge(),
    verifyKeysResponse: { valid: true, reason: 'OK' },
    quotesResponse: defaultQuotesResponse(),
    ...overrides,
  };

  const calls: ApiCall[] = [];

  const mock = {
    getChallenge: async (): Promise<PowChallenge> => {
      calls.push({ method: 'getChallenge' });
      return config.challengeResponse;
    },

    createSwap: async (body: unknown, powHeader?: string): Promise<CreateSwapResponse> => {
      calls.push({ method: 'createSwap', args: { body, powHeader } });
      return config.createSwapResponse;
    },

    getSwapDetail: async (id: string): Promise<SwapDetail> => {
      calls.push({ method: 'getSwapDetail', args: { id } });
      const response = config.swapDetailResponses.get(id) ?? config.swapDetailResponses.get('*');
      if (!response) throw new Error(`No mock response for swap ${id}`);
      if (Array.isArray(response)) {
        const next = response.shift();
        if (!next) throw new Error(`Mock responses exhausted for swap ${id}`);
        return next;
      }
      return response;
    },

    executeAction: async (swapId: string, action: SwapAction): Promise<SwapActionResponse> => {
      const actionType = action.type;
      calls.push({ method: 'executeAction', args: { swapId, action } });
      const key = `${swapId}:${actionType}`;
      return config.actionResponses.get(key) ?? defaultActionResponse(swapId, actionType);
    },

    verifyKeys: async (): Promise<{ valid: boolean; reason: string }> => {
      calls.push({ method: 'verifyKeys' });
      return config.verifyKeysResponse;
    },

    getQuotes: async (): Promise<QuotesResponse> => {
      calls.push({ method: 'getQuotes' });
      return config.quotesResponse;
    },

    // Control methods
    getCalls: (): ApiCall[] => [...calls],
    clearCalls: (): void => {
      calls.length = 0;
    },
    setSwapDetail: (id: string, detail: SwapDetail | SwapDetail[]): void => {
      config.swapDetailResponses.set(id, detail);
    },
    setActionResponse: (swapId: string, type: string, response: SwapActionResponse): void => {
      config.actionResponses.set(`${swapId}:${type}`, response);
    },
  } as unknown as ApiClient & MockApiControls;

  return mock;
}

/**
 * Build a minimal SwapDetail for testing.
 */
export function buildSwapDetail(overrides?: Partial<SwapDetail>): SwapDetail {
  return {
    swapNumber: 'swap-test-1',
    status: 'completed' as SwapStatus,
    provider: 'thorchain',
    depositAddress: 'bc1qdeposit',
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
    fromChain: 'BTC',
    toChain: 'ETH',
    destAddress: '0xdest',
    fundingAddress: null,
    refundAddress: 'bc1qrefund',
    actualAmountOut: '0.24',
    actualAmountOutUsd: '480.00',
    depositTxHash: 'txhash1',
    outputTxHash: 'txhash2',
    refundTxHash: null,
    durationSeconds: 120,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a SwapDetail with atomicswap defaults (BTC→XMR).
 */
export function buildAtomicSwapDetail(overrides?: Partial<SwapDetail>): SwapDetail {
  return buildSwapDetail({
    provider: 'atomicswap' as SwapProvider,
    fromToken: 'BTC',
    toToken: 'XMR',
    fromChain: 'BTC',
    toChain: 'XMR',
    destAddress: '4XMRADDR...',
    requiresFunding: true,
    ...overrides,
  });
}

/**
 * Build a queued array of SwapDetails simulating server status progression.
 * Each call to getSwapDetail shifts the next response off the array.
 */
export function buildStatusProgression(
  swapId: string,
  statuses: readonly SwapStatus[],
  overrides?: Partial<SwapDetail>,
): SwapDetail[] {
  return statuses.map((status) =>
    buildSwapDetail({ swapId, status, ...overrides }),
  );
}

/**
 * Build a RequiredAction object for testing user action phases.
 */
export function buildRequiredAction(
  type: RequiredAction['type'],
  overrides?: Partial<RequiredAction>,
): RequiredAction {
  return {
    type,
    urgency: 'medium',
    message: `Action required: ${type}`,
    blocksRemaining: null,
    estimatedSecondsRemaining: null,
    ...overrides,
  };
}

/**
 * Build an action response for 'fund' action.
 */
export function buildFundResponse(swapId: string): SwapActionResponse {
  return { swapId, status: 'deposited', message: 'Funded', protocolData: null };
}

/**
 * Build an action response for 'cancel' action.
 */
export function buildCancelResponse(swapId: string, txCancelTxid: string): SwapActionResponse {
  return {
    swapId,
    status: 'cancelling',
    message: 'Cancelled',
    protocolData: { tx_cancel_txid: txCancelTxid },
  };
}

/**
 * Build an action response for 'refund' action.
 */
export function buildRefundResponse(swapId: string, txRefundTxid: string): SwapActionResponse {
  return {
    swapId,
    status: 'refunded',
    message: 'Refunded',
    protocolData: { tx_refund_txid: txRefundTxid },
  };
}

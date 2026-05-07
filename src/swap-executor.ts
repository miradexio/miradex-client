import type { ApiClient } from './api/index.js';
import type {
  CreateSwapBody,
  SwapDetail,
  VerificationResult,
  SwapStatus,
  ProtocolData,
  SwapVerification,
} from './types/index.js';
import { TERMINAL_STATUSES, VerificationError, isAtomicProtocolData } from './types/index.js';
import { verifyDepositAddress } from './verification/index.js';
import { generateClientKeys, isKeygenAvailable } from './lib/crypto/wasm.js';
import { delay } from './lib/delay.js';

export interface SwapResult {
  readonly swapId: string;
  readonly swapNumber: string;
  readonly status: SwapStatus;
  readonly provider: string;
  readonly depositAddress: string | null;
  readonly verification: VerificationResult | null;
  readonly expectedAmountOut: string | null;
  readonly amountIn: string | null;
  readonly expiresAt: string | null;
  readonly protocolData?: ProtocolData;
}

export class SwapExecutor {
  constructor(
    private readonly api: ApiClient,
    private readonly pollIntervalMs = 5_000,
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async executeSwap(
    params: {
      from: string;
      to: string;
      amount: string;
      destAddress: string;
      refundAddress: string;
      provider?: string;
      variantId?: string;
      fromChain?: string;
      toChain?: string;
      slippageBps?: number;
      /** Opt-in: skip the refundAddress check for providers without refund binding. */
      acknowledgedNoRefundAddress?: boolean;
    },
    powHeader?: string,
  ): Promise<SwapResult> {
    if (!params.refundAddress && !params.acknowledgedNoRefundAddress) {
      throw new VerificationError(
        'E_PROVIDER_UNSUPPORTED_REFUND',
        'refundAddress is required; set acknowledgedNoRefundAddress:true to override',
      );
    }
    const swap = await this.api.createSwap(params, powHeader);
    if (params.provider && swap.provider !== params.provider) {
      throw new VerificationError(
        'E_PROVIDER_SUBSTITUTED',
        `server returned provider ${swap.provider}, caller requested ${params.provider}`,
      );
    }
    const vr = await this.verify(swap, params);

    return {
      swapId: swap.swapNumber,
      swapNumber: swap.swapNumber,
      status: swap.status,
      provider: swap.provider,
      depositAddress: vr?.verified ? swap.depositAddress : null,
      verification: vr,
      expectedAmountOut: swap.expectedAmountOut,
      amountIn: swap.amountIn,
      expiresAt: swap.expiresAt,
      protocolData: swap.protocolData ?? undefined,
    };
  }

  async executeAtomicSwap(params: {
    amount: string;
    destAddress: string;
    refundAddress: string;
  }): Promise<SwapResult> {
    if (!isKeygenAvailable()) {
      throw new Error('keygen-wasm not available — atomic swaps disabled');
    }

    const keys = generateClientKeys();
    const body: CreateSwapBody = {
      from: 'BTC',
      to: 'XMR',
      amount: params.amount,
      destAddress: params.destAddress,
      refundAddress: params.refundAddress,
      provider: 'atomicswap',
      protocol: {
        type: 'atomicSwap',
        atomicSwap: {
          S_b_bitcoin: keys.s_b_bitcoin,
          S_b_monero: keys.s_b_monero,
          dleq_proof: keys.dleq_proof,
          v_b: keys.v_b,
          B: keys.B,
        },
      },
    };

    const swap = await this.api.createSwap(body);
    if (swap.provider !== 'atomicswap') {
      throw new VerificationError(
        'E_PROVIDER_SUBSTITUTED',
        `server returned provider ${swap.provider} for an atomic-swap request`,
      );
    }

    const current =
      swap.status === 'initializing'
        ? await this.pollUntil(swap.swapNumber, ['awaiting_funding', 'failed', 'expired'])
        : swap;

    const vr = await this.verify(current, { ...params, from: 'BTC', to: 'XMR' });

    return {
      swapId: current.swapNumber,
      swapNumber: current.swapNumber,
      status: current.status,
      provider: 'atomicswap',
      depositAddress: vr?.verified ? current.depositAddress : null,
      verification: vr,
      expectedAmountOut: current.expectedAmountOut,
      amountIn: current.amountIn,
      expiresAt: current.expiresAt,
      protocolData: current.protocolData ?? undefined,
    };
  }

  async fundSwap(swapId: string, signedPsbt: string): Promise<unknown> {
    return this.api.executeAction(swapId, { type: 'fund', signedPsbt });
  }

  async cancelSwap(swapId: string, reason?: string): Promise<unknown> {
    return this.api.executeAction(swapId, { type: 'cancel', reason });
  }

  async getSweepOutputs(swapId: string): Promise<unknown> {
    return this.api.executeAction(swapId, { type: 'get-outputs' }, 120_000);
  }

  async submitKeyImages(swapId: string, keyImagesHex: string): Promise<unknown> {
    return this.api.executeAction(swapId, { type: 'get-key-images', keyImagesHex }, 120_000);
  }

  async submitMoneroTx(swapId: string, signedTxHex: string): Promise<unknown> {
    return this.api.executeAction(swapId, { type: 'submit-monero-tx', signedTxHex }, 120_000);
  }

  async pollUntil(
    swapId: string,
    targets: readonly SwapStatus[],
    timeoutMs = 120_000,
    onPoll?: (detail: SwapDetail) => void,
    signal?: AbortSignal,
  ): Promise<SwapDetail> {
    const targetSet = new Set([...targets, ...TERMINAL_STATUSES]);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (signal?.aborted) return this.api.getSwapDetail(swapId);

      const detail = await this.api.getSwapDetail(swapId);
      onPoll?.(detail);
      if (targetSet.has(detail.status)) return detail;

      // Stop early when the swap needs user action.
      const actionType = detail.requiredAction?.type;
      if (actionType === 'cancel' || actionType === 'refund' || actionType === 'sweep') {
        return detail;
      }

      await delay(this.pollIntervalMs, signal);
    }

    return this.api.getSwapDetail(swapId);
  }

  private async verify(
    swap: {
      readonly depositAddress: string | null;
      readonly verification: SwapVerification | null;
      readonly protocolData?: ProtocolData | null;
      readonly expectedAmountOut?: string | null;
    },
    params: {
      readonly destAddress: string;
      readonly refundAddress: string;
      readonly to?: string;
      readonly toToken?: string;
      readonly amount?: string;
      readonly from?: string;
    },
  ): Promise<VerificationResult | null> {
    if (swap.depositAddress === null || swap.verification === null) {
      return null;
    }

    return verifyDepositAddress({
      depositAddress: swap.depositAddress,
      verification: swap.verification,
      destAddress: params.destAddress,
      refundAddress: params.refundAddress,
      toToken: params.to ?? params.toToken ?? '',
      amount: params.amount ?? '',
      protocol: isAtomicProtocolData(swap.protocolData)
        ? {
            psbt: swap.protocolData.psbt,
            lock_address: swap.protocolData.lock_address,
            timelock_blocks: swap.protocolData.timelock_blocks,
          }
        : undefined,
      expectedAmountOut: swap.expectedAmountOut ?? undefined,
      expectedDestAddress: params.destAddress,
      fetchFn: this.fetchFn,
    });
  }
}

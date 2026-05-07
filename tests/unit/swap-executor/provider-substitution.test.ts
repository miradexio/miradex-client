import { describe, it, expect } from 'vitest';
import { SwapExecutor } from '../../../src/swap-executor.js';
import type { ApiClient } from '../../../src/api/index.js';
import { VerificationError } from '../../../src/types/index.js';

function fakeApi(partial: Partial<ApiClient>): ApiClient {
  return partial as unknown as ApiClient;
}

describe('SwapExecutor provider-substitution check', () => {
  it('throws E_PROVIDER_SUBSTITUTED when server returns a different provider', async () => {
    const api = fakeApi({
      createSwap: async () => ({
        swapId: 's1',
        swapNumber: 'MIRA-1',
        status: 'pending',
        provider: 'thorchain',
        depositAddress: 'bc1q',
        fromToken: 'BTC',
        toToken: 'ETH',
        amountIn: '0.1',
        amountInUsd: null,
        expectedAmountOut: '100',
        expectedAmountOutUsd: null,
        priceImpactPct: null,
        expiresAt: null,
        requiresFunding: true,
        verification: null,
      }),
    });
    const executor = new SwapExecutor(api);
    let caught: VerificationError | undefined;
    try {
      await executor.executeSwap({
        from: 'BTC',
        to: 'ETH',
        amount: '0.1',
        destAddress: '0xdest',
        refundAddress: 'bc1qrefund',
        provider: 'chainflip',
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_PROVIDER_SUBSTITUTED');
  });

  it('throws E_PROVIDER_UNSUPPORTED_REFUND when refund is empty without ack', async () => {
    const api = fakeApi({});
    const executor = new SwapExecutor(api);
    let caught: VerificationError | undefined;
    try {
      await executor.executeSwap({
        from: 'BTC',
        to: 'ETH',
        amount: '0.1',
        destAddress: '0xdest',
        refundAddress: '',
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_PROVIDER_UNSUPPORTED_REFUND');
  });
});

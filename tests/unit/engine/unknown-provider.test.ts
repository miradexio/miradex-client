import { describe, it, expect, vi } from 'vitest';
import { MiradexEngine } from '../../../src/engine/miradex-engine.js';
import type { PlatformAdapter } from '../../../src/engine/platform.js';

function fakePlatform(): PlatformAdapter {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as PlatformAdapter;
}

describe('MiradexEngine unknown-provider dispatch', () => {
  it('emits a failed state with E_PROVIDER_UNKNOWN when detail.provider is unknown', async () => {
    const engine = new MiradexEngine({ apiUrl: 'http://x' }, fakePlatform());
    vi.spyOn(engine.apiClient, 'getSwapDetail').mockResolvedValue({
      swapId: 'x',
      swapNumber: 'X',
      status: 'pending',
      provider: 'unicorn' as unknown as never,
      depositAddress: null,
      fromToken: 'BTC',
      toToken: 'ETH',
      amountIn: '0',
      amountInUsd: null,
      expectedAmountOut: null,
      expectedAmountOutUsd: null,
      priceImpactPct: null,
      expiresAt: null,
      requiresFunding: false,
      verification: null,
      fromChain: 'bitcoin',
      toChain: 'ethereum',
      destAddress: '0x',
      fundingAddress: null,
      refundAddress: null,
      actualAmountOut: null,
      actualAmountOutUsd: null,
      depositTxHash: null,
      outputTxHash: null,
      refundTxHash: null,
      durationSeconds: null,
      createdAt: '',
      updatedAt: '',
      completedAt: null,
    });

    let emittedError: string | null = null;
    engine.on('state', (state) => {
      if (state.swap.phase === 'failed' && state.swap.error) emittedError = state.swap.error;
    });

    await engine.resume('x');
    expect(emittedError ?? '').toMatch(/unknown provider|E_PROVIDER_UNKNOWN|E_PROVIDER_SUBSTITUTED/i);
  });
});

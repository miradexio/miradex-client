import { describe, it, expect } from 'vitest';
import {
  swapStatusSchema,
  swapVerificationSchema,
  createSwapBodySchema,
  createSwapResponseSchema,
  swapDetailSchema,
  recentSwapSchema,
  requiredActionSchema,
} from '../../../../src/wire/server/swap.zod.js';

describe('swapStatusSchema', () => {
  it.each([
    'initializing',
    'pending',
    'awaiting_funding',
    'deposited',
    'swapping',
    'sending',
    'cancelling',
    'completed',
    'failed',
    'refunded',
    'withheld',
    'punished',
    'expired',
  ])('accepts known status %s', (s) => {
    expect(swapStatusSchema.parse(s)).toBe(s);
  });

  it('maps unknown status to unknown-prefixed (forward-compat)', () => {
    expect(swapStatusSchema.parse('some_new_status')).toBe('unknown:some_new_status');
  });
});

describe('swapVerificationSchema (discriminated union on provider)', () => {
  it('narrows to chainflip variant', () => {
    const parsed = swapVerificationSchema.parse({
      provider: 'chainflip',
      channel_id: 'ch-1',
      status_url: 'https://x',
      explorer_url: null,
    });
    if (parsed.provider === 'chainflip') expect(parsed.channel_id).toBe('ch-1');
  });

  it('narrows to atomicswap variant', () => {
    const parsed = swapVerificationSchema.parse({
      provider: 'atomicswap',
      lock_address: 'bc1q...',
      deposit_type: 'P2WSH',
      timelock_blocks: 144,
      timelock_hours: 24,
      refund_address: 'bc1q-refund',
      explorer_url: null,
    });
    if (parsed.provider === 'atomicswap') expect(parsed.timelock_blocks).toBe(144);
  });

  it('rejects unknown provider', () => {
    expect(() =>
      swapVerificationSchema.parse({ provider: 'future', status_url: 'x' }),
    ).toThrow();
  });
});

describe('createSwapBodySchema', () => {
  it('parses a minimal body (slippageBps optional, server applies default)', () => {
    const parsed = createSwapBodySchema.parse({
      from: 'BTC',
      to: 'ETH',
      amount: '0.1',
      destAddress: '0xabc',
      refundAddress: 'bc1qabc',
    });
    expect(parsed.slippageBps).toBeUndefined();
  });

  it('rejects empty amount', () => {
    expect(() =>
      createSwapBodySchema.parse({ from: 'BTC', to: 'ETH', amount: '', destAddress: '0xabc' }),
    ).toThrow();
  });
});

describe('createSwapResponseSchema', () => {
  it('parses a minimal response', () => {
    const parsed = createSwapResponseSchema.parse({
      swapNumber: 'MIRA-ABCD1234',
      status: 'pending',
      provider: 'thorchain',
      depositAddress: 'bc1q...',
      fromToken: 'BTC',
      toToken: 'ETH',
      amountIn: '0.1',
      amountInUsd: null,
      expectedAmountOut: '1.67',
      expectedAmountOutUsd: null,
      priceImpactPct: null,
      expiresAt: null,
      requiresFunding: true,
      fundingDeadlineSecs: 3600,
      protocolData: null,
      verification: null,
    });
    expect(parsed.swapNumber).toBe('MIRA-ABCD1234');
  });

  it('rejects malformed swapNumber', () => {
    expect(() =>
      createSwapResponseSchema.parse({
        swapNumber: 'NOT-A-SWAP',
        status: 'pending',
        provider: 'thorchain',
        depositAddress: null,
        fromToken: 'BTC',
        toToken: 'ETH',
        amountIn: '0.1',
        amountInUsd: null,
        expectedAmountOut: null,
        expectedAmountOutUsd: null,
        priceImpactPct: null,
        expiresAt: null,
        requiresFunding: false,
        fundingDeadlineSecs: null,
        protocolData: null,
        verification: null,
      }),
    ).toThrow();
  });
});

describe('swapDetailSchema', () => {
  it('parses a detail envelope with optional fields omitted', () => {
    const parsed = swapDetailSchema.parse({
      swapNumber: 'MIRA-XXXXYYYY',
      status: 'completed',
      provider: 'thorchain',
      fromToken: 'BTC',
      fromChain: 'bitcoin',
      toToken: 'ETH',
      toChain: 'ethereum',
      amountIn: '0.1',
      amountInUsd: null,
      expectedAmountOut: null,
      expectedAmountOutUsd: null,
      actualAmountOut: '1.68',
      actualAmountOutUsd: null,
      priceImpactPct: null,
      depositAddress: null,
      fundingAddress: null,
      destAddress: '0xabc',
      refundAddress: null,
      depositTxHash: null,
      outputTxHash: null,
      refundTxHash: null,
      expiresAt: null,
      createdAt: '2026-04-18T10:00:00.000Z',
      updatedAt: '2026-04-18T11:00:00.000Z',
      completedAt: '2026-04-18T11:00:00.000Z',
      durationSeconds: 3600,
      requiresFunding: false,
      verification: null,
      protocolData: null,
    });
    expect(parsed.actualAmountOut).toBe('1.68');
  });
});

describe('recentSwapSchema', () => {
  it('parses a recent swap', () => {
    const parsed = recentSwapSchema.parse({
      swapNumber: 'MIRA-RECENT01',
      fromToken: 'BTC',
      toToken: 'ETH',
      provider: 'chainflip',
      status: 'completed',
      amountIn: '0.1',
      amountInUsd: null,
      expectedAmountOut: '1.5',
      expectedAmountOutUsd: null,
      createdAt: '2026-04-18T10:00:00.000Z',
      completedAt: '2026-04-18T11:00:00.000Z',
      durationSeconds: 3600,
    });
    expect(parsed.durationSeconds).toBe(3600);
  });
});

describe('requiredActionSchema', () => {
  it('accepts extended server types (sign_swap, none)', () => {
    const parsed = requiredActionSchema.parse({
      type: 'sign_swap',
      urgency: 'medium',
      message: 'sign',
    });
    expect(parsed.type).toBe('sign_swap');
  });
});

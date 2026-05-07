import { describe, it, expect } from 'vitest';
import {
  swapActionBodySchema,
  swapActionResponseSchema,
} from '../../../../src/wire/server/action.zod.js';

describe('swapActionBodySchema (discriminated union on type)', () => {
  const preSigs = {
    tx_cancel_sig: 'aa',
    tx_punish_sig: 'bb',
    tx_early_refund_sig: 'cc',
  };

  it('parses presigs variant', () => {
    const parsed = swapActionBodySchema.parse({
      type: 'presigs',
      unsignedPsbt: 'psbt-base64',
      preSigs,
    });
    if (parsed.type === 'presigs') expect(parsed.preSigs.tx_cancel_sig).toBe('aa');
  });

  it('parses fund variant', () => {
    const parsed = swapActionBodySchema.parse({
      type: 'fund',
      signedPsbt: 'signed-psbt',
    });
    if (parsed.type === 'fund') expect(parsed.signedPsbt).toBe('signed-psbt');
  });

  it('parses cancel variant with optional reason', () => {
    const parsed = swapActionBodySchema.parse({ type: 'cancel', reason: 'user abort' });
    if (parsed.type === 'cancel') expect(parsed.reason).toBe('user abort');
  });

  // V-4: the legacy `refund` body shipped Bob's private XMR scalar (and
  // optionally his Bitcoin secret) through the wire. The current refund flow
  // is fully client-side, so the variant is removed; `swapActionBodySchema`
  // must reject any attempt to construct it.
  it('rejects the legacy refund body that leaked private keys', () => {
    expect(() =>
      swapActionBodySchema.parse({
        type: 'refund',
        s_b: 's_b-hex',
        b: 'b-hex',
      }),
    ).toThrow();
  });

  it('parses notify-refund with 64-char txid', () => {
    const txid = 'a'.repeat(64);
    const parsed = swapActionBodySchema.parse({ type: 'notify-refund', refund_txid: txid });
    if (parsed.type === 'notify-refund') expect(parsed.refund_txid).toHaveLength(64);
  });

  it('rejects notify-refund with bad-length txid', () => {
    expect(() =>
      swapActionBodySchema.parse({ type: 'notify-refund', refund_txid: 'short' }),
    ).toThrow();
  });

  it('parses new server variants: commit_intents and sign_swap', () => {
    const ci = swapActionBodySchema.parse({
      type: 'commit_intents',
      signedWithdrawIntent: {},
      signedRefundIntent: {},
    });
    expect(ci.type).toBe('commit_intents');

    const ss = swapActionBodySchema.parse({
      type: 'sign_swap',
      signedSwapIntent: {},
    });
    expect(ss.type).toBe('sign_swap');
  });

  it('rejects an unknown action type (strict discriminated union)', () => {
    expect(() => swapActionBodySchema.parse({ type: 'mystery-action' })).toThrow();
  });
});

describe('swapActionResponseSchema', () => {
  it('parses a fund-action response', () => {
    const parsed = swapActionResponseSchema.parse({
      swapNumber: 'MIRA-ACTFND01',
      status: 'deposited',
      message: 'funded',
      protocolData: {
        txid: 'lock-tx',
        confirmations_required: 2,
        estimated_time_minutes: 20,
      },
    });
    expect(parsed.message).toBe('funded');
  });

  it('parses a response with null protocolData', () => {
    const parsed = swapActionResponseSchema.parse({
      swapNumber: 'MIRA-NPROTO01',
      status: 'cancelling',
      message: 'cancel requested',
      protocolData: null,
    });
    expect(parsed.protocolData).toBeNull();
  });
});

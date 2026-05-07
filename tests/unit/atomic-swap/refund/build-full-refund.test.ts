import { describe, it, expect } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { buildFullRefund } from '../../../../src/atomic-swap/refund.js';
import { buildFakeTxCancelHex } from './helpers.js';

const A = '025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc';
const B = '03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb';
const REFUND_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

describe('buildFullRefund', () => {
  it('produces a version-2 tx with locktime=0 and SEQUENCE_FINAL on the input', () => {
    const txCancelHex = buildFakeTxCancelHex({
      aPubHex: A,
      bPubHex: B,
      cancelOutputValueSats: 100_000n,
      network: 'testnet',
    });
    const { txRefundHex } = buildFullRefund({
      txCancelHex,
      refundAddress: REFUND_ADDR,
      refundFeeSats: 1_500n,
      network: 'testnet',
    });
    const tx = bitcoin.Transaction.fromHex(txRefundHex);
    expect(tx.version).toBe(2);
    expect(tx.locktime).toBe(0);
    expect(tx.ins).toHaveLength(1);
    expect(tx.ins[0]?.sequence).toBe(0xffffffff);
    expect(tx.outs).toHaveLength(1);
  });

  it('sets the single output value to cancel_value - refund_fee', () => {
    const txCancelHex = buildFakeTxCancelHex({
      aPubHex: A,
      bPubHex: B,
      cancelOutputValueSats: 100_000n,
      network: 'testnet',
    });
    const { refundOutputValueSats, cancelOutputValueSats } = buildFullRefund({
      txCancelHex,
      refundAddress: REFUND_ADDR,
      refundFeeSats: 1_500n,
      network: 'testnet',
    });
    expect(cancelOutputValueSats).toBe(100_000n);
    expect(refundOutputValueSats).toBe(98_500n);
  });

  it('uses the little-endian reversal of txCancel.getId() for input.hash', () => {
    const txCancelHex = buildFakeTxCancelHex({
      aPubHex: A,
      bPubHex: B,
      cancelOutputValueSats: 100_000n,
      network: 'testnet',
    });
    const txCancel = bitcoin.Transaction.fromHex(txCancelHex);
    const expectedHashLE = Buffer.from(Buffer.from(txCancel.getId(), 'hex')).reverse();
    const { txRefundHex } = buildFullRefund({
      txCancelHex,
      refundAddress: REFUND_ADDR,
      refundFeeSats: 1_500n,
      network: 'testnet',
    });
    const tx = bitcoin.Transaction.fromHex(txRefundHex);
    const actualHash = tx.ins[0]?.hash;
    expect(actualHash).toBeDefined();
    expect(Buffer.from(actualHash!).equals(expectedHashLE)).toBe(true);
  });

  it('rejects refund output below P2WPKH dust floor', () => {
    const txCancelHex = buildFakeTxCancelHex({
      aPubHex: A,
      bPubHex: B,
      cancelOutputValueSats: 1_000n,
      network: 'testnet',
    });
    expect(() =>
      buildFullRefund({
        txCancelHex,
        refundAddress: REFUND_ADDR,
        refundFeeSats: 900n, // → 100 sat output, below 294 dust floor
        network: 'testnet',
      }),
    ).toThrow(/below P2WPKH dust floor/);
  });

  it('throws on malformed TxCancel (no output)', () => {
    const empty = new bitcoin.Transaction();
    empty.version = 2;
    expect(() =>
      buildFullRefund({
        txCancelHex: empty.toHex(),
        refundAddress: REFUND_ADDR,
        refundFeeSats: 1_500n,
        network: 'testnet',
      }),
    ).toThrow(/TxCancel has no output/);
  });
});

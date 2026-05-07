import { describe, it, expect } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { buildPartialRefund } from '../../../../src/atomic-swap/refund.js';
import { buildMultisigWitnessScript } from '../../../../src/atomic-swap/presign.js';
import { buildFakeTxCancelHex } from './helpers.js';

const A = '025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc';
const B = '03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb';
const REFUND_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

describe('buildPartialRefund', () => {
  it('produces a two-output tx: refund + amnesty P2WSH', () => {
    const txCancelHex = buildFakeTxCancelHex({
      aPubHex: A,
      bPubHex: B,
      cancelOutputValueSats: 100_000n,
      network: 'testnet',
    });
    const { txRefundHex, refundOutputValueSats, amnestyOutputValueSats } = buildPartialRefund({
      txCancelHex,
      refundAddress: REFUND_ADDR,
      refundFeeSats: 0n, // unused; partial uses partialRefundFeeSats
      network: 'testnet',
      amnestyAmountSats: 10_000n,
      partialRefundFeeSats: 1_500n,
      aPubHex: A,
      bPubHex: B,
    });
    const tx = bitcoin.Transaction.fromHex(txRefundHex);
    expect(tx.outs).toHaveLength(2);
    expect(refundOutputValueSats).toBe(88_500n);
    expect(amnestyOutputValueSats).toBe(10_000n);
    expect(BigInt(tx.outs[0]!.value)).toBe(88_500n);
    expect(BigInt(tx.outs[1]!.value)).toBe(10_000n);
  });

  it('amnesty output spends to a P2WSH of the (A, B) witness script', () => {
    const txCancelHex = buildFakeTxCancelHex({
      aPubHex: A,
      bPubHex: B,
      cancelOutputValueSats: 100_000n,
      network: 'testnet',
    });
    const { txRefundHex } = buildPartialRefund({
      txCancelHex,
      refundAddress: REFUND_ADDR,
      refundFeeSats: 0n,
      network: 'testnet',
      amnestyAmountSats: 10_000n,
      partialRefundFeeSats: 1_500n,
      aPubHex: A,
      bPubHex: B,
    });
    const tx = bitcoin.Transaction.fromHex(txRefundHex);
    const witnessScript = buildMultisigWitnessScript(A, B);
    const expected = bitcoin.payments.p2wsh({
      redeem: { output: witnessScript },
      network: bitcoin.networks.testnet,
    });
    expect(expected.output).toBeDefined();
    expect(Buffer.from(tx.outs[1]!.script).equals(expected.output!)).toBe(true);
  });

  it('rejects amnesty below P2WSH dust floor', () => {
    const txCancelHex = buildFakeTxCancelHex({
      aPubHex: A,
      bPubHex: B,
      cancelOutputValueSats: 100_000n,
      network: 'testnet',
    });
    expect(() =>
      buildPartialRefund({
        txCancelHex,
        refundAddress: REFUND_ADDR,
        refundFeeSats: 0n,
        network: 'testnet',
        amnestyAmountSats: 100n, // below P2WSH dust floor
        partialRefundFeeSats: 1_500n,
        aPubHex: A,
        bPubHex: B,
      }),
    ).toThrow(/amnesty output .* below P2WSH dust/);
  });

  it('rejects refund output below P2WPKH dust floor after amnesty deduction', () => {
    const txCancelHex = buildFakeTxCancelHex({
      aPubHex: A,
      bPubHex: B,
      cancelOutputValueSats: 11_000n,
      network: 'testnet',
    });
    expect(() =>
      buildPartialRefund({
        txCancelHex,
        refundAddress: REFUND_ADDR,
        refundFeeSats: 0n,
        network: 'testnet',
        amnestyAmountSats: 10_000n,
        partialRefundFeeSats: 900n, // → 100 sat refund output, dust
        aPubHex: A,
        bPubHex: B,
      }),
    ).toThrow(/partial refund output .* below P2WPKH/);
  });
});

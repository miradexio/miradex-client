/**
 * Shared test helpers for the refund unit tests.
 *
 * Builds a plausible TxCancel (the input for TxRefund): a segwit v2 tx that
 * spends a synthetic P2WSH outpoint and produces a single 2-of-2 P2WSH
 * output whose redeem script is `<A> OP_CHECKSIGVERIFY <B> OP_CHECKSIG`.
 * The cancel-output value is parameterised so refund-side dust/refund-fee
 * tests can exercise boundary conditions without a real regtest setup.
 */
import * as bitcoin from 'bitcoinjs-lib';
import { buildMultisigWitnessScript } from '../../../../src/atomic-swap/presign.js';

const SEQUENCE_FINAL = 0xffffffff;

export interface BuildFakeTxCancelParams {
  readonly aPubHex: string;
  readonly bPubHex: string;
  readonly cancelOutputValueSats: bigint;
  readonly network: 'mainnet' | 'testnet';
}

/**
 * Produce a syntactically-valid TxCancel hex for testing the refund pipeline.
 * The input is a deterministic dummy outpoint (txid = 32 random-but-fixed bytes,
 * vout = 0); the output is a real P2WSH of the 2-of-2 witness script.
 */
export function buildFakeTxCancelHex(params: BuildFakeTxCancelParams): string {
  const net =
    params.network === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const witnessScript = buildMultisigWitnessScript(params.aPubHex, params.bPubHex);
  const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: witnessScript }, network: net });
  if (!p2wsh.output) throw new Error('p2wsh derive failed in test helper');

  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = 0;
  const dummyPrevTxidLE = Buffer.alloc(32, 0xab); // arbitrary 32-byte txid
  tx.addInput(dummyPrevTxidLE, 0, SEQUENCE_FINAL);
  tx.addOutput(Buffer.from(p2wsh.output), params.cancelOutputValueSats);
  return tx.toHex();
}

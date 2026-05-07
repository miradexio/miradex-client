// Build TxCancel / TxPunish / TxEarlyRefund / TxRedeem locally, compute BIP143
// sighashes, sign with b. Server never sees b.
//
// Lock witness script (matches Rust miniscript c:and_v(v:pk(A),pk_k(B))):
//   <A> OP_CHECKSIGVERIFY <B> OP_CHECKSIG

import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import type { ProtocolParams, PreSigs, FeePolicy, AmnestyPolicy, DustPolicy } from '../types/index.js';
import {
  VerificationError,
  DEFAULT_FEE_POLICY,
  DEFAULT_AMNESTY_POLICY,
  DEFAULT_DUST_POLICY,
} from '../types/index.js';
import {
  ATOMICSWAP_TIMELOCK_MIN_BLOCKS,
  ATOMICSWAP_TIMELOCK_MAX_BLOCKS,
  ATOMICSWAP_PUNISH_TIMELOCK_MIN_BLOCKS,
  ATOMICSWAP_PUNISH_TIMELOCK_MAX_BLOCKS,
  ATOMICSWAP_REMAINING_REFUND_TIMELOCK_MIN_BLOCKS,
  ATOMICSWAP_REMAINING_REFUND_TIMELOCK_MAX_BLOCKS,
} from '../verification/constants.js';

const ECPair = ECPairFactory(ecc);

export type NetworkName = 'mainnet' | 'testnet' | 'regtest' | 'regtest';

const SEQUENCE_FINAL = 0xffffffff;

/** Typical vbyte cost of a single P2WSH spend with one output. */
const VBYTES_SINGLE_IN_SINGLE_OUT = 154n;

/** Typical vbyte cost of a single P2WSH spend with two outputs (partial refund). */
const VBYTES_SINGLE_IN_TWO_OUT = 187n;

export interface ComputePreSigsParams {
  readonly bHex: string;
  readonly signedPsbtBase64: string;
  readonly protocolParams: ProtocolParams;
  readonly refundAddress: string;
  readonly network: NetworkName;
  readonly amnestyPolicy?: AmnestyPolicy;
  readonly feePolicy?: FeePolicy;
  readonly dustPolicy?: DustPolicy;
}

export interface ComputeRedeemDigestParams {
  readonly signedPsbtBase64: string;
  readonly protocolParams: ProtocolParams;
  readonly bPubHex: string;
  readonly network: NetworkName;
  readonly feePolicy?: FeePolicy;
  readonly dustPolicy?: DustPolicy;
}

// V-1: reject out-of-range BIP68 sequences. Pre-sigs bake the sequence into
// the digest, so e.g. punish_timelock = 0 silently arms Alice for an instant
// punish race after TxCancel confirms.
function requireTimelockInBounds(params: {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly fieldName: string;
}): void {
  if (!Number.isInteger(params.value) || params.value < params.min || params.value > params.max) {
    throw new VerificationError(
      'E_TIMELOCK_OUT_OF_RANGE',
      `${params.fieldName} ${String(params.value)} is outside the accepted range ` +
        `[${String(params.min)}, ${String(params.max)}]`,
    );
  }
}

function requireFeeInBounds(params: {
  readonly feeSats: bigint;
  readonly weightVbytes: bigint;
  readonly policy: FeePolicy;
  readonly txName: string;
}): void {
  const minFee = params.policy.minRelaySatsPerVbyte * params.weightVbytes;
  const maxFee = params.policy.maxSatsPerVbyte * params.weightVbytes;
  if (params.feeSats < minFee) {
    throw new VerificationError(
      'E_FEE_BELOW_RELAY',
      `${params.txName} fee ${params.feeSats.toString()} below min ${minFee.toString()}`,
    );
  }
  if (params.feeSats > maxFee) {
    throw new VerificationError(
      'E_FEE_ABOVE_CAP',
      `${params.txName} fee ${params.feeSats.toString()} above max ${maxFee.toString()}`,
    );
  }
}

function requireAboveDust(params: {
  readonly outputSats: bigint;
  readonly floor: bigint;
  readonly txName: string;
}): void {
  if (params.outputSats < params.floor) {
    throw new VerificationError(
      'E_OUTPUT_DUST',
      `${params.txName} output ${params.outputSats.toString()} below dust floor ${params.floor.toString()}`,
    );
  }
}

function resolveNetwork(network: NetworkName): bitcoin.Network {
  switch (network) {
    case 'mainnet':
      return bitcoin.networks.bitcoin;
    case 'testnet':
      return bitcoin.networks.testnet;
    case 'regtest':
      return bitcoin.networks.regtest;
  }
}

// AV-B.1 / AV-C.1: derive the 2-of-2 P2WSH lock address from (A, B) and
// compare to whatever the sidecar claims before signing. aHex / bHex are
// 33B compressed secp256k1 hex; network selects the bech32 HRP. Throws
// E_LOCK_SCRIPT if p2wsh derivation fails.
export function deriveLockAddress(params: {
  readonly aHex: string;
  readonly bHex: string;
  readonly network: NetworkName;
}): string {
  const net = resolveNetwork(params.network);
  const witnessScript = buildMultisigWitnessScript(params.aHex, params.bHex);
  const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: witnessScript }, network: net });
  if (!p2wsh.address) {
    throw new VerificationError('E_LOCK_SCRIPT', 'failed to derive P2WSH lock address');
  }
  return p2wsh.address;
}

// 2-of-2 witness: <A> OP_CHECKSIGVERIFY <B> OP_CHECKSIG.
// A and B are 33B compressed secp256k1 hex.
export function buildMultisigWitnessScript(aHex: string, bHex: string): Buffer {
  const keyA = Buffer.from(aHex, 'hex');
  const keyB = Buffer.from(bHex, 'hex');

  if (keyA.length !== 33 || keyB.length !== 33) {
    throw new Error(`Public keys must be 33 bytes compressed. Got A=${String(keyA.length)}, B=${String(keyB.length)}`);
  }

  return Buffer.from(bitcoin.script.compile([
    keyA,
    bitcoin.opcodes.OP_CHECKSIGVERIFY,
    keyB,
    bitcoin.opcodes.OP_CHECKSIG,
  ]));
}

function findMultisigOutput(
  tx: bitcoin.Transaction,
  witnessScript: Buffer,
  network: bitcoin.Network,
): { readonly vout: number; readonly valueSats: number } {
  const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: witnessScript }, network });
  if (!p2wsh.output) throw new Error('Failed to derive P2WSH output script');

  const p2wshOutput = Buffer.from(p2wsh.output);
  for (let i = 0; i < tx.outs.length; i++) {
    const out = tx.outs[i];
    if (out && p2wshOutput.equals(Buffer.from(out.script))) {
      return { vout: i, valueSats: Number(out.value) };
    }
  }

  throw new Error('No output matching the 2-of-2 multisig descriptor found in transaction');
}

// Mirrors the Rust build_spend_transaction pattern.
function buildSpendTx(options: {
  readonly inputTxId: Buffer;
  readonly inputVout: number;
  readonly inputSequence: number;
  readonly outputAddress: string;
  readonly outputValueSats: number;
  readonly network: bitcoin.Network;
}): bitcoin.Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = 0;
  tx.addInput(options.inputTxId, options.inputVout, options.inputSequence);
  const outputScript = bitcoin.address.toOutputScript(options.outputAddress, options.network);
  tx.addOutput(outputScript, BigInt(options.outputValueSats));
  return tx;
}

function computeWitnessSighash(
  tx: bitcoin.Transaction,
  inputIndex: number,
  witnessScript: Buffer,
  valueSats: number,
): Buffer {
  return Buffer.from(tx.hashForWitnessV0(
    inputIndex,
    witnessScript,
    BigInt(valueSats),
    bitcoin.Transaction.SIGHASH_ALL,
  ));
}

// Standard ECDSA pre-sigs on TxCancel, TxPunish, TxEarlyRefund (sidecar
// forwards them to Alice in Message4). TxRedeem encsig is computed separately
// because it needs WASM adaptor crypto. Returns 64B compact sigs as hex.
export function computePreSigs(params: ComputePreSigsParams): PreSigs {
  const { bHex, signedPsbtBase64, protocolParams, refundAddress, network } = params;
  const feePolicy = params.feePolicy ?? DEFAULT_FEE_POLICY;
  const dustPolicy = params.dustPolicy ?? DEFAULT_DUST_POLICY;
  const amnestyPolicy = params.amnestyPolicy ?? DEFAULT_AMNESTY_POLICY;

  // V-1: bound every BIP68 sequence before we sign a digest that embeds it.
  // verification.ts bounds cancel_timelock at deposit-verification time, but
  // punish + reclaim are first checked here.
  requireTimelockInBounds({
    value: protocolParams.cancel_timelock,
    min: ATOMICSWAP_TIMELOCK_MIN_BLOCKS,
    max: ATOMICSWAP_TIMELOCK_MAX_BLOCKS,
    fieldName: 'cancel_timelock',
  });
  requireTimelockInBounds({
    value: protocolParams.punish_timelock,
    min: ATOMICSWAP_PUNISH_TIMELOCK_MIN_BLOCKS,
    max: ATOMICSWAP_PUNISH_TIMELOCK_MAX_BLOCKS,
    fieldName: 'punish_timelock',
  });
  if (
    protocolParams.remaining_refund_timelock !== undefined &&
    protocolParams.remaining_refund_timelock !== null
  ) {
    requireTimelockInBounds({
      value: protocolParams.remaining_refund_timelock,
      min: ATOMICSWAP_REMAINING_REFUND_TIMELOCK_MIN_BLOCKS,
      max: ATOMICSWAP_REMAINING_REFUND_TIMELOCK_MAX_BLOCKS,
      fieldName: 'remaining_refund_timelock',
    });
  }

  const net = resolveNetwork(network);
  const keyPair = ECPair.fromPrivateKey(Buffer.from(bHex, 'hex'), { network: net });
  const bPubHex = Buffer.from(keyPair.publicKey).toString('hex');

  const psbt = bitcoin.Psbt.fromBase64(signedPsbtBase64, { network: net });
  // buildAndSignFundingPsbt may have finalised already; bitcoinjs-lib throws if so.
  try { psbt.finalizeAllInputs(); } catch { /* already finalised */ }
  const txLock = psbt.extractTransaction();
  const txLockHash = txLock.getHash();

  const lockWitnessScript = buildMultisigWitnessScript(protocolParams.A, bPubHex);
  const { vout: lockVout, valueSats: lockValueSats } = findMultisigOutput(txLock, lockWitnessScript, net);
  const lockValueSatsBn = BigInt(lockValueSats);

  // AV-A.12: cap amnesty at a fraction of lock before any tx relies on it.
  const amnestyAmount = BigInt(protocolParams.amnesty_amount_sats ?? 0);
  if (amnestyAmount < 0n) {
    throw new VerificationError('E_AMNESTY_NEGATIVE', 'amnesty amount is negative');
  }
  if (amnestyAmount * 10_000n > lockValueSatsBn * BigInt(amnestyPolicy.maxRatioBps)) {
    throw new VerificationError(
      'E_AMNESTY_EXCEEDS_CAP',
      `amnesty ${amnestyAmount.toString()} exceeds ${(amnestyPolicy.maxRatioBps / 100).toFixed(2)}% of lock ${lockValueSatsBn.toString()}`,
    );
  }

  const cancelWitnessScript = buildMultisigWitnessScript(protocolParams.A, bPubHex);
  const cancelP2wsh = bitcoin.payments.p2wsh({ redeem: { output: cancelWitnessScript }, network: net });
  if (!cancelP2wsh.output) throw new Error('Failed to derive cancel P2WSH');

  requireFeeInBounds({
    feeSats: BigInt(protocolParams.tx_cancel_fee_sats),
    weightVbytes: VBYTES_SINGLE_IN_SINGLE_OUT,
    policy: feePolicy,
    txName: 'TxCancel',
  });
  const cancelOutputSats = BigInt(lockValueSats) - BigInt(protocolParams.tx_cancel_fee_sats);
  requireAboveDust({
    outputSats: cancelOutputSats,
    floor: dustPolicy.p2wshDustSats,
    txName: 'TxCancel',
  });
  const txCancel = new bitcoin.Transaction();
  txCancel.version = 2;
  txCancel.locktime = 0;
  txCancel.addInput(Buffer.from(txLockHash), lockVout, protocolParams.cancel_timelock);
  txCancel.addOutput(Buffer.from(cancelP2wsh.output), cancelOutputSats);

  const cancelDigest = computeWitnessSighash(txCancel, 0, lockWitnessScript, lockValueSats);
  const cancelSig = keyPair.sign(cancelDigest);

  requireFeeInBounds({
    feeSats: BigInt(protocolParams.tx_punish_fee_sats),
    weightVbytes: VBYTES_SINGLE_IN_SINGLE_OUT,
    policy: feePolicy,
    txName: 'TxPunish',
  });
  const punishOutputSats = cancelOutputSats - BigInt(protocolParams.tx_punish_fee_sats);
  requireAboveDust({
    outputSats: punishOutputSats,
    floor: dustPolicy.p2wpkhDustSats,
    txName: 'TxPunish',
  });
  const txPunish = buildSpendTx({
    inputTxId: Buffer.from(txCancel.getHash()),
    inputVout: 0,
    inputSequence: protocolParams.punish_timelock,
    outputAddress: protocolParams.punish_address,
    outputValueSats: Number(punishOutputSats),
    network: net,
  });

  const punishDigest = computeWitnessSighash(txPunish, 0, cancelWitnessScript, Number(cancelOutputSats));
  const punishSig = keyPair.sign(punishDigest);

  requireFeeInBounds({
    feeSats: BigInt(protocolParams.tx_refund_fee_sats),
    weightVbytes: VBYTES_SINGLE_IN_SINGLE_OUT,
    policy: feePolicy,
    txName: 'TxEarlyRefund',
  });
  const earlyRefundOutputSats = BigInt(lockValueSats) - BigInt(protocolParams.tx_refund_fee_sats);
  requireAboveDust({
    outputSats: earlyRefundOutputSats,
    floor: dustPolicy.p2wpkhDustSats,
    txName: 'TxEarlyRefund',
  });
  const txEarlyRefund = buildSpendTx({
    inputTxId: Buffer.from(txLockHash),
    inputVout: lockVout,
    inputSequence: SEQUENCE_FINAL,
    outputAddress: refundAddress,
    outputValueSats: Number(earlyRefundOutputSats),
    network: net,
  });

  const earlyRefundDigest = computeWitnessSighash(txEarlyRefund, 0, lockWitnessScript, lockValueSats);
  const earlyRefundSig = keyPair.sign(earlyRefundDigest);

  let tx_reclaim_sig: string | undefined;
  let tx_withhold_sig: string | undefined;
  let tx_mercy_sig: string | undefined;

  if (
    amnestyAmount > 0n &&
    protocolParams.tx_partial_refund_fee_sats &&
    protocolParams.tx_reclaim_fee_sats &&
    protocolParams.tx_withhold_fee_sats &&
    protocolParams.tx_mercy_fee_sats &&
    protocolParams.remaining_refund_timelock
  ) {
    const amnestyWitnessScript = buildMultisigWitnessScript(protocolParams.A, bPubHex);
    const amnestyP2wsh = bitcoin.payments.p2wsh({ redeem: { output: amnestyWitnessScript }, network: net });
    if (!amnestyP2wsh.output) throw new Error('Failed to derive amnesty P2WSH');

    requireFeeInBounds({
      feeSats: BigInt(protocolParams.tx_partial_refund_fee_sats),
      weightVbytes: VBYTES_SINGLE_IN_TWO_OUT,
      policy: feePolicy,
      txName: 'TxPartialRefund',
    });
    const partialRefundOutputSats =
      cancelOutputSats - amnestyAmount - BigInt(protocolParams.tx_partial_refund_fee_sats);
    requireAboveDust({
      outputSats: partialRefundOutputSats,
      floor: dustPolicy.p2wpkhDustSats,
      txName: 'TxPartialRefund',
    });
    requireAboveDust({
      outputSats: amnestyAmount,
      floor: dustPolicy.p2wshDustSats,
      txName: 'TxPartialRefund amnesty',
    });
    const txPartialRefund = new bitcoin.Transaction();
    txPartialRefund.version = 2;
    txPartialRefund.locktime = 0;
    txPartialRefund.addInput(Buffer.from(txCancel.getHash()), 0, SEQUENCE_FINAL);
    txPartialRefund.addOutput(bitcoin.address.toOutputScript(refundAddress, net), partialRefundOutputSats);
    txPartialRefund.addOutput(Buffer.from(amnestyP2wsh.output), amnestyAmount);

    requireFeeInBounds({
      feeSats: BigInt(protocolParams.tx_reclaim_fee_sats),
      weightVbytes: VBYTES_SINGLE_IN_SINGLE_OUT,
      policy: feePolicy,
      txName: 'TxReclaim',
    });
    const reclaimOutputSats = amnestyAmount - BigInt(protocolParams.tx_reclaim_fee_sats);
    requireAboveDust({
      outputSats: reclaimOutputSats,
      floor: dustPolicy.p2wpkhDustSats,
      txName: 'TxReclaim',
    });
    const txReclaim = buildSpendTx({
      inputTxId: Buffer.from(txPartialRefund.getHash()),
      inputVout: 1,
      inputSequence: protocolParams.remaining_refund_timelock,
      outputAddress: refundAddress,
      outputValueSats: Number(reclaimOutputSats),
      network: net,
    });
    const reclaimDigest = computeWitnessSighash(txReclaim, 0, amnestyWitnessScript, Number(amnestyAmount));
    tx_reclaim_sig = Buffer.from(keyPair.sign(reclaimDigest)).toString('hex');

    requireFeeInBounds({
      feeSats: BigInt(protocolParams.tx_withhold_fee_sats),
      weightVbytes: VBYTES_SINGLE_IN_SINGLE_OUT,
      policy: feePolicy,
      txName: 'TxWithhold',
    });
    const withholdOutputSats = amnestyAmount - BigInt(protocolParams.tx_withhold_fee_sats);
    requireAboveDust({
      outputSats: withholdOutputSats,
      floor: dustPolicy.p2wshDustSats,
      txName: 'TxWithhold',
    });
    const txWithhold = new bitcoin.Transaction();
    txWithhold.version = 2;
    txWithhold.locktime = 0;
    txWithhold.addInput(Buffer.from(txPartialRefund.getHash()), 1, SEQUENCE_FINAL);
    txWithhold.addOutput(Buffer.from(amnestyP2wsh.output), withholdOutputSats);
    const withholdDigest = computeWitnessSighash(txWithhold, 0, amnestyWitnessScript, Number(amnestyAmount));
    tx_withhold_sig = Buffer.from(keyPair.sign(withholdDigest)).toString('hex');

    requireFeeInBounds({
      feeSats: BigInt(protocolParams.tx_mercy_fee_sats),
      weightVbytes: VBYTES_SINGLE_IN_SINGLE_OUT,
      policy: feePolicy,
      txName: 'TxMercy',
    });
    const mercyOutputSats = withholdOutputSats - BigInt(protocolParams.tx_mercy_fee_sats);
    requireAboveDust({
      outputSats: mercyOutputSats,
      floor: dustPolicy.p2wpkhDustSats,
      txName: 'TxMercy',
    });
    const txMercy = buildSpendTx({
      inputTxId: Buffer.from(txWithhold.getHash()),
      inputVout: 0,
      inputSequence: SEQUENCE_FINAL,
      outputAddress: refundAddress,
      outputValueSats: Number(mercyOutputSats),
      network: net,
    });
    const mercyDigest = computeWitnessSighash(txMercy, 0, amnestyWitnessScript, Number(withholdOutputSats));
    tx_mercy_sig = Buffer.from(keyPair.sign(mercyDigest)).toString('hex');
  }

  return {
    tx_cancel_sig: Buffer.from(cancelSig).toString('hex'),
    tx_punish_sig: Buffer.from(punishSig).toString('hex'),
    tx_early_refund_sig: Buffer.from(earlyRefundSig).toString('hex'),
    tx_reclaim_sig,
    tx_withhold_sig,
    tx_mercy_sig,
  };
}

// TxRedeem BIP143 sighash. The driver feeds it to encsign_digest(b,
// S_a_bitcoin, digest) to produce Alice's adaptor signature. 32B hex.
export function computeRedeemDigest(params: ComputeRedeemDigestParams): string {
  const net = resolveNetwork(params.network);
  const psbt = bitcoin.Psbt.fromBase64(params.signedPsbtBase64, { network: net });
  try { psbt.finalizeAllInputs(); } catch { /* already finalised */ }
  const txLock = psbt.extractTransaction();
  return computeRedeemDigestFromTxLock({
    txLock,
    protocolParams: params.protocolParams,
    bPubHex: params.bPubHex,
    network: params.network,
    feePolicy: params.feePolicy,
    dustPolicy: params.dustPolicy,
  });
}

export interface ComputeRedeemDigestFromTxHexParams {
  readonly lockTxRawHex: string;
  readonly protocolParams: ProtocolParams;
  readonly bPubHex: string;
  readonly network: NetworkName;
  readonly feePolicy?: FeePolicy;
  readonly dustPolicy?: DustPolicy;
}

// AV-B.2 (resume path): recompute the TxRedeem digest from raw on-chain
// TxLock hex when signedPsbtBase64 is no longer in memory. Byte-identical to
// computeRedeemDigest for the same tx; caller CT-compares against the
// sidecar's claim.
export function computeRedeemDigestFromTxHex(
  params: ComputeRedeemDigestFromTxHexParams,
): string {
  const txLock = bitcoin.Transaction.fromHex(params.lockTxRawHex);
  return computeRedeemDigestFromTxLock({
    txLock,
    protocolParams: params.protocolParams,
    bPubHex: params.bPubHex,
    network: params.network,
    feePolicy: params.feePolicy,
    dustPolicy: params.dustPolicy,
  });
}

interface ComputeRedeemDigestFromTxLockParams {
  readonly txLock: bitcoin.Transaction;
  readonly protocolParams: ProtocolParams;
  readonly bPubHex: string;
  readonly network: NetworkName;
  readonly feePolicy?: FeePolicy;
  readonly dustPolicy?: DustPolicy;
}

function computeRedeemDigestFromTxLock(
  params: ComputeRedeemDigestFromTxLockParams,
): string {
  const { txLock, protocolParams, bPubHex, network } = params;
  const feePolicy = params.feePolicy ?? DEFAULT_FEE_POLICY;
  const dustPolicy = params.dustPolicy ?? DEFAULT_DUST_POLICY;
  const net = resolveNetwork(network);
  const txLockHash = txLock.getHash();

  const lockWitnessScript = buildMultisigWitnessScript(protocolParams.A, bPubHex);
  const { vout: lockVout, valueSats: lockValueSats } = findMultisigOutput(txLock, lockWitnessScript, net);

  requireFeeInBounds({
    feeSats: BigInt(protocolParams.tx_redeem_fee_sats),
    weightVbytes: VBYTES_SINGLE_IN_SINGLE_OUT,
    policy: feePolicy,
    txName: 'TxRedeem',
  });
  const redeemOutputSats = BigInt(lockValueSats) - BigInt(protocolParams.tx_redeem_fee_sats);
  requireAboveDust({
    outputSats: redeemOutputSats,
    floor: dustPolicy.p2wpkhDustSats,
    txName: 'TxRedeem',
  });
  const txRedeem = buildSpendTx({
    inputTxId: Buffer.from(txLockHash),
    inputVout: lockVout,
    inputSequence: SEQUENCE_FINAL,
    outputAddress: protocolParams.redeem_address,
    outputValueSats: Number(redeemOutputSats),
    network: net,
  });

  const digest = computeWitnessSighash(txRedeem, 0, lockWitnessScript, lockValueSats);
  return digest.toString('hex');
}

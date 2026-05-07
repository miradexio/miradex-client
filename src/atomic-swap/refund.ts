// Build, sign and assemble TxRefund locally. s_b and b never leave the host.
//
// Decrypt Alice's adaptor sig with s_b (byte-reversed from Ed25519 LE to
// secp256k1 BE), sign the same digest with b, DER-encode both, append
// SIGHASH_ALL, witness stack [sig_B, sig_A, witness_script] so
// <A> CHECKSIGVERIFY <B> CHECKSIG verifies.
//
// Reference: eigenwallet swap-core/src/bitcoin/full_refund.rs.

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import type { Logger } from '../interfaces/logger.js';
import { decryptSignature, verifyEncsig, signDigest } from '../lib/crypto/wasm.js';
import { buildMultisigWitnessScript } from './presign.js';
import { VerificationError, DEFAULT_DUST_POLICY } from '../types/verification.js';
import { ProtocolError } from '../types/protocol.js';

type NetworkName = 'mainnet' | 'testnet' | 'regtest' | 'regtest';

const SEQUENCE_FINAL = 0xffffffff;

/** secp256k1 curve order n. */
const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
/** n/2; canonical low-S upper bound. */
const SECP256K1_N_HALF = SECP256K1_N >> 1n;

function resolveNetwork(network: NetworkName): bitcoin.Network {
  switch (network) {
    case 'mainnet':
      return bitcoin.networks.bitcoin;
    case 'regtest':
      return bitcoin.networks.regtest;
    case 'testnet':
      return bitcoin.networks.testnet;
  }
}

function reverseHex(hex: string): string {
  return Buffer.from(Buffer.from(hex, 'hex')).reverse().toString('hex');
}

export interface BuildFullRefundParams {
  readonly txCancelHex: string;
  readonly refundAddress: string;
  readonly refundFeeSats: bigint;
  readonly network: NetworkName;
}

export interface BuildFullRefundResult {
  readonly txRefundHex: string;
  readonly refundOutputValueSats: bigint;
  readonly cancelOutputValueSats: bigint;
}

export interface BuildPartialRefundParams extends BuildFullRefundParams {
  readonly amnestyAmountSats: bigint;
  readonly partialRefundFeeSats: bigint;
  readonly aPubHex: string;
  readonly bPubHex: string;
}

export interface BuildPartialRefundResult {
  readonly txRefundHex: string;
  readonly refundOutputValueSats: bigint;
  readonly amnestyOutputValueSats: bigint;
  readonly cancelOutputValueSats: bigint;
}

export interface SignRefundParams {
  readonly txRefundHex: string;
  readonly witnessScript: Buffer;
  readonly txCancelOutputValueSats: bigint;
  readonly encsigRefund: string;
  /** Bob's s_b in its stored Ed25519 little-endian form. Reversed internally. */
  readonly sBHexLE: string;
  readonly bHex: string;
  readonly aPubHex: string;
  readonly bPubHex: string;
  /** Bob's adaptor public key S_b_bitcoin (verification target for encsig). */
  readonly sBPubHex: string;
  readonly logger?: Logger;
}

export interface AssembledRefundTx {
  readonly txid: string;
  readonly hex: string;
  readonly digestHex: string;
}

// Unsigned single-output TxRefund spending TxCancel's sole output. Returns
// hex + the output value the caller needs for the BIP143 sighash.
export function buildFullRefund(params: BuildFullRefundParams): BuildFullRefundResult {
  const net = resolveNetwork(params.network);
  const txCancel = bitcoin.Transaction.fromHex(params.txCancelHex);
  const cancelOut = txCancel.outs[0];
  if (!cancelOut) {
    throw new ProtocolError('E_TX_CANCEL_MALFORMED', 'TxCancel has no output at index 0');
  }
  const cancelValue = BigInt(cancelOut.value);
  const refundValue = cancelValue - params.refundFeeSats;
  if (refundValue <= DEFAULT_DUST_POLICY.p2wpkhDustSats) {
    throw new VerificationError(
      'E_REFUND_DUST',
      `refund output ${refundValue.toString()} below P2WPKH dust floor ${DEFAULT_DUST_POLICY.p2wpkhDustSats.toString()}`,
    );
  }

  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = 0;
  const txCancelTxidLE = Buffer.from(Buffer.from(txCancel.getId(), 'hex')).reverse();
  tx.addInput(txCancelTxidLE, 0, SEQUENCE_FINAL);
  tx.addOutput(bitcoin.address.toOutputScript(params.refundAddress, net), refundValue);

  return {
    txRefundHex: tx.toHex(),
    refundOutputValueSats: refundValue,
    cancelOutputValueSats: cancelValue,
  };
}

// Two-output TxPartialRefund (amnesty variant):
//   out 0 - refund back to Bob
//   out 1 - new 2-of-2 P2WSH holding the amnesty amount
export function buildPartialRefund(params: BuildPartialRefundParams): BuildPartialRefundResult {
  const net = resolveNetwork(params.network);
  const txCancel = bitcoin.Transaction.fromHex(params.txCancelHex);
  const cancelOut = txCancel.outs[0];
  if (!cancelOut) {
    throw new ProtocolError('E_TX_CANCEL_MALFORMED', 'TxCancel has no output at index 0');
  }
  const cancelValue = BigInt(cancelOut.value);
  const refundValue = cancelValue - params.amnestyAmountSats - params.partialRefundFeeSats;
  if (refundValue <= DEFAULT_DUST_POLICY.p2wpkhDustSats) {
    throw new VerificationError(
      'E_REFUND_DUST',
      `partial refund output ${refundValue.toString()} below P2WPKH dust floor ${DEFAULT_DUST_POLICY.p2wpkhDustSats.toString()}`,
    );
  }
  if (params.amnestyAmountSats <= DEFAULT_DUST_POLICY.p2wshDustSats) {
    throw new VerificationError(
      'E_AMNESTY_DUST',
      `amnesty output ${params.amnestyAmountSats.toString()} below P2WSH dust floor ${DEFAULT_DUST_POLICY.p2wshDustSats.toString()}`,
    );
  }

  const witnessScript = buildMultisigWitnessScript(params.aPubHex, params.bPubHex);
  const amnestyP2wsh = bitcoin.payments.p2wsh({
    redeem: { output: witnessScript },
    network: net,
  });
  if (!amnestyP2wsh.output) {
    throw new ProtocolError('E_AMNESTY_DERIVE', 'failed to derive amnesty P2WSH');
  }

  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = 0;
  const txCancelTxidLE = Buffer.from(Buffer.from(txCancel.getId(), 'hex')).reverse();
  tx.addInput(txCancelTxidLE, 0, SEQUENCE_FINAL);
  tx.addOutput(bitcoin.address.toOutputScript(params.refundAddress, net), refundValue);
  tx.addOutput(Buffer.from(amnestyP2wsh.output), params.amnestyAmountSats);

  return {
    txRefundHex: tx.toHex(),
    refundOutputValueSats: refundValue,
    amnestyOutputValueSats: params.amnestyAmountSats,
    cancelOutputValueSats: cancelValue,
  };
}

// Verify encsig, decrypt Alice's sig, sign with b, DER-encode, append
// SIGHASH_ALL, assemble the 2-of-2 witness.
export function signRefund(params: SignRefundParams): AssembledRefundTx {
  const tx = bitcoin.Transaction.fromHex(params.txRefundHex);
  const digest = Buffer.from(
    tx.hashForWitnessV0(
      0,
      params.witnessScript,
      params.txCancelOutputValueSats,
      bitcoin.Transaction.SIGHASH_ALL,
    ),
  );
  const digestHex = digest.toString('hex');

  const encsigOk = verifyEncsig(params.aPubHex, params.sBPubHex, digestHex, params.encsigRefund);
  if (!encsigOk) {
    throw new VerificationError(
      'E_ENCSIG_REFUND_INVALID',
      'Alice encsig_refund does not verify under the recomputed refund digest',
    );
  }

  const sBSecp = reverseHex(params.sBHexLE);
  const sigACompact = Buffer.from(decryptSignature(sBSecp, params.encsigRefund), 'hex');
  const sigBCompact = Buffer.from(signDigest(params.bHex, digestHex), 'hex');

  if (!isLowS(sigACompact)) {
    throw new VerificationError('E_SIG_HIGH_S', 'decrypted Alice sig is not in low-S form');
  }
  if (!isLowS(sigBCompact)) {
    throw new VerificationError('E_SIG_HIGH_S', 'Bob sig is not in low-S form');
  }

  const aPub = Buffer.from(params.aPubHex, 'hex');
  const bPub = Buffer.from(params.bPubHex, 'hex');
  if (!ecc.verify(digest, aPub, sigACompact)) {
    throw new VerificationError(
      'E_REFUND_SIG_A',
      'Alice sig fails local ECDSA verification against A',
    );
  }
  if (!ecc.verify(digest, bPub, sigBCompact)) {
    throw new VerificationError(
      'E_REFUND_SIG_B',
      'Bob sig fails local ECDSA verification against B',
    );
  }

  const sigAWithHashType = Buffer.concat([
    compactToDer(sigACompact),
    Buffer.from([bitcoin.Transaction.SIGHASH_ALL]),
  ]);
  const sigBWithHashType = Buffer.concat([
    compactToDer(sigBCompact),
    Buffer.from([bitcoin.Transaction.SIGHASH_ALL]),
  ]);

  const firstInput = tx.ins[0];
  if (!firstInput) {
    throw new ProtocolError('E_TX_CANCEL_MALFORMED', 'unsigned refund tx has no input 0');
  }
  firstInput.witness = [sigBWithHashType, sigAWithHashType, params.witnessScript];

  params.logger?.debug(
    { digest: digestHex, txid: tx.getId() },
    'assembled client-side TxRefund',
  );

  return {
    txid: tx.getId(),
    hex: tx.toHex(),
    digestHex,
  };
}

// Strict-DER encode a 64B compact ECDSA sig. Caller appends SIGHASH_ALL.
export function compactToDer(compact: Buffer): Buffer {
  if (compact.length !== 64) {
    throw new Error(`expected 64-byte compact signature, got ${String(compact.length)}`);
  }
  const r = trimLeadingZeros(compact.subarray(0, 32));
  const s = trimLeadingZeros(compact.subarray(32, 64));
  const rEnc = encodeDerInteger(r);
  const sEnc = encodeDerInteger(s);
  const body = Buffer.concat([rEnc, sEnc]);
  if (body.length > 0xff) {
    throw new Error('DER body length overflows single byte');
  }
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/** Decode a strict-DER ECDSA signature back into a 64-byte compact form. */
export function derToCompact(der: Buffer): Buffer {
  if (der.length < 8 || der[0] !== 0x30) {
    throw new Error('DER must start with 0x30 SEQUENCE tag');
  }
  let i = 2;
  if (der[i] !== 0x02) throw new Error('expected r INTEGER tag');
  const rLen = der[i + 1];
  if (rLen === undefined) throw new Error('DER truncated at r length');
  const r = der.subarray(i + 2, i + 2 + rLen);
  i += 2 + rLen;
  if (der[i] !== 0x02) throw new Error('expected s INTEGER tag');
  const sLen = der[i + 1];
  if (sLen === undefined) throw new Error('DER truncated at s length');
  const s = der.subarray(i + 2, i + 2 + sLen);
  return Buffer.concat([padTo32(r), padTo32(s)]);
}

function trimLeadingZeros(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return buf.subarray(i);
}

function encodeDerInteger(integer: Buffer): Buffer {
  const high = integer[0] ?? 0;
  const needsPrefix = (high & 0x80) !== 0;
  const value = needsPrefix ? Buffer.concat([Buffer.from([0x00]), integer]) : integer;
  return Buffer.concat([Buffer.from([0x02, value.length]), value]);
}

function padTo32(buf: Buffer): Buffer {
  if (buf.length === 32) return buf;
  if (buf.length > 32) return buf.subarray(buf.length - 32);
  return Buffer.concat([Buffer.alloc(32 - buf.length), buf]);
}

/** Reject high-S signatures (BIP146). */
export function isLowS(compact: Buffer): boolean {
  if (compact.length !== 64) return false;
  const s = BigInt('0x' + compact.subarray(32, 64).toString('hex'));
  return s > 0n && s <= SECP256K1_N_HALF;
}

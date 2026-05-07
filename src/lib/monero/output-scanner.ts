// Detect owned outputs in a Monero tx given the shared view key and the
// combined spend pubkey. For matches, decrypt the amount and compute the
// RCT commitment mask. Used by verify-xmr-lock.ts and monero-sweep.ts.

import { Point } from '@noble/ed25519';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Logger } from '../../interfaces/logger.js';
import { noopLogger } from '../../interfaces/logger.js';
import {
  ED25519_GROUP_ORDER,
  bytesToBigIntLE,
  hexToScalarLE,
  bigIntToBytes,
} from '../crypto/scalars.js';
import type { MoneroTxJson } from './rpc.js';

/** A scanned output with all fields needed for SweepConstructionData. */
export interface ScannedOutput {
  /** One-time public key P (32 bytes hex). */
  readonly oneTimePublicKey: string;
  /** Transaction public key R (32 bytes hex). */
  readonly txPublicKey: string;
  /** Index of this output within its transaction. */
  readonly outputIndex: number;
  /** Global output index on the blockchain. */
  readonly globalOutputIndex: number;
  /** Decrypted amount in piconeros. */
  readonly amount: bigint;
  /** RCT commitment blinding factor (32 bytes hex). Computed via WASM. */
  readonly rctMask: string;
}

// computeMask / decryptAmountFn typically wrap the WASM equivalents;
// decryptAmountFn falls back to the local TS impl when omitted.
export function scanTransactionOutputs(params: {
  readonly txJson: MoneroTxJson;
  readonly globalOutputIndices: readonly number[];
  readonly viewKeyHex: string;
  readonly spendPubHex: string;
  readonly computeMask: (viewKeyHex: string, txPubKeyHex: string, outputIndex: number) => string;
  readonly decryptAmountFn?: (viewKeyHex: string, txPubKeyHex: string, outputIndex: number, encryptedHex: string) => bigint;
  readonly logger?: Logger;
}): ScannedOutput[] {
  const { txJson, globalOutputIndices, viewKeyHex, spendPubHex, computeMask, decryptAmountFn, logger: log = noopLogger } = params;

  const txPubKeyR = extractTxPubKey(txJson.extra);
  if (!txPubKeyR) {
    log.error({ extraLen: txJson.extra.length }, 'No tx public key (tag 0x01) found in extra');
    return [];
  }

  const txPubKeyHex = bytesToHex(txPubKeyR);
  log.debug({ txPubKeyR: txPubKeyHex.slice(0, 16) + '...' }, 'Extracted tx public key R');

  let d8Bytes: Uint8Array;
  try {
    const viewKey = hexToScalar(viewKeyHex);
    const rPoint = Point.fromHex(txPubKeyHex);
    const sharedSecret = rPoint.multiply(viewKey);
    const d8 = sharedSecret.clearCofactor();
    d8Bytes = d8.toBytes();
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to compute shared secret',
    );
    return [];
  }

  let spendPub: InstanceType<typeof Point>;
  try {
    spendPub = Point.fromHex(spendPubHex);
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err), spendPubHex },
      'Invalid spend public key',
    );
    return [];
  }

  const results: ScannedOutput[] = [];

  for (let i = 0; i < txJson.vout.length; i++) {
    const output = txJson.vout[i];
    if (!output) continue;

    const outputKeyHex = output.target.tagged_key?.key ?? output.target.key;
    if (!outputKeyHex) continue;

    // P' = Hs(D8 || varint(i)) * G + B
    const derivationScalar = deriveScalar(d8Bytes, i);
    const expectedKey = Point.BASE.multiply(derivationScalar).add(spendPub);
    const expectedKeyHex = bytesToHex(expectedKey.toBytes());

    const isMatch = expectedKeyHex === outputKeyHex;

    if (isMatch) {
      // Prefer the WASM decrypt — same key derivation as mask / key images.
      const ecdhInfo = txJson.rct_signatures.ecdhInfo[i];
      let amount: bigint;
      if (decryptAmountFn && ecdhInfo) {
        amount = decryptAmountFn(viewKeyHex, txPubKeyHex, i, ecdhInfo.amount);
      } else {
        amount = decryptAmount(d8Bytes, i, ecdhInfo);
      }

      let rctMask = '';
      try {
        rctMask = computeMask(viewKeyHex, txPubKeyHex, i);
      } catch (err) {
        log.warn(
          { outputIndex: i, error: err instanceof Error ? err.message : String(err) },
          'Failed to compute commitment mask',
        );
      }

      const globalIdx = globalOutputIndices[i] ?? 0;

      log.info(
        {
          outputIndex: i,
          globalOutputIndex: globalIdx,
          amount: amount.toString(),
          rctMaskLen: rctMask.length,
        },
        'Found matching output',
      );

      results.push({
        oneTimePublicKey: outputKeyHex,
        txPublicKey: txPubKeyHex,
        outputIndex: i,
        globalOutputIndex: globalIdx,
        amount,
        rctMask,
      });
    }
  }

  log.info(
    { scannedOutputs: txJson.vout.length, matches: results.length },
    'Output scanning complete',
  );

  return results;
}

// Tag 0x01 = 32B pubkey.
export function extractTxPubKey(extra: readonly number[]): Uint8Array | null {
  for (let i = 0; i < extra.length; i++) {
    if (extra[i] === 0x01 && i + 32 < extra.length) {
      return new Uint8Array(extra.slice(i + 1, i + 33));
    }
  }
  return null;
}

export function hexToScalar(hex: string): bigint {
  return hexToScalarLE(hex);
}

// Hs(D8 || varint(i)) mod L; keccak output as little-endian scalar.
export function deriveScalar(d8Bytes: Uint8Array, outputIndex: number): bigint {
  const hash = deriveScalarBytes(d8Bytes, outputIndex);
  const raw = bytesToBigIntLE(hash);
  return ((raw % ED25519_GROUP_ORDER) + ED25519_GROUP_ORDER) % ED25519_GROUP_ORDER;
}

// Raw 32B keccak256(D8 || varint(i)).
export function deriveScalarBytes(d8Bytes: Uint8Array, outputIndex: number): Uint8Array {
  const varintBuf = encodeVarint(outputIndex);
  const preimage = new Uint8Array(d8Bytes.length + varintBuf.length);
  preimage.set(d8Bytes);
  preimage.set(varintBuf, d8Bytes.length);
  return keccak_256(preimage);
}

// RingCT amount decryption (Bulletproofs+ style 8-byte XOR).
// Matches wallet2 / Rust WASM decrypt_amount_inner:
//   derivation_scalar = sc_reduce32(keccak256(D8 || varint(i)))
//   amount_key        = keccak256("amount" || derivation_scalar.as_bytes())
// The reduced scalar is serialised canonically as 32 LE bytes before the
// second hash. Skipping mod-L reduction silently produces garbage XOR
// plaintexts whenever the hash exceeds the group order.
export function decryptAmount(
  d8Bytes: Uint8Array,
  outputIndex: number,
  ecdhInfo: { readonly amount: string } | undefined,
): bigint {
  if (!ecdhInfo) return 0n;

  const rawDerivationHash = deriveScalarBytes(d8Bytes, outputIndex);
  const derivationScalarBytes = bigIntToBytes(bytesToBigIntLE(rawDerivationHash));

  const amountPrefix = new TextEncoder().encode('amount');
  const amountPreimage = new Uint8Array(amountPrefix.length + 32);
  amountPreimage.set(amountPrefix);
  amountPreimage.set(derivationScalarBytes, amountPrefix.length);
  const amountKey = keccak_256(amountPreimage);

  const encryptedAmount = hexToBytes(ecdhInfo.amount);
  const decrypted = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    decrypted[i] = (encryptedAmount[i] ?? 0) ^ (amountKey[i] ?? 0);
  }

  let amount = 0n;
  for (let i = 7; i >= 0; i--) {
    amount = (amount << 8n) | BigInt(decrypted[i] ?? 0);
  }
  return amount;
}

// Monero varint = unsigned LEB128.
export function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return new Uint8Array(bytes);
}

// Fetch the lock tx from a public monerod and scan its outputs with the
// shared view key. Gates submit_encsig (which releases BTC) on the XMR
// actually being locked. Pure @noble/ed25519 + @noble/hashes — no WASM.

import { Point } from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Logger } from '../../interfaces/logger.js';
import { noopLogger } from '../../interfaces/logger.js';
import {
  extractTxPubKey,
  hexToScalar,
  deriveScalar,
  decryptAmount,
} from './output-scanner.js';
import { fetchTransaction, fetchTransactionQuorum, STAGENET_NODES } from './rpc.js';
import type { MoneroTxJson } from './rpc.js';

export interface XmrLockVerification {
  /** Whether the lock was verified. */
  readonly verified: boolean;
  /** Amount locked in piconeros (if verified). */
  readonly amount: bigint;
  /** Number of confirmations. */
  readonly confirmations: number;
  /** Reason for failure (if not verified). */
  readonly reason?: string;
  // True only for "still confirming" failures; everything else is terminal
  // and must not be retried without human decision.
  readonly retryable?: boolean;
}

export interface VerifyXmrLockParams {
  /** Lock transaction hash (hex, 64 chars). */
  readonly lockTxHash: string;
  /** Shared private view key v = v_a + v_b (hex, 64 chars). */
  readonly viewKeyHex: string;
  /** Combined public spend key S_a_monero + S_b_monero (hex, 64 chars). */
  readonly spendPubHex: string;
  /** Expected amount in piconeros. */
  readonly expectedAmount: bigint;
  /** Minimum confirmations required (default: 10). */
  readonly minConfirmations?: number;
  /** Public Monero node URL (single-node path; prefer `monerodNodes` + quorum). */
  readonly monerodUrl?: string;
  /** Multiple Monero node URLs for quorum verification (≥3 recommended). */
  readonly monerodNodes?: readonly string[];
  /** Minimum nodes that must agree on the tx. Default 2. */
  readonly monerodQuorum?: number;
  /** Per-node request timeout in ms. Default 15_000. */
  readonly monerodTimeoutMs?: number;
  /** Alice's tx secret key r (hex). If provided, verifies R = r*G. */
  readonly txKeyHex?: string;
  /** Logger. */
  readonly logger?: Logger;
}

const FAIL = { verified: false, amount: 0n, confirmations: 0 } as const;

// Call BEFORE submit_encsig. verified:false => do not release the encsig.
export async function verifyXmrLocked(
  params: VerifyXmrLockParams,
): Promise<XmrLockVerification> {
  const {
    lockTxHash,
    viewKeyHex,
    spendPubHex,
    expectedAmount,
    minConfirmations = 10,
    txKeyHex,
    logger: log = noopLogger,
  } = params;

  const quorumNodes = params.monerodNodes;
  const nodes = quorumNodes ?? (params.monerodUrl ? [params.monerodUrl] : [...STAGENET_NODES]);
  const quorum = params.monerodQuorum ?? 2;
  const timeoutMs = params.monerodTimeoutMs ?? 15_000;
  log.info(
    { lockTxHash, nodes, quorum, viewKeyLen: viewKeyHex.length, spendPubLen: spendPubHex.length },
    'Verifying XMR lock',
  );

  let txJson: MoneroTxJson;
  let confirmations: number;

  try {
    const fetched = quorumNodes && quorumNodes.length >= quorum
      ? await fetchTransactionQuorum({ nodes, quorum, timeoutMs, logger: log }, lockTxHash)
      : await fetchTransaction({ nodes, logger: log }, lockTxHash);
    txJson = fetched.txJson;
    confirmations = fetched.confirmations;
    log.info(
      { confirmations, inPool: fetched.inPool, blockHeight: fetched.blockHeight },
      'Transaction found on chain',
    );
  } catch (err) {
    const reason = `Could not fetch tx: ${err instanceof Error ? err.message : String(err)}`;
    log.warn({ lockTxHash, reason }, 'Monerod fetch failed; marking retryable');
    // Transient: caller backs off and retries.
    return { ...FAIL, reason, retryable: true };
  }

  if (confirmations < minConfirmations) {
    return {
      verified: false,
      amount: 0n,
      confirmations,
      reason: `Only ${String(confirmations)} confirmations (need ${String(minConfirmations)})`,
      retryable: true,
    };
  }

  // AV-A.5: tx-level unlock_time != 0 keeps the output spend-locked past the
  // cancel window. No legitimate swap-lock tx uses it; reject as griefing.
  if (txJson.unlock_time !== undefined && txJson.unlock_time !== 0) {
    return {
      verified: false,
      amount: 0n,
      confirmations,
      reason: `unlock_time is ${String(txJson.unlock_time)} (expected 0)`,
    };
  }

  const txPubKeyR = extractTxPubKey(txJson.extra);
  if (!txPubKeyR) {
    return {
      verified: false,
      amount: 0n,
      confirmations,
      reason: 'Could not extract tx public key from extra',
    };
  }

  const txPubKeyHex = bytesToHex(txPubKeyR);
  log.info({ txPubKeyR: txPubKeyHex }, 'Extracted tx public key R');

  let d8Bytes: Uint8Array;

  try {
    if (txKeyHex) {
      log.debug({ txKeyLen: txKeyHex.length }, 'Using tx_key path for verification');
      const txKey = hexToScalar(txKeyHex);

      const expectedR = Point.BASE.multiply(txKey);
      const expectedRHex = bytesToHex(expectedR.toBytes());

      if (expectedRHex !== bytesToHex(txPubKeyR)) {
        return {
          verified: false,
          amount: 0n,
          confirmations,
          reason: 'tx_key does not match tx public key — Alice may have provided a fake tx_key',
        };
      }

      log.info({}, 'tx_key verified: R = r*G');

      const viewKeyScalar = hexToScalar(viewKeyHex);
      const viewPub = Point.BASE.multiply(viewKeyScalar);
      const sharedSecret = viewPub.multiply(txKey);
      d8Bytes = sharedSecret.clearCofactor().toBytes();
    } else {
      const viewKey = hexToScalar(viewKeyHex);
      const rPoint = Point.fromHex(txPubKeyHex);
      const sharedSecret = rPoint.multiply(viewKey);
      d8Bytes = sharedSecret.clearCofactor().toBytes();
    }
  } catch (err) {
    const reason = `Cryptographic error: ${err instanceof Error ? err.message : String(err)}`;
    return { verified: false, amount: 0n, confirmations, reason };
  }

  let spendPub: InstanceType<typeof Point>;
  try {
    spendPub = Point.fromHex(spendPubHex);
  } catch (err) {
    const reason = `Invalid spend public key: ${err instanceof Error ? err.message : String(err)}`;
    return { verified: false, amount: 0n, confirmations, reason };
  }

  for (let i = 0; i < txJson.vout.length; i++) {
    const output = txJson.vout[i];
    if (!output) continue;

    // AV-A.5: skip per-output unlock_time != 0 so a mixed lock tx still
    // matches when the honest output is our target.
    if (output.unlock_time !== undefined && output.unlock_time !== 0) continue;

    const outputKeyHex = output.target.tagged_key?.key ?? output.target.key;
    if (!outputKeyHex) continue;

    const derivationScalar = deriveScalar(d8Bytes, i);
    const expectedKey = Point.BASE.multiply(derivationScalar).add(spendPub);
    const expectedKeyHex = bytesToHex(expectedKey.toBytes());

    if (expectedKeyHex === outputKeyHex) {
      log.info({ outputIndex: i }, 'Found matching output');

      const ecdhInfo = txJson.rct_signatures.ecdhInfo[i];
      const amount = decryptAmount(d8Bytes, i, ecdhInfo);

      log.info(
        {
          amount: amount.toString(),
          expectedAmount: expectedAmount.toString(),
          amountXmr: (Number(amount) / 1e12).toFixed(12),
        },
        'Decrypted amount',
      );

      if (amount < expectedAmount) {
        return {
          verified: false,
          amount,
          confirmations,
          reason: `Locked amount ${amount.toString()} is less than expected ${expectedAmount.toString()}`,
        };
      }

      return { verified: true, amount, confirmations };
    }
  }

  log.error(
    { outputCount: txJson.vout.length },
    'No output matched the lock address',
  );

  return {
    verified: false,
    amount: 0n,
    confirmations,
    reason: 'No output matched the lock address',
  };
}

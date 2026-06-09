// XMR sweep, fully client-side. Server gives us s_a after Alice redeems BTC;
// we combine s_a + s_b for the spend key, scan + decoy + sign + broadcast
// against a public monerod quorum. s_b never leaves the process.

import { Point } from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Logger } from '../../interfaces/logger.js';
import { noopLogger } from '../../interfaces/logger.js';
import { delay } from '../../lib/delay.js';
import type { ApiClient } from '../../api/index.js';
import type { SwapActionResponse } from '../../types/index.js';
import { VerificationError } from '../../types/index.js';
import { SwapCancelledError } from '../types.js';
import {
  addScalars,
  hexToBytes,
  bytesToHex as scalarBytesToHex,
  bytesToBigInt,
} from '../../lib/crypto/scalars.js';
import { wipe } from '../../lib/crypto/bytes.js';
import {
  ensureWasm,
  deriveKeyImages,
  signSweepTx,
  selectDecoys,
  computeCommitmentMask,
  decryptAmount,
  verifyCommitment,
} from '../../lib/crypto/wasm.js';
import { verifySweepTx } from '../../lib/monero/verify-sweep.js';
import { scanTransactionOutputs, hexToScalar } from '../../lib/monero/output-scanner.js';
import {
  fetchTransaction,
  fetchOutputKeys,
  fetchOutputDistribution,
  fetchFeeEstimate,
  broadcastTransaction,
  MAINNET_NODES,
  STAGENET_NODES,
} from '../../lib/monero/rpc.js';
import type { MonerodConfig } from '../../lib/monero/rpc.js';

interface ParsedSweepOutputs {
  readonly sAHex: string | undefined;
  readonly vHex: string | undefined;
  readonly lockTxHash: string | undefined;
  readonly lockAddress: string | undefined;
  readonly serverReceiveAddr: string | undefined;
}

// Sidecar emits both snake_case and camelCase; pick whichever is present.
function parseSweepOutputs(pd: unknown): ParsedSweepOutputs {
  if (!pd || typeof pd !== 'object') {
    return { sAHex: undefined, vHex: undefined, lockTxHash: undefined, lockAddress: undefined, serverReceiveAddr: undefined };
  }
  const rec = pd as Record<string, unknown>;
  const pick = (...keys: readonly string[]): string | undefined => {
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  };
  return {
    sAHex: pick('s_a_hex', 'sAHex'),
    vHex: pick('v_hex', 'vHex'),
    lockTxHash: pick('lock_tx_hash', 'lockTxHash'),
    lockAddress: pick('monero_lock_address', 'moneroLockAddress'),
    serverReceiveAddr: pick('receive_address', 'receiveAddress'),
  };
}

export interface SweepParams {
  readonly swapId: string;
  readonly s_b: Uint8Array;
  readonly receiveAddress: string;
  // AV-C.5: Alice's 32B ed25519 public spend key, hex. s_a * G == S_a_monero
  // must hold before sweep starts.
  readonly expectedSAMonero: string;
  /** Override the monerod nodes used for RPC calls. */
  readonly monerodNodes?: readonly string[];
  // Unlock window for the gamma decoy picker. Defaults to wallet2's
  // DEFAULT_LOCK_WINDOW (10); raise to CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW
  // (60) on coinbase-only chains (regtest, freshly-bootstrapped testnets).
  readonly unlockWindowBlocks?: number;
  readonly onProgress?: (stage: string, detail?: string) => void;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
}

export interface SweepResult {
  readonly txHash: string;
  /** Sweep amount in atomic units (piconeros) */
  readonly amount: string;
}

const SWEEP_RETRY_INTERVAL_MS = 15_000;
const SWEEP_ACTION_TIMEOUT_MS = 120_000;
// Covers transient monerod failures and intermittent invalid_input from
// unlucky decoy selection.
const SWEEP_MAX_ATTEMPTS = 15;
// Doubles per attempt, capped at 60s.
const SWEEP_RETRY_BASE_MS = 5_000;
// 1-in/2-out CLSAG + BP+, ring size 16. Measured ~3200 bytes from real txs.
const ESTIMATED_TX_SIZE = 3200;
// Monero "normal" priority default from cryptonote_config.h; used when
// get_fee_estimate RPC is unavailable.
const FALLBACK_FEE_PER_BYTE = 23_000;
// CLSAG + BP+ on current mainnet.
const RING_SIZE = 16;

import { validateRingMembers } from './ring-select.js';
import { isRetryableSweepError } from './errors.js';

export async function sweepMonero(api: ApiClient, params: SweepParams): Promise<SweepResult> {
  const { swapId, s_b, receiveAddress, onProgress, logger: log = noopLogger, signal } = params;

  onProgress?.('Loading sweep module...');
  log.info({ swapId }, 'Sweep: loading monero-sweep-wasm');
  await ensureWasm();
  log.info({ swapId }, 'Sweep: WASM module loaded');

  onProgress?.('Loading sweep data from server...');
  log.info({ swapId }, 'Sweep step 1: requesting redemption keys from server');

  let sAHex: string | undefined;
  let vHex: string | undefined;
  let lockTxHash: string | undefined;
  let lockAddress: string | undefined;
  let serverReceiveAddr: string | undefined;

  while (true) {
    if (signal?.aborted) throw new SwapCancelledError();

    const outputsAction: SwapActionResponse = await api.executeAction(
      swapId,
      { type: 'get-outputs' },
      SWEEP_ACTION_TIMEOUT_MS,
    );

    const sweepData = parseSweepOutputs(outputsAction.protocolData);
    sAHex = sweepData.sAHex;
    vHex = sweepData.vHex;
    lockTxHash = sweepData.lockTxHash;
    lockAddress = sweepData.lockAddress;
    serverReceiveAddr = sweepData.serverReceiveAddr;

    if (sAHex && vHex && lockTxHash) break;

    onProgress?.('Waiting for sweep data...');
    log.debug({ swapId, hasSA: !!sAHex, hasV: !!vHex, hasHash: !!lockTxHash }, 'Not ready, retrying');
    await delay(SWEEP_RETRY_INTERVAL_MS, signal);
  }

  if (!lockAddress) throw new Error('Server did not return monero_lock_address');
  if (serverReceiveAddr && serverReceiveAddr !== receiveAddress) {
    throw new Error('Receive address mismatch — keystore and server disagree on XMR destination');
  }

  const s_a = hexToBytes(sAHex);
  // AV-C.5: sidecar's s_a must multiply to S_a_monero before we combine with
  // s_b. Wrong s_a silently signs an unspendable sweep.
  {
    const s_aScalar = bytesToBigInt(s_a);
    const s_aPoint = Point.BASE.multiply(s_aScalar);
    const expectedS_aBytes = Point.fromHex(params.expectedSAMonero).toBytes();
    if (bytesToHex(s_aPoint.toBytes()) !== bytesToHex(expectedS_aBytes)) {
      throw new VerificationError(
        'E_S_A_MISMATCH',
        's_a returned by sidecar does not match S_a_monero, aborting sweep',
      );
    }
  }
  const v = hexToBytes(vHex);
  const s_full = addScalars(s_a, s_b);
  const spendKeyHex = scalarBytesToHex(s_full);
  const viewKeyHex = scalarBytesToHex(v);
  // AV-G.2: zero the individual share now that the combined key is derived.
  wipe(s_a);
  wipe(s_full);

  const spendPubScalar = hexToScalar(spendKeyHex);
  const spendPub = Point.BASE.multiply(spendPubScalar);
  const spendPubHex = bytesToHex(spendPub.toBytes());

  const isMainnet = lockAddress.startsWith('4');
  const monerodConfig: MonerodConfig = {
    nodes: params.monerodNodes ?? (isMainnet ? [...MAINNET_NODES] : [...STAGENET_NODES]),
    logger: log,
  };

  log.info(
    {
      swapId,
      lockTxHash,
      lockAddress,
      network: isMainnet ? 'mainnet' : 'stagenet',
      nodeCount: monerodConfig.nodes.length,
    },
    'Sweep step 1 complete: keys received, scanning lock tx',
  );

  // Retry transient network failures and the unlucky-decoy invalid_input.
  let lastSweepError: unknown;
  for (let attempt = 0; attempt < SWEEP_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await sweepScanSignBroadcast({
        swapId, monerodConfig, lockTxHash, viewKeyHex, spendKeyHex,
        spendPubHex, receiveAddress, api, log, onProgress,
        unlockWindowBlocks: params.unlockWindowBlocks,
      });
      return result;
    } catch (err) {
      lastSweepError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = isRetryableSweepError(msg);

      log.warn(
        { swapId, attempt: attempt + 1, maxAttempts: SWEEP_MAX_ATTEMPTS, error: msg, isRetryable },
        isRetryable
          ? 'Sweep attempt failed (retryable) — will retry'
          : 'Sweep attempt failed (non-retryable)',
      );

      if (!isRetryable) break;

      if (attempt < SWEEP_MAX_ATTEMPTS - 1) {
        const backoffMs = Math.min(SWEEP_RETRY_BASE_MS * (2 ** attempt), 60_000);
        onProgress?.(`Sweep failed, retrying in ${Math.round(backoffMs / 1000)}s...`);
        await delay(backoffMs);
      }
    }
  }
  throw lastSweepError ?? new Error('Sweep failed after all attempts');
}

// Steps 2-5: fetch lock tx, select decoys, sign, broadcast.
async function sweepScanSignBroadcast(ctx: {
  readonly swapId: string;
  readonly monerodConfig: MonerodConfig;
  readonly lockTxHash: string;
  readonly viewKeyHex: string;
  readonly spendKeyHex: string;
  readonly spendPubHex: string;
  readonly receiveAddress: string;
  readonly api: ApiClient;
  readonly log: Logger;
  readonly onProgress?: (stage: string, detail?: string) => void;
  readonly unlockWindowBlocks?: number;
}): Promise<SweepResult> {
  const {
    swapId, monerodConfig, lockTxHash, viewKeyHex, spendKeyHex, spendPubHex,
    receiveAddress, api, log, onProgress, unlockWindowBlocks,
  } = ctx;
  const buildDecoyInput = (distribution: readonly number[]): string =>
    JSON.stringify(
      unlockWindowBlocks === undefined
        ? { distribution }
        : { distribution, unlock_window_blocks: unlockWindowBlocks },
    );

  onProgress?.('Scanning lock transaction...');
  log.info({ swapId, lockTxHash }, 'Sweep step 2: fetching lock tx from monerod');

  const fetched = await fetchTransaction(monerodConfig, lockTxHash);

  log.info(
    {
      swapId,
      confirmations: fetched.confirmations,
      blockHeight: fetched.blockHeight,
      outputCount: fetched.txJson.vout.length,
      outputIndicesCount: fetched.outputIndices.length,
    },
    'Lock tx fetched, scanning outputs',
  );

  const scannedOutputs = scanTransactionOutputs({
    txJson: fetched.txJson,
    globalOutputIndices: fetched.outputIndices,
    viewKeyHex,
    spendPubHex,
    computeMask: computeCommitmentMask,
    decryptAmountFn: decryptAmount,
    logger: log,
  });

  if (scannedOutputs.length === 0) {
    throw new Error('No outputs found at lock address — output scanning failed');
  }

  const realOutput = scannedOutputs[0];
  if (!realOutput) throw new Error('Scanned output is undefined');

  log.info(
    {
      swapId,
      outputIndex: realOutput.outputIndex,
      globalOutputIndex: realOutput.globalOutputIndex,
      amount: realOutput.amount.toString(),
      amountXmr: (Number(realOutput.amount) / 1e12).toFixed(12),
      rctMaskLen: realOutput.rctMask.length,
    },
    'Sweep step 2 complete: real output found',
  );

  onProgress?.('Selecting decoys...');
  log.info({ swapId }, 'Sweep step 3: selecting decoys via WASM');

  const distribution = await fetchOutputDistribution(monerodConfig);
  log.info({ swapId, distributionLen: distribution.length }, 'Output distribution fetched');

  // wallet2-matching gamma decoy selection in WASM.
  const decoyResultJson = selectDecoys(
    realOutput.globalOutputIndex,
    buildDecoyInput(distribution),
    RING_SIZE,
  );
  const decoyResult = JSON.parse(decoyResultJson) as {
    indices: readonly number[];
    real_index_in_ring: number;
  };

  log.info(
    {
      swapId,
      ringSize: decoyResult.indices.length,
      realIndexInRing: decoyResult.real_index_in_ring,
      firstIndices: decoyResult.indices.slice(0, 4).map(String),
    },
    'Decoys selected',
  );

  // Fetch ring members from monerod, validate (reject torsion/identity per
  // wallet2 select_n), re-pick on any invalid slot. Cap is 50 because
  // regtest's auto-miner spits out immature coinbase outputs at the chain
  // tip and the gamma picker is recency-biased — a fresh draw can land
  // several immature members per ring. ~5ms per retry, so 50 stays under 1s.
  // Mainnet rarely needs more than a few.
  onProgress?.('Fetching ring member keys...');
  const MAX_RING_RETRIES = 50;
  let currentDecoyResult = decoyResult;
  let ringMemberKeys = await fetchOutputKeys(monerodConfig, currentDecoyResult.indices);
  for (let ringAttempt = 0; ringAttempt < MAX_RING_RETRIES; ringAttempt++) {
    const invalidMembers = validateRingMembers(ringMemberKeys, log);
    if (invalidMembers.length === 0) break;

    log.warn(
      {
        swapId,
        attempt: ringAttempt + 1,
        invalidCount: invalidMembers.length,
        invalidIndices: invalidMembers.map((m) => m.ringIndex),
      },
      'Ring contains invalid members (torsion/identity) — re-selecting decoys',
    );

    if (ringAttempt === MAX_RING_RETRIES - 1) {
      throw new Error(
        `Failed to find valid ring after ${MAX_RING_RETRIES} attempts — ` +
        `${invalidMembers.length} invalid members on last attempt`,
      );
    }

    const retryDecoyJson = selectDecoys(
      realOutput.globalOutputIndex,
      buildDecoyInput(distribution),
      RING_SIZE,
    );
    currentDecoyResult = JSON.parse(retryDecoyJson) as {
      indices: readonly number[];
      real_index_in_ring: number;
    };
    ringMemberKeys = await fetchOutputKeys(monerodConfig, currentDecoyResult.indices);
  }
  const finalDecoyResult = currentDecoyResult;

  log.info(
    { swapId, ringMemberCount: ringMemberKeys.length },
    'Ring member keys fetched (all valid)',
  );

  // Sanity-check our commitment against on-chain.
  const realRingMember = ringMemberKeys[finalDecoyResult.real_index_in_ring];
  if (realRingMember) {
    const commitmentMatch = verifyCommitment(
      viewKeyHex,
      realOutput.txPublicKey,
      realOutput.outputIndex,
      realOutput.amount,
      realRingMember.mask,
    );
    log.info(
      {
        swapId,
        commitmentMatch,
        onChainMask: realRingMember.mask.slice(0, 16) + '...',
        computedMask: realOutput.rctMask.slice(0, 16) + '...',
        amount: realOutput.amount.toString(),
      },
      commitmentMatch
        ? 'Commitment verification PASSED — mask + amount match on-chain'
        : 'Commitment verification FAILED — mask derivation is wrong',
    );
    if (!commitmentMatch) {
      throw new Error(
        'Commitment verification failed: computed mask + amount does not match on-chain commitment. ' +
        'The sweep transaction would be rejected.',
      );
    }
  }

  // Mempool-adjusted fee from monerod (Feather wallet does the same).
  let feePerByte = FALLBACK_FEE_PER_BYTE;
  let quantizationMask = 10_000;
  try {
    const estimate = await fetchFeeEstimate(monerodConfig);
    feePerByte = estimate.feePerByte;
    quantizationMask = estimate.quantizationMask || 10_000;
    log.info({ swapId, feePerByte, quantizationMask }, 'Fee estimate received from monerod');
  } catch (err) {
    log.warn(
      { swapId, error: err instanceof Error ? err.message : String(err) },
      'Fee estimate failed, using fallback',
    );
  }

  let networkFee = feePerByte * ESTIMATED_TX_SIZE;
  if (quantizationMask > 0) {
    networkFee = Math.ceil(networkFee / quantizationMask) * quantizationMask;
  }

  log.info({ swapId, feePerByte, estimatedTxSize: ESTIMATED_TX_SIZE, networkFee, quantizationMask }, 'Fee calculated');

  const destinationAmount = Number(realOutput.amount) - networkFee;

  if (destinationAmount <= 0) {
    throw new Error(`Output amount ${realOutput.amount.toString()} is less than network fee ${String(networkFee)}`);
  }

  const structuredOutput = {
    one_time_public_key: realOutput.oneTimePublicKey,
    tx_public_key: realOutput.txPublicKey,
    output_index: realOutput.outputIndex,
    global_output_index: realOutput.globalOutputIndex,
    amount: Number(realOutput.amount),
    rct_mask: realOutput.rctMask,
    additional_tx_keys: [] as string[],
    subaddr_major: 0,
    subaddr_minor: 0,
  };

  const constructionData = {
    inputs: [
      {
        ring_members: ringMemberKeys.map((rm) => ({
          public_key: rm.key,
          commitment: rm.mask,
        })),
        real_output_index: finalDecoyResult.real_index_in_ring,
        real_output: structuredOutput,
        key_offsets: [...finalDecoyResult.indices],
      },
    ],
    destination: {
      address: receiveAddress,
      amount: destinationAmount,
    },
    fee: networkFee,
    tx_extra: '',
    rct_type: 6,
  };

  log.info(
    {
      swapId,
      inputCount: constructionData.inputs.length,
      destinationAmount,
      networkFee,
      ringSize: ringMemberKeys.length,
      rctType: 6,
    },
    'Construction data built',
  );

  onProgress?.('Verifying transaction...');
  log.info({ swapId }, 'Sweep step 4: verifying + signing');

  const verification = verifySweepTx(constructionData, receiveAddress, log);
  if (!verification.valid) {
    throw new Error(`Sweep verification failed: ${verification.reason}`);
  }

  log.info(
    {
      swapId,
      amount: verification.amount,
      fee: verification.fee,
      amountXmr: (Number(BigInt(verification.amount)) / 1e12).toFixed(12),
    },
    'Sweep tx verified — signing via WASM',
  );

  // sign_sweep_tx needs key images precomputed.
  onProgress?.('Signing sweep transaction...');
  const keyImagesJson = deriveKeyImages(
    JSON.stringify([structuredOutput]),
    viewKeyHex,
    spendKeyHex,
  );
  log.debug({ swapId, keyImagesJson: keyImagesJson.slice(0, 60) + '...' }, 'Key images derived');

  const rawTxHex = signSweepTx(JSON.stringify(constructionData), spendKeyHex, viewKeyHex);
  log.info(
    { swapId, rawTxLen: rawTxHex.length, rawTxPrefix: rawTxHex.slice(0, 32) + '...' },
    'Transaction signed',
  );

  // Dump full construction data so an invalid_input rejection is debuggable.
  log.info(
    {
      swapId,
      realOutput: {
        oneTimePublicKey: structuredOutput.one_time_public_key,
        txPublicKey: structuredOutput.tx_public_key,
        outputIndex: structuredOutput.output_index,
        globalOutputIndex: structuredOutput.global_output_index,
        amount: structuredOutput.amount,
        rctMask: structuredOutput.rct_mask,
      },
      realRingMemberKey: ringMemberKeys[finalDecoyResult.real_index_in_ring]?.key,
      realRingMemberMask: ringMemberKeys[finalDecoyResult.real_index_in_ring]?.mask,
      realIndexInRing: finalDecoyResult.real_index_in_ring,
      keyImage: JSON.parse(keyImagesJson)[0]?.key_image,
      allIndices: finalDecoyResult.indices,
      fee: constructionData.fee,
      destinationAmount: constructionData.destination.amount,
    },
    'Sweep diagnostic: full construction data',
  );

  // Full signed tx, in case broadcast fails and someone wants to decode it.
  log.debug({ swapId, rawTxHex }, 'Full signed transaction hex');

  onProgress?.('Broadcasting sweep transaction...');
  log.info({ swapId }, 'Sweep step 5: broadcasting to monerod');

  const broadcastResult = await broadcastTransaction(monerodConfig, rawTxHex);

  if (broadcastResult.alreadySpent) {
    // Key image is ours (only we hold the spend key); we already broadcast.
    log.info(
      { swapId },
      'Sweep tx already broadcast (double_spend) — prior attempt succeeded',
    );
  } else {
    log.info(
      { swapId, txHash: broadcastResult.txHash, status: broadcastResult.status },
      'Sweep tx broadcast to network',
    );
  }

  // Notify server so the DB status flips to 'completed' and the poll loop
  // stops triggering duplicate sweeps. Without it the swap stays in 'sending'.
  const sweepTxHash = broadcastResult.txHash || `sweep-${swapId}`;
  for (let notifyAttempt = 0; notifyAttempt < 3; notifyAttempt++) {
    try {
      await api.executeAction(
        swapId,
        { type: 'sweep-complete', txHash: sweepTxHash },
        15_000,
      );
      log.info({ swapId, txHash: sweepTxHash }, 'Server notified of sweep completion');
      break;
    } catch (err) {
      log.warn(
        { swapId, attempt: notifyAttempt + 1, error: err instanceof Error ? err.message : String(err) },
        'Server notification failed, retrying',
      );
      if (notifyAttempt < 2) {
        await delay(3_000);
      }
    }
  }

  const sweepAmount = String(destinationAmount);
  onProgress?.('Sweep complete');
  log.info(
    {
      swapId,
      txHash: sweepTxHash,
      amount: sweepAmount,
      amountXmr: (destinationAmount / 1e12).toFixed(12),
      alreadySpent: broadcastResult.alreadySpent,
    },
    broadcastResult.alreadySpent ? 'Sweep already completed (prior broadcast)' : 'Sweep broadcast complete',
  );

  return { txHash: sweepTxHash, amount: sweepAmount };
}

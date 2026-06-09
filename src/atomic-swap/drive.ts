// Main action loop: poll, inspect requiredAction, fund / encsig / sweep /
// retry / handle terminal states.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// crypto.randomUUID is gated to secure contexts in some browsers; self-hosted
// miradex-web on plain HTTP (LAN IP, .local, onion) hits "is not a function"
// before any swap code runs. crypto.getRandomValues has no such restriction.
function randomUuidV4(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (!c?.getRandomValues) {
    throw new Error('Missing crypto entropy source (getRandomValues)');
  }
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  // RFC 4122 §4.4 — set version (4) and variant (10xx) bits.
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
import { Point } from '@noble/ed25519';
import type { TempBtcWallet } from '../lib/bitcoin/wallet.js';
import { buildUnsignedFundingPsbt, signFundingPsbt } from '../lib/bitcoin/wallet.js';
import { buildProtocolSnapshot } from './snapshot.js';
import {
  computePreSigs,
  computeRedeemDigest,
  computeRedeemDigestFromTxHex,
  deriveLockAddress,
} from './presign.js';
import type { DetectedDeposit } from '../lib/bitcoin/deposit-watcher.js';
import { sweepMonero } from './monero-sweep/index.js';
import { verifyXmrLocked } from '../lib/monero/verify-lock.js';
import {
  TERMINAL_STATUSES,
  VerificationError,
  ProtocolError,
  isPreFunding,
} from '../types/index.js';
import { constantTimeEqualHex } from '../lib/crypto/bytes.js';
import { encsignDigest, verifyDleqProof, ensureWasm } from '../lib/crypto/wasm.js';
import { verifyDepositAddress } from '../verification/index.js';
import { delay } from '../lib/delay.js';
import { SwapCancelledError, type DriveSwapOptions, type FundingProofEntry } from './types.js';
import { extractProtocolData } from './extract.js';
import {
  FUNDING_POLL_MS,
  FUNDING_SETTLE_MS,
  SWEEP_TIMEOUT_MS,
  MIN_XMR_CONFIRMATIONS as CFG_MIN_XMR_CONFIRMATIONS,
} from '../lib/default-config.js';

// Driver polls less often than the UI deposit watcher.
const POLL_MS = FUNDING_POLL_MS * 3;
const TIMEOUT_MS = SWEEP_TIMEOUT_MS;
const FUND_SETTLE_MS = FUNDING_SETTLE_MS;
const MIN_XMR_CONFIRMATIONS = CFG_MIN_XMR_CONFIRMATIONS;
const MAX_ENCSIG_FAILURES = 3;

// @internal Drive a server-created swap to a terminal state. Callers:
// runAtomicSwap, resumeAtomicSwap.
export async function driveSwapToCompletion(options: DriveSwapOptions): Promise<void> {
  const {
    api, swapId, keystoreId, wallet: _wallet, deposit, keystore, network,
    onProgress, signal, logger: log, blockchain,
    saveProtocolSnapshot, loadProtocolSnapshot,
    makerPeerId, makerMultiaddrs, clientVersion,
  } = options;
  const deadline = Date.now() + TIMEOUT_MS;

  let lastSignedPsbt = '';
  let lastFundedAddress = '';
  let fundedAt = 0;
  let verificationEmitted = false;
  let encsigFailures = 0;
  let aliceDleqVerified = false;
  let xmrLockVerified = false;
  // Cap retries on "no pending PSBT" / "cannot perform presigs": broker entry
  // was consumed or never armed, we can't progress, and looping till
  // TIMEOUT_MS just starves the failed-receipt restart UX.
  let presigsAlreadyDoneStreak = 0;
  const PRESIGS_ALREADY_DONE_MAX = 6;

  log.info({ swapId, network, deadline: new Date(deadline).toISOString() }, '[drive] loop started');

  let lastLoggedAction: string | undefined;
  while (true) {
    if (signal?.aborted) throw new SwapCancelledError();

    const detail = await api.getSwapDetail(swapId);
    const action = detail.requiredAction?.type;
    const pdx = extractProtocolData(detail);

    if (action !== lastLoggedAction) {
      log.info(
        { swapId, status: detail.status, action },
        '[drive] required-action changed',
      );
      lastLoggedAction = action;
    }

    if (TERMINAL_STATUSES.has(detail.status)) {
      log.info({ swapId, status: detail.status }, '[drive] terminal status reached');
      onProgress({ stage: detail.status, message: `Swap ${detail.status}`, swapId });
      return;
    }

    if (Date.now() >= deadline && isPreFunding(detail.status)) {
      throw new ProtocolError('E_DRIVE_TIMEOUT', 'swap timed out before funding');
    }

    if (action === 'fund') {
      const pastFunding = detail.status !== 'initializing'
        && detail.status !== 'awaiting_funding'
        && detail.status !== 'pending';
      // "Funding still pending" derives from depositAddress + pre-deposit
      // state; the legacy top-level pendingPsbt is now atomicswap_parameters
      // .unsigned_lock_psbt under protocolData.params.
      const hasPending = !!detail.depositAddress && !pastFunding;

      if (pastFunding && !hasPending && fundedAt > 0 && Date.now() - fundedAt > FUND_SETTLE_MS) {
        await delay(POLL_MS, signal);
        continue;
      }
      if (hasPending && fundedAt > 0) fundedAt = 0;

      // Lock address = primary deposit address. The scanner refreshes this
      // each poll, so retry-with-new-maker updates it automatically.
      const lockAddress = detail.depositAddress;

      if (lockAddress && lockAddress !== lastFundedAddress) {
        if (!aliceDleqVerified) {
          // V-2: DLEQ check is mandatory before TxLock. The proof binds
          // S_a_bitcoin and S_a_monero to the same scalar — without it Bob
          // can't recover s_a_xmr from TxRedeem if the sidecar later refuses
          // to hand back s_a, so sweep would be sidecar-trusted end-to-end.
          const pp = pdx.params;
          if (!pp?.dleq_proof_s_a) {
            log.debug(
              { swapId },
              'Alice DLEQ proof not yet available; awaiting protocol params',
            );
            await delay(POLL_MS, signal);
            continue;
          }
          if (!pp.S_a_monero || !pp.S_a_bitcoin) {
            throw new VerificationError(
              'E_DLEQ_PROOF_REQUIRED',
              'Alice DLEQ proof was provided but S_a_bitcoin / S_a_monero is missing; refusing to fund without a complete cross-curve binding',
            );
          }
          log.info({ swapId }, 'Verifying Alice DLEQ proof client-side');
          await ensureWasm();
          const dleqValid = verifyDleqProof(pp.S_a_bitcoin, pp.S_a_monero, pp.dleq_proof_s_a);
          if (!dleqValid) {
            log.error({ swapId }, 'Alice DLEQ proof verification failed');
            throw new VerificationError(
              'E_DLEQ_PROOF_INVALID',
              'Alice DLEQ proof is invalid; her Bitcoin and Monero keys are not linked, refusing to fund',
            );
          }
          aliceDleqVerified = true;
        }

        if (!verificationEmitted && detail.verification && detail.depositAddress) {
          verificationEmitted = true;
          const vr = await verifyDepositAddress({
            depositAddress: detail.depositAddress,
            verification: detail.verification,
            destAddress: keystore.swap.receiveAddress,
            refundAddress: keystore.swap.refundAddress,
            toToken: 'XMR',
            amount: '',
            // lock_address = depositAddress; timelock_blocks from typed params.
            protocol:
              detail.depositAddress &&
              detail.protocolData?.type === 'atomicswap' &&
              detail.protocolData.params
                ? {
                    lock_address: detail.depositAddress,
                    timelock_blocks: detail.protocolData.params.cancel_timelock,
                  }
                : undefined,
            expectedDestAddress: keystore.swap.receiveAddress,
          });
          onProgress({
            stage: 'signing_psbt',
            message: vr.verified ? 'Contract verified' : 'verification failed',
            swapId,
            verification: vr,
          });
          if (!vr.verified) {
            throw new VerificationError(
              'E_XMR_LOCK_FAILED',
              'lock contract verification failed, refusing to sign PSBT',
            );
          }
        }

        const protocolParams = pdx.params;
        if (!protocolParams) {
          // Sidecar writes depositAddress and protocolParams separately, so
          // requiredAction='fund' + a depositAddress before protocolParams is
          // a normal in-flight state. Re-poll; TIMEOUT_MS bounds the wait.
          log.debug({ swapId }, 'Fund requested but protocolParams not yet populated; waiting');
          onProgress({
            stage: 'signing_psbt',
            message: 'Waiting for protocol params from sidecar',
            swapId,
          });
          await delay(POLL_MS, signal);
          continue;
        }
        // AV-B.1: derive P2WSH from (A, B) locally and reject anything else.
        const derivedLockAddress = deriveLockAddress({
          aHex: protocolParams.A,
          bHex: keystore.keys.B,
          network,
        });
        if (derivedLockAddress !== lockAddress) {
          log.error(
            { swapId, derivedLockAddress, claimedLockAddress: lockAddress },
            'Lock address derived from (A, B) does not match sidecar',
          );
          throw new VerificationError(
            'E_LOCK_ADDR_MISMATCH',
            'derived P2WSH address does not match sidecar, refusing to fund',
          );
        }

        onProgress({
          stage: 'signing_psbt',
          message: `Building lock tx to ${lockAddress.slice(0, 16)}`,
          swapId,
        });

        // Lock amount in sats from amountIn (1:1 with the legacy pendingPsbt.amount).
        const lockAmountSats = detail.amountIn
          ? Math.round(parseFloat(detail.amountIn) * 1e8)
          : undefined;
        const utxoInputs = deposit.utxos ?? [deposit];
        log.info(
          {
            swapId,
            lockAddress,
            lockAmountSats,
            utxoCount: utxoInputs.length,
            totalInputSats: utxoInputs.reduce((sum, u) => sum + u.value, 0),
          },
          '[fund] Phase 1 — building unsigned lock PSBT',
        );

        // Lock-tx flow (mirrors the Rust binary's ordering):
        //   1. build UNSIGNED PSBT — what goes on the wire in Message2
        //   2. POST /presigs (unsigned PSBT + Bob's pre-sigs). Sidecar drives
        //      Message2/3/4 with Alice and returns the encsig.
        //   3. write snapshot, sign locally, POST /fund. Broadcast only after
        //      the snapshot exists, so we never end up with BTC on-chain and
        //      no autonomous-refund material.
        const unsigned = buildUnsignedFundingPsbt(_wallet, utxoInputs, lockAddress, network, lockAmountSats);
        log.info(
          { swapId, txid: unsigned.txid, vout: unsigned.vout, amountSats: unsigned.amountSats },
          '[fund] Phase 1 — unsigned PSBT built',
        );

        const signedPsbt = signFundingPsbt(unsigned.psbtBase64, _wallet, network);
        log.info({ swapId }, '[fund] Phase 1 — PSBT signed locally (held in memory)');

        if (!keystore.keys.b || !keystore.swap.refundAddress) {
          throw new ProtocolError(
            'E_PROTOCOL_PARAMS_MISSING',
            'keystore is missing b or refund address; cannot compute pre-sigs',
          );
        }
        const preSigs = computePreSigs({
          bHex: keystore.keys.b,
          signedPsbtBase64: signedPsbt,
          protocolParams,
          refundAddress: keystore.swap.refundAddress,
          network,
        });
        log.info({ swapId }, '[fund] Phase 1 — pre-sigs computed');

        onProgress({ stage: 'funding', message: 'Submitting pre-sigs (unsigned PSBT)', swapId });
        log.info(
          { swapId },
          '[fund] Phase 2 — POST /presigs (unsigned PSBT + pre-sigs → awaiting Message3)',
        );

        // Skip /presigs when the sidecar already processed it on a prior
        // attempt (encsig on protocolParams, sidecar waiting for /fund) —
        // otherwise it 409s "no pending PSBT". Either encsig counts:
        // Partial-only swaps never produce tx_full_refund_encsig.
        const alreadyHasEncsig =
          !!(protocolParams.tx_full_refund_encsig || protocolParams.tx_partial_refund_encsig) &&
          !!pdx.redeemDigestHex;
        let presigsResponse: unknown = null;
        if (alreadyHasEncsig) {
          log.info(
            { swapId },
            '[fund] Phase 2 — sidecar already past /presigs (encsig on status); skipping presigs call',
          );
          presigsAlreadyDoneStreak = 0;
        } else {
          try {
            presigsResponse = await api.executeAction(swapId, {
              type: 'presigs',
              unsignedPsbt: unsigned.psbtBase64,
              targetAddress: lockAddress,
              preSigs,
            });
            presigsAlreadyDoneStreak = 0;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            // Sidecar already past /presigs. Re-poll for the encsig; do NOT
            // retry /presigs.
            if (msg.includes('no pending PSBT') || msg.includes('cannot perform presigs')) {
              presigsAlreadyDoneStreak += 1;
              if (presigsAlreadyDoneStreak >= PRESIGS_ALREADY_DONE_MAX) {
                // Broker entry consumed (or never re-armed after sidecar
                // restart) and /getSwapDetail still isn't surfacing the encsig
                // that would let us skip /presigs. Bail to failed so the
                // failed-receipt restart UX takes over.
                throw new ProtocolError(
                  'E_PRESIGS_WEDGED',
                  `sidecar rejected /presigs ${presigsAlreadyDoneStreak} times with "${msg}" — swap is wedged (broker entry consumed but encsig never surfaced on /getSwapDetail)`,
                );
              }
              log.warn(
                {
                  swapId,
                  error: msg,
                  streak: presigsAlreadyDoneStreak,
                  cap: PRESIGS_ALREADY_DONE_MAX,
                },
                '[fund] Phase 2 — /presigs rejected because sidecar is past that step; re-polling for encsig',
              );
              await delay(POLL_MS, signal);
              continue;
            }
            log.warn({ swapId, error: msg }, '[fund] Phase 2 — presigs attempt failed, will retry');
            await delay(POLL_MS, signal);
            continue;
          }
        }

        const encsigData = alreadyHasEncsig
          ? {
              txFullRefundEncsig: protocolParams.tx_full_refund_encsig ?? null,
              txPartialRefundEncsig: protocolParams.tx_partial_refund_encsig ?? null,
              // Resume/replay path: pull from /getSwapDetail's mirrored params.
              txCancelSig: protocolParams.tx_cancel_sig ?? null,
              txLockTxid: unsigned.txid,
              txLockVout: unsigned.vout,
              txLockAmountSats: String(unsigned.amountSats),
            }
          : extractPresigsEncsig(presigsResponse);
        log.info(
          {
            swapId,
            hasFullEncsig: !!encsigData.txFullRefundEncsig,
            hasPartialEncsig: !!encsigData.txPartialRefundEncsig,
            txLockTxid: encsigData.txLockTxid,
          },
          '[fund] Phase 2 — /presigs response received',
        );

        // Refuse only when both escape hatches are missing. Partial-only swaps
        // legitimately have a null full encsig (refund = TxPartialRefund +
        // TxReclaim); Legacy/Full variants get tx_full_refund_encsig.
        if (!encsigData.txFullRefundEncsig && !encsigData.txPartialRefundEncsig) {
          throw new ProtocolError(
            'E_ENCSIG_REFUND_MISSING',
            'sidecar accepted /presigs but returned no refund encsig (neither tx_full_refund_encsig nor tx_partial_refund_encsig); refusing to fund without a refund escape hatch',
          );
        }

        log.info({ swapId }, '[fund] Phase 3 — writing recovery snapshot before broadcast');
        // V-16 enabling-work: prefer the /presigs response, then on-disk
        // protocolParams (resume), else null. No-op for the current
        // sidecar-publishes-cancel flow; seeds autonomous-cancel work later.
        const aliceTxCancelSig =
          encsigData.txCancelSig ?? protocolParams.tx_cancel_sig ?? pdx.aliceTxCancelSig ?? null;
        await maybeWriteSnapshot({
          saveProtocolSnapshot,
          loadProtocolSnapshot,
          swapId,
          externalSwapId: detail.swapNumber,
          keystoreId,
          network,
          clientVersion,
          unsignedPsbtBase64: unsigned.psbtBase64,
          lockAddress,
          lockTxid: unsigned.txid || (encsigData.txLockTxid ?? ''),
          lockVout: encsigData.txLockVout ?? unsigned.vout,
          lockAmountSats: encsigData.txLockAmountSats ?? String(unsigned.amountSats),
          protocolParams,
          encsigFull: encsigData.txFullRefundEncsig,
          encsigPartial: encsigData.txPartialRefundEncsig,
          aliceTxCancelSig,
          makerPeerId: pdx.makerPeerId ?? makerPeerId,
          makerMultiaddrs: pdx.makerMultiaddrs ?? makerMultiaddrs,
          xmrVerification: pdx.xmrVerification,
          sidecarStateAtCapture: detail.status,
          log,
        });
        log.info({ swapId }, '[fund] Phase 3 — snapshot persisted');

        onProgress({ stage: 'funding', message: 'Submitting signed PSBT for broadcast', swapId });
        log.info({ swapId }, '[fund] Phase 4 — POST /fund (signed PSBT → broadcast)');

        // Local backoff on "broker not yet awaiting". Rare (sidecar pre-arms
        // in /presigs) but possible on flaky networks or resume re-entry.
        // Looping back to drive() would rebuild the PSBT with a stale
        // lockAmountSats (pendingPsbt is gone post-/presigs), giving a
        // different txid that the sidecar would reject.
        let fundSucceeded = false;
        for (let attempt = 0; attempt < 6 && !fundSucceeded; attempt++) {
          try {
            await api.executeAction(swapId, { type: 'fund', signedPsbt });
            lastFundedAddress = lockAddress;
            lastSignedPsbt = signedPsbt;
            fundedAt = Date.now();
            fundSucceeded = true;
            onProgress({ stage: 'funding', message: 'Broadcast triggered, protocol resuming', swapId });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const brokerNotReady = msg.includes('no swap awaiting broadcast');
            if (!brokerNotReady) {
              log.warn({ swapId, error: msg, attempt }, '[fund] /fund failed; aborting local retry');
              break;
            }
            const backoffMs = Math.min(2000, 250 * 2 ** attempt);
            log.info(
              { swapId, attempt, backoffMs },
              '[fund] broker not yet armed, retrying /fund',
            );
            await delay(backoffMs);
          }
        }
        if (!fundSucceeded) {
          log.warn({ swapId }, '[fund] /fund did not succeed after local retries, will re-enter drive loop');
        }
      }
      await delay(POLL_MS, signal);
      continue;
    }

    if (action === 'submit_encsig') {
      onProgress({ stage: 'submit_encsig', message: 'Computing encrypted signature', swapId });

      const protocolParams = pdx.params;
      if (!protocolParams) {
        // Same race as the fund branch: action='submit_encsig' can arrive
        // before protocolParams is flushed into provider_metadata. Re-poll;
        // TIMEOUT_MS bounds the wait.
        log.debug({ swapId }, 'Submit-encsig requested but protocolParams not yet populated; waiting');
        onProgress({
          stage: 'submit_encsig',
          message: 'Waiting for protocol params from sidecar',
          swapId,
        });
        await delay(POLL_MS, signal);
        continue;
      }

      if (!xmrLockVerified) {
        const xmrVerif = pdx.xmrVerification;
        if (!xmrVerif) {
          onProgress({ stage: 'submit_encsig', message: 'Waiting for XMR lock verification data', swapId });
          await delay(POLL_MS, signal);
          continue;
        }

        onProgress({ stage: 'verifying_xmr', message: 'Verifying XMR lock on public node', swapId });
        log.info({ swapId, txHash: xmrVerif.lock_transfer_proof.tx_hash }, 'Verifying XMR lock');

        // AV-C.3: missing S_a_monero is a hard error.
        const sAMon = protocolParams.S_a_monero;
        const sBMon = keystore.keys.S_b_monero;
        if (!sAMon || !sBMon) {
          log.error({ swapId }, 'S_a_monero unavailable, cannot verify XMR lock');
          throw new ProtocolError(
            'E_S_A_MONERO_MISSING',
            'S_a_monero not available; refusing to release encsig without XMR lock verification',
          );
        }
        const combinedSpendPub = bytesToHex(
          Point.fromHex(sAMon).add(Point.fromHex(sBMon)).toBytes(),
        );

        const lockResult = await verifyXmrLocked({
          lockTxHash: xmrVerif.lock_transfer_proof.tx_hash,
          viewKeyHex: xmrVerif.combined_view_key,
          spendPubHex: combinedSpendPub,
          expectedAmount: BigInt(xmrVerif.xmr_amount_pico),
          minConfirmations: MIN_XMR_CONFIRMATIONS,
          txKeyHex: xmrVerif.lock_transfer_proof.tx_key ?? undefined,
          monerodNodes: options.monerodNodes,
          logger: log,
        });

        if (!lockResult.verified) {
          if (lockResult.retryable) {
            onProgress({
              stage: 'verifying_xmr',
              message: `Waiting for XMR confirmations: ${lockResult.reason ?? 'pending'}`,
              swapId,
            });
            await delay(POLL_MS, signal);
            continue;
          }
          log.error(
            {
              swapId,
              reason: lockResult.reason,
              confirmations: lockResult.confirmations,
              txHash: xmrVerif.lock_transfer_proof.tx_hash,
              txKey: xmrVerif.lock_transfer_proof.tx_key,
              lockAddress: xmrVerif.monero_lock_address,
              expectedPico: xmrVerif.xmr_amount_pico,
              viewKey: xmrVerif.combined_view_key,
              combinedSpendPub,
            },
            'XMR lock verification failed',
          );
          onProgress({
            stage: 'error',
            message: `XMR verification failed: ${lockResult.reason ?? 'unknown'}`,
            swapId,
          });
          throw new VerificationError(
            'E_XMR_LOCK_FAILED',
            lockResult.reason ?? 'XMR lock verification failed',
          );
        }

        xmrLockVerified = true;
      }

      // sidecarDigestHex may be absent (sidecar stopped surfacing it; see
      // extract.ts). When present we still byte-compare for defence-in-depth;
      // either way the local digest from PSBT-or-on-chain-TxLock is authoritative.
      const sidecarDigestHex = pdx.redeemDigestHex;
      // AV-B.2: recompute locally before signing.
      // Fresh-fund path: reuse the in-memory signed PSBT.
      // Resume path: PSBT is gone, fetch raw TxLock via the injected provider.
      let localDigestHex: string;
      if (lastSignedPsbt) {
        localDigestHex = computeRedeemDigest({
          signedPsbtBase64: lastSignedPsbt,
          protocolParams,
          bPubHex: keystore.keys.B,
          network,
        });
      } else {
        if (!blockchain) {
          throw new ProtocolError(
            'E_NO_SIGNED_PSBT',
            'resume path needs a blockchain provider to reconstruct the redeem digest',
          );
        }
        const depositTxHash = detail.depositTxHash;
        if (!depositTxHash) {
          onProgress({
            stage: 'submit_encsig',
            message: 'Waiting for deposit tx hash from sidecar',
            swapId,
          });
          await delay(POLL_MS, signal);
          continue;
        }
        const lockTxRawHex = await blockchain.getTransaction(depositTxHash);
        if (!lockTxRawHex) {
          onProgress({
            stage: 'submit_encsig',
            message: 'Fetching TxLock from blockchain provider',
            swapId,
          });
          await delay(POLL_MS, signal);
          continue;
        }
        log.info(
          { swapId, depositTxHash, lockTxLen: lockTxRawHex.length },
          'Reconstructing redeem digest from on-chain TxLock (resume path)',
        );
        localDigestHex = computeRedeemDigestFromTxHex({
          lockTxRawHex,
          protocolParams,
          bPubHex: keystore.keys.B,
          network,
        });
      }
      log.info(
        {
          swapId,
          localDigestHex,
          sidecarDigestHex,
          source: lastSignedPsbt ? 'signed-psbt' : 'on-chain-txlock',
        },
        sidecarDigestHex
          ? 'Comparing local redeem digest against sidecar claim'
          : 'Sidecar digest unavailable; using local digest only',
      );
      if (sidecarDigestHex && !constantTimeEqualHex(localDigestHex, sidecarDigestHex)) {
        log.error(
          { swapId, localDigestHex, sidecarDigestHex },
          'Redeem digest mismatch, refusing to release encsig',
        );
        throw new VerificationError(
          'E_REDEEM_DIGEST_MISMATCH',
          'local redeem digest does not match sidecar',
        );
      }
      const txRedeemEncsig = encsignDigest(keystore.keys.b, protocolParams.S_a_bitcoin, localDigestHex);

      onProgress({ stage: 'submit_encsig', message: 'Submitting encrypted signature', swapId });
      try {
        await api.executeAction(swapId, { type: 'submit_encsig', tx_redeem_encsig: txRedeemEncsig });
        onProgress({ stage: 'confirming', message: 'Signature submitted, swap progressing', swapId });
        encsigFailures = 0;
      } catch (err: unknown) {
        encsigFailures++;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ swapId, error: msg, attempt: encsigFailures }, 'Encsig submission failed');
        if (encsigFailures >= MAX_ENCSIG_FAILURES) {
          throw new ProtocolError(
            'E_ENCSIG_SUBMIT_FAILED',
            `encsig submission failed ${String(MAX_ENCSIG_FAILURES)} times: ${msg}`,
          );
        }
        onProgress({
          stage: 'confirming',
          message: `Encsig retry ${String(encsigFailures)}/${String(MAX_ENCSIG_FAILURES)}: ${msg}`,
          swapId,
        });
      }
      await delay(POLL_MS, signal);
      continue;
    }

    if (action === 'sweep' || detail.status === 'sending') {
      const pp = pdx.params;
      if (!pp?.S_a_monero) {
        throw new ProtocolError(
          'E_PROTOCOL_PARAMS_MISSING',
          'sweep requires S_a_monero in protocol params',
        );
      }
      onProgress({ stage: 'sweeping', message: 'Sweeping XMR', swapId });
      const sweepResult = await sweepMonero(api, {
        swapId,
        s_b: hexToBytes(keystore.keys.s_b),
        receiveAddress: keystore.swap.receiveAddress,
        expectedSAMonero: pp.S_a_monero,
        monerodNodes: options.monerodNodes,
        logger: log,
        signal,
      });
      onProgress({
        stage: 'complete',
        message: `Sweep complete: ${sweepResult.txHash}`,
        swapId,
        txHash: sweepResult.txHash,
      });
      return;
    }

    if (action === 'cancel' || action === 'refund') {
      onProgress({
        stage: detail.status,
        message: detail.requiredAction?.message ?? `Action: ${action}`,
        swapId,
      });
      return;
    }

    onProgress({
      stage: detail.status,
      message: detail.requiredAction?.message ?? `Status: ${detail.status}`,
      swapId,
    });
    await delay(POLL_MS, signal);
  }
}

// @internal Funding-proof payload (nonce + sig per UTXO) the server requires
// at swap creation.
export function createFundingProof(
  wallet: TempBtcWallet,
  deposit: DetectedDeposit,
): { fundingProof: readonly FundingProofEntry[]; nonce: string } {
  const nonce = randomUuidV4();
  const msgHash = sha256(new TextEncoder().encode(`${nonce}${wallet.address}`));
  const sig = wallet.keyPair.sign(msgHash);
  const signature = bytesToHex(new Uint8Array(sig));

  const utxoList = deposit.utxos ?? [deposit];
  const fundingProof: readonly FundingProofEntry[] = utxoList.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    address: wallet.address,
    nonce,
    signature,
  }));
  return { fundingProof, nonce };
}

interface PresigsEncsig {
  readonly txFullRefundEncsig: string | null;
  readonly txPartialRefundEncsig: string | null;
  /** V-16 enabling-work: Alice's plain ECDSA pre-sig on TxCancel. */
  readonly txCancelSig: string | null;
  readonly txLockTxid: string | null;
  readonly txLockVout: number | null;
  readonly txLockAmountSats: string | null;
}

function extractPresigsEncsig(response: unknown): PresigsEncsig {
  if (typeof response !== 'object' || response === null) {
    return emptyPresigsEncsig();
  }
  const r = response as { readonly protocolData?: unknown };
  if (typeof r.protocolData !== 'object' || r.protocolData === null) {
    return emptyPresigsEncsig();
  }
  const pd = r.protocolData as Record<string, unknown>;
  return {
    txFullRefundEncsig: typeof pd['txFullRefundEncsig'] === 'string' ? pd['txFullRefundEncsig'] : null,
    txPartialRefundEncsig:
      typeof pd['txPartialRefundEncsig'] === 'string' ? pd['txPartialRefundEncsig'] : null,
    txCancelSig: typeof pd['txCancelSig'] === 'string' ? pd['txCancelSig'] : null,
    txLockTxid: typeof pd['txLockTxid'] === 'string' ? pd['txLockTxid'] : null,
    txLockVout: typeof pd['txLockVout'] === 'number' ? pd['txLockVout'] : null,
    txLockAmountSats:
      typeof pd['txLockAmountSats'] === 'string' ? pd['txLockAmountSats'] : null,
  };
}

function emptyPresigsEncsig(): PresigsEncsig {
  return {
    txFullRefundEncsig: null,
    txPartialRefundEncsig: null,
    txCancelSig: null,
    txLockTxid: null,
    txLockVout: null,
    txLockAmountSats: null,
  };
}

interface MaybeWriteSnapshotInput {
  readonly saveProtocolSnapshot?: (swapId: string, snapshotJson: string) => Promise<void>;
  readonly loadProtocolSnapshot?: (swapId: string) => Promise<string | null>;
  readonly swapId: string;
  readonly externalSwapId: string;
  readonly keystoreId: string;
  readonly network: 'mainnet' | 'testnet' | 'regtest';
  readonly clientVersion: string | undefined;
  readonly unsignedPsbtBase64: string;
  readonly lockAddress: string;
  readonly lockTxid: string;
  readonly lockVout: number;
  readonly lockAmountSats: string;
  readonly protocolParams: import('../types/index.js').ProtocolParams;
  readonly encsigFull: string | null;
  readonly encsigPartial: string | null;
  // V-16 enabling-work: Alice's TxCancel pre-sig (Message3). Null when the
  // sidecar doesn't surface it; snapshot is still valid because the
  // sidecar-publishes-cancel path doesn't need it.
  readonly aliceTxCancelSig: string | null;
  readonly makerPeerId: string | undefined;
  readonly makerMultiaddrs: ReadonlyArray<string> | undefined;
  readonly xmrVerification: import('./extract.js').ExtractedProtocolData['xmrVerification'];
  readonly sidecarStateAtCapture: string;
  readonly log: import('../interfaces/logger.js').Logger;
}

async function maybeWriteSnapshot(input: MaybeWriteSnapshotInput): Promise<void> {
  if (!input.saveProtocolSnapshot) return;

  if (input.loadProtocolSnapshot) {
    const existing = await input.loadProtocolSnapshot(input.swapId).catch(() => null);
    if (existing) {
      input.log.debug({ swapId: input.swapId }, 'Snapshot already on disk; skipping');
      return;
    }
  }

  const pp = input.protocolParams;
  const snapshot = buildProtocolSnapshot({
    swapId: input.swapId,
    externalSwapId: input.externalSwapId,
    keystoreId: input.keystoreId,
    network: input.network,
    capturedByVersion: input.clientVersion ?? 'unknown',
    capturedAtEpochMs: Date.now(),
    protocolParams: {
      A: pp.A,
      S_a_bitcoin: pp.S_a_bitcoin,
      S_a_monero: pp.S_a_monero ?? '',
      v_a: pp.v_a ?? null,
      cancel_timelock: pp.cancel_timelock,
      punish_timelock: pp.punish_timelock,
      remaining_refund_timelock: pp.remaining_refund_timelock ?? null,
      redeem_address: pp.redeem_address,
      punish_address: pp.punish_address,
      tx_cancel_fee_sats: String(pp.tx_cancel_fee_sats),
      tx_refund_fee_sats: String(pp.tx_refund_fee_sats),
      tx_redeem_fee_sats: String(pp.tx_redeem_fee_sats),
      tx_punish_fee_sats: String(pp.tx_punish_fee_sats),
      amnesty_amount_sats:
        pp.amnesty_amount_sats !== undefined ? String(pp.amnesty_amount_sats) : null,
      tx_partial_refund_fee_sats:
        pp.tx_partial_refund_fee_sats !== undefined && pp.tx_partial_refund_fee_sats !== null
          ? String(pp.tx_partial_refund_fee_sats)
          : null,
      tx_reclaim_fee_sats:
        pp.tx_reclaim_fee_sats !== undefined && pp.tx_reclaim_fee_sats !== null
          ? String(pp.tx_reclaim_fee_sats)
          : null,
      tx_withhold_fee_sats:
        pp.tx_withhold_fee_sats !== undefined && pp.tx_withhold_fee_sats !== null
          ? String(pp.tx_withhold_fee_sats)
          : null,
      tx_mercy_fee_sats:
        pp.tx_mercy_fee_sats !== undefined && pp.tx_mercy_fee_sats !== null
          ? String(pp.tx_mercy_fee_sats)
          : null,
      monero_lock_address: pp.monero_lock_address ?? null,
      xmr_amount_pico: pp.xmr_amount_pico ?? '0',
      tx_full_refund_encsig: input.encsigFull,
      tx_partial_refund_encsig: input.encsigPartial,
      tx_cancel_sig: input.aliceTxCancelSig,
    },
    lockTx: {
      txid: input.lockTxid,
      vout: input.lockVout,
      amountSats: input.lockAmountSats,
      unsignedPsbtBase64: input.unsignedPsbtBase64,
      lockAddress: input.lockAddress,
    },
    maker: {
      peerId: input.makerPeerId ?? '',
      multiaddrs: input.makerMultiaddrs ?? [],
    },
    chain: {
      moneroWalletRestoreBlockheight: input.xmrVerification?.monero_restore_height ?? null,
      lockTransferProof: input.xmrVerification?.lock_transfer_proof ?? null,
      sidecarStateAtCapture: input.sidecarStateAtCapture,
    },
  });

  try {
    await input.saveProtocolSnapshot(input.swapId, JSON.stringify(snapshot, null, 2));
    input.log.info({ swapId: input.swapId, externalSwapId: input.externalSwapId }, 'Snapshot persisted');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    input.log.warn({ swapId: input.swapId, error: msg }, 'Failed to persist snapshot');
    throw new ProtocolError(
      'E_SNAPSHOT_WRITE_FAILED',
      `Refusing to broadcast lock tx without a persisted snapshot: ${msg}`,
    );
  }
}

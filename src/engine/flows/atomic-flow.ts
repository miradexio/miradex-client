import type { ApiClient } from '../../api/index.js';
import { ApiError, NetworkError } from '../../api/index.js';
import type { PlatformAdapter, DetectedDeposit } from '../platform.js';
import type { ResolvedEngineConfig } from '../miradex-engine.js';
import type { AtomicFlowState, AtomicSweepingPhase } from './atomic-flow-state.js';
import type { SwapKeystore } from '../../lib/keystore.js';
import type {
  SwapDetail,
  RequiredAction,
  SwapStatus,
  ProtocolParams,
  VerificationResult,
} from '../../types/index.js';
import { TERMINAL_STATUSES, ProtocolError } from '../../types/index.js';
import type {
  FlowContext,
  PopulatedFlowContext,
  VerifiedFlowContext,
} from '../flow-context.js';
import {
  createFlowContext,
  mergeFlowContext,
  validatePopulated,
  validateVerified,
} from '../flow-context.js';
import {
  resumeAtomicSwap as coreResumeAtomicSwap,
  SwapCancelledError,
} from '../../atomic-swap/index.js';
import type { AtomicSwapProgress } from '../../atomic-swap/index.js';
import { generateMnemonicKeys } from '../../lib/crypto/mnemonic.js';
import { generateClientKeysFromSeed, ensureWasm } from '../../lib/crypto/wasm.js';
import { walletFromWif } from '../../lib/bitcoin/wallet.js';
import { createKeystore } from '../../lib/keystore.js';
import { deriveLibp2pIdentity } from '../../lib/crypto/libp2p-identity.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { sweepMonero } from '../../atomic-swap/monero-sweep/index.js';
import { delay } from '../../lib/delay.js';
import { discoverAndVerifyTxCancel } from '../../lib/bitcoin/tx-verify.js';
import {
  buildFullRefund,
  buildPartialRefund,
  signRefund,
} from '../../atomic-swap/refund.js';
import { buildMultisigWitnessScript } from '../../atomic-swap/presign.js';
import { extractProtocolData } from '../../atomic-swap/extract.js';

const DEFAULT_POLL_MS = 5_000;
const MAX_TRANSIENT_RETRIES = 5;
function isTransientError(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  if (err instanceof ApiError) {
    if (err.statusCode >= 500) return true;
    if (err.statusCode === 429) return true;
  }
  return false;
}

// True if the params carry enough material to refund without the sidecar.
// Two valid shapes:
//   Legacy/Full: tx_full_refund_encsig alone (client builds + broadcasts
//                TxFullRefund spending TxCancel).
//   Partial:     tx_partial_refund_encsig + amnesty triple
//                (amnesty_amount_sats, tx_partial_refund_fee_sats). Amnesty
//                output stays at multisig pending TxReclaim (not implemented
//                client-side yet).
function hasRefundEscapeHatch(params: ProtocolParams): boolean {
  if (params.tx_full_refund_encsig) return true;
  return (
    !!params.tx_partial_refund_encsig &&
    params.amnesty_amount_sats !== undefined &&
    params.amnesty_amount_sats !== null &&
    params.tx_partial_refund_fee_sats !== undefined &&
    params.tx_partial_refund_fee_sats !== null
  );
}

export interface AtomicFlowOptions {
  readonly pollMs?: number;
}

export class AtomicFlow {
  private abortController: AbortController | null = null;
  private userActionResolver: (() => void) | null = null;
  private keystore: SwapKeystore | null = null;
  private deposit: DetectedDeposit | null = null;
  private keystoreId: string = '';
  private lastEmittedState: AtomicFlowState = { phase: 'idle', snapshot: null };
  private flowCtx: FlowContext | null = null;
  private lastProgressKey: string | null = null;
  private readonly pollMs: number;
  // Set once the driver emits a terminal phase. Suppresses the post-driver
  // requiredAction re-check that would otherwise trigger a phantom second
  // sweep — the server has no scanner for the on-chain XMR sweep so a fresh
  // getSwapDetail still reports requiredAction.type === 'sweep'.
  private hasReachedTerminal = false;

  // Forwarded to coreResumeAtomicSwap as params.variantId. Set by start();
  // ignored on resume (maker already chosen).
  private variantId: string | undefined;

  constructor(
    private readonly api: ApiClient,
    private readonly platform: PlatformAdapter,
    private readonly config: ResolvedEngineConfig,
    private readonly emitFn: (state: AtomicFlowState) => void,
    options?: AtomicFlowOptions,
  ) {
    this.pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  }

  private get signal(): AbortSignal {
    return this.abortController?.signal ?? AbortSignal.abort();
  }

  private get logger(): PlatformAdapter['logger'] {
    return this.platform.logger;
  }

  private setFlowContext(partial: Partial<FlowContext>): void {
    this.flowCtx = this.flowCtx
      ? mergeFlowContext(this.flowCtx, partial)
      : createFlowContext(partial);
  }

  // On failure, emits 'failed' with a structured error and returns null.
  private requirePopulated(phase: string): PopulatedFlowContext | null {
    if (!this.flowCtx) {
      this.emitError(phase, 'FlowContext not initialized');
      return null;
    }
    const result = validatePopulated(this.flowCtx, phase);
    if (result.ok) return result.data;
    this.logger.error({ fields: result.error.fields }, result.error.message);
    this.emitError(phase, result.error.message);
    return null;
  }

  // On failure, emits 'failed' with a structured error and returns null.
  private requireVerified(phase: string): VerifiedFlowContext | null {
    if (!this.flowCtx) {
      this.emitError(phase, 'FlowContext not initialized');
      return null;
    }
    const result = validateVerified(this.flowCtx, phase);
    if (result.ok) return result.data;
    this.logger.error({ fields: result.error.fields }, result.error.message);
    this.emitError(phase, result.error.message);
    return null;
  }

  private emitError(phase: string, message: string): void {
    this.transition({
      phase: 'failed',
      snapshot: this.flowCtx,
      error: `[${phase}] ${message}`,
    });
  }

  private transition(state: AtomicFlowState): void {
    const prevPhase = this.lastEmittedState.phase;
    if (state.phase === prevPhase) return;
    this.logger.info(
      { phase: state.phase, prevPhase, swapId: this.flowCtx?.swapId ?? null },
      'Atomic phase transition',
    );
    this.lastEmittedState = state;
    this.emitFn(state);
  }

  cancel(): void {
    this.abortController?.abort();
    this.userActionResolver?.();
    this.userActionResolver = null;
  }

  async start(params: {
    readonly amount: string;
    readonly destAddress: string;
    readonly refundAddress: string;
    readonly variantId?: string;
    readonly existingKeystoreId?: string;
  }): Promise<void> {
    this.abortController = new AbortController();
    this.hasReachedTerminal = false;
    this.variantId = params.variantId;
    this.logger.info(
      {
        destAddress: params.destAddress,
        amount: params.amount,
        variantId: params.variantId ?? null,
        existingKeystoreId: params.existingKeystoreId ?? null,
      },
      'AtomicFlow.start()',
    );

    try {
      this.setFlowContext({
        fromToken: 'BTC',
        toToken: 'XMR',
        destAddress: params.destAddress,
        refundAddress: params.refundAddress,
        provider: 'atomicswap',
        extra: { text: 'Initializing keygen...', type: 'message' },
      });

      this.transition({ phase: 'keygen', snapshot: this.flowCtx, message: 'Initializing keygen...' });
      await ensureWasm();

      const network = this.config.network;

      // Reuse an existing keystore (re-quote-after-failure) or generate a
      // fresh one. Flow is identical past this point.
      let wallet: { readonly wif: string; readonly address: string };

      if (params.existingKeystoreId !== undefined) {
        this.setFlowContext({ extra: { text: 'Loading keystore...', type: 'message' } });
        this.transition({ phase: 'keygen', snapshot: this.flowCtx, message: 'Loading keystore...' });

        // Trust the keystore: it was created here and its keys already
        // passed verifyKeys. Re-checking adds a transient-failure surface.
        this.keystore = await this.platform.loadKeystore(params.existingKeystoreId);
        this.keystoreId = params.existingKeystoreId;
        wallet = walletFromWif(this.keystore.btc.wif, network);
        this.logger.info(
          { keystoreId: this.keystoreId, btcAddress: wallet.address },
          'Reusing existing keystore — skipping keygen + saveKeystore',
        );
      } else {
        this.setFlowContext({ extra: { text: 'Generating swap keys...', type: 'message' } });
        this.transition({ phase: 'keygen', snapshot: this.flowCtx, message: 'Generating swap keys...' });

        const mnemonicKeys = generateMnemonicKeys(network);
        const keys = generateClientKeysFromSeed(
          mnemonicKeys.s_b_seed, mnemonicKeys.v_b_seed, mnemonicKeys.b_seed,
        );
        wallet = walletFromWif(mnemonicKeys.wif, network);

        this.logger.debug({ operation: 'keygen' }, 'Keys generated');

        const keyCheck = await this.api.verifyKeys({
          s_b_bitcoin: keys.s_b_bitcoin, s_b_monero: keys.s_b_monero,
          dleq_proof: keys.dleq_proof, v_b: keys.v_b,
        });
        this.logger.info({ valid: keyCheck.valid }, 'Key verification result');
        if (!keyCheck.valid) {
          throw new Error(`Key verification failed: ${keyCheck.reason}. DO NOT DEPOSIT.`);
        }
        this.checkAborted();

        const masterSeedHex = bytesToHex(randomBytes(32));
        const libp2pIdentity = await deriveLibp2pIdentity(masterSeedHex);
        this.keystore = createKeystore({
          wif: wallet.wif, btcAddress: wallet.address, network,
          s_b: keys.s_b, v_b: keys.v_b, S_b_bitcoin: keys.s_b_bitcoin,
          S_b_monero: keys.s_b_monero, dleq_proof: keys.dleq_proof,
          b: keys.b, B: keys.B,
          eigenwallet_master_seed: masterSeedHex,
          libp2p_peer_id: libp2pIdentity.libp2pPeerId,
          receiveAddress: params.destAddress, refundAddress: params.refundAddress,
          mnemonic: mnemonicKeys.mnemonic, derivation: mnemonicKeys.derivation,
        });

        const saveResult = await this.platform.saveKeystore(this.keystore, params.amount);
        this.keystoreId = saveResult.id;
        this.logger.info({ keystoreId: this.keystoreId }, 'Keystore saved');
      }

      // Emit keystoreId before the slow pre-deposit chain (estimateFee,
      // getQuotes, generateQr). EngineRegistry races a 30s timeout against
      // state.atomic.snapshot.keystoreId — without this early emit the
      // engine gets destroyed mid-flight on slow networks.
      this.setFlowContext({ keystoreId: this.keystoreId });
      this.transition({
        phase: 'keystore-saved',
        snapshot: this.flowCtx as FlowContext,
        message: 'Keystore saved. Computing deposit details...',
      });

      this.checkAborted();

      const { feeSats } = await this.platform.estimateFee(network);
      const userSats = Math.round(parseFloat(params.amount) * 1e8);
      const requiredBtc = ((userSats + feeSats) / 1e8).toFixed(8);

      let expectedXmr: string | null = null;
      try {
        const quotes = await this.api.getQuotes({ from: 'BTC', to: 'XMR', amount: params.amount });
        const q = quotes.quotes?.find((x: { provider: string }) => x.provider === 'atomicswap');
        expectedXmr = q?.expectedOutput ?? null;
      } catch { /* non-fatal */ }

      const qr = await this.platform.generateQr(wallet.address);

      // Slow chain done: enrich FlowContext before awaiting-deposit validates
      // against PopulatedFlowContext.
      this.setFlowContext({
        depositAddr: wallet.address,
        depositAmount: requiredBtc,
        expectedOut: expectedXmr,
        qr,
        extra: { text: `Send ${requiredBtc} BTC to the address above.`, type: 'message' },
      });
      this.checkAborted();

      const populated = this.requirePopulated('awaiting-deposit');
      if (!populated) return;

      this.transition({
        phase: 'awaiting-deposit',
        snapshot: populated,
        message: `Send ${requiredBtc} BTC to the address above.`,
      });
      this.checkAborted();

      this.deposit = await this.platform.watchDeposit(
        wallet.address, network, this.signal,
        (msg: string) => this.logger.debug({}, msg),
      );
      this.logger.info({ txid: this.deposit.txid, value: this.deposit.value }, 'Deposit detected');

      this.setFlowContext({ extra: { text: 'Deposit detected. Creating swap...', type: 'message' } });

      const populatedAfterDeposit = this.requirePopulated('deposit-detected');
      if (!populatedAfterDeposit) return;

      this.transition({
        phase: 'deposit-detected',
        snapshot: populatedAfterDeposit,
        deposit: {
          txid: this.deposit.txid,
          vout: this.deposit.vout,
          value: this.deposit.value,
          utxos: this.deposit.utxos?.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
        },
        message: 'Deposit detected. Creating swap...',
      });

      await this.driveSwapToCompletion(null);
    } catch (err: unknown) {
      this.handleError(err);
    }
  }

  async resumeFromKeystore(keystoreId: string, existingSwapId?: string): Promise<void> {
    this.abortController = new AbortController();
    this.hasReachedTerminal = false;
    this.logger.info({ keystoreId, existingSwapId: existingSwapId ?? null }, 'AtomicFlow.resumeFromKeystore()');

    try {
      await ensureWasm();

      this.keystoreId = keystoreId;
      this.keystore = await this.platform.loadKeystore(keystoreId);
      const network = (this.keystore.btc?.network ?? 'mainnet') as 'mainnet' | 'testnet' | 'regtest';
      const btcAddress = this.keystore.btc.address;

      this.setFlowContext({
        fromToken: 'BTC',
        toToken: 'XMR',
        keystoreId,
        depositAddr: btcAddress,
        destAddress: this.keystore.swap.receiveAddress,
        refundAddress: this.keystore.swap.refundAddress,
        provider: 'atomicswap',
        extra: { text: 'Loading keystore...', type: 'message' },
      });

      this.transition({
        phase: 'creating-swap',
        snapshot: this.flowCtx as FlowContext,
        message: 'Loading keystore...',
      });

      if (existingSwapId) {
        this.logger.info({ swapId: existingSwapId }, 'Resume Path A: existing swap');
        const detail = await this.fetchDetailWithRetry(existingSwapId);

        this.setFlowContext({
          swapId: existingSwapId,
          swapNumber: detail.swapNumber ?? null,
          destAddress: this.keystore.swap.receiveAddress || detail.destAddress || null,
          refundAddress: this.keystore.swap.refundAddress || detail.refundAddress || null,
          depositAmount: detail.amountIn || null,
          expectedOut: detail.expectedAmountOut || null,
          expectedOutUsd: detail.expectedAmountOutUsd ?? null,
          amountInUsd: detail.amountInUsd ?? null,
          expiresAt: detail.expiresAt || null,
        });

        if (TERMINAL_STATUSES.has(detail.status)) {
          this.emitTerminal(existingSwapId, detail.status, detail);
          return;
        }

        // Funding-address UTXO is only meaningful pre-broadcast; once the
        // swap is 'deposited' or past, BTC is in TxLock and the funding
        // address is empty. Re-querying costs 2-15s on flaky public
        // electrs and feeds nothing downstream — skip for post-funding.
        const PRE_FUNDING_STATUSES: ReadonlySet<SwapStatus> = new Set([
          'initializing',
          'pending',
          'awaiting_funding',
        ]);
        const deposit = PRE_FUNDING_STATUSES.has(detail.status)
          ? await this.platform.fetchUtxo(btcAddress, network)
          : null;
        if (deposit) this.deposit = deposit;

        let verification: VerificationResult | null = null;
        if (detail.depositAddress && detail.verification) {
          const { verifyDepositAddress } = await import('../../verification/index.js');
          verification = await verifyDepositAddress({
            depositAddress: detail.depositAddress,
            verification: detail.verification,
            destAddress: this.keystore.swap.receiveAddress,
            refundAddress: this.keystore.swap.refundAddress,
            toToken: 'XMR',
            amount: '',
            // lock_address = SwapDetail.depositAddress; timelock from typed params.
            protocol:
              detail.depositAddress &&
              detail.protocolData?.type === 'atomicswap' &&
              detail.protocolData.params
                ? {
                    lock_address: detail.depositAddress,
                    timelock_blocks: detail.protocolData.params.cancel_timelock,
                  }
                : undefined,
            expectedAmountOut: detail.expectedAmountOut ?? undefined,
            expectedDestAddress: this.keystore.swap.receiveAddress,
            fetchFn: this.config.fetchFn,
          });
        }
        // Server is past the verification gate; trust it.
        if (!verification) {
          verification = { verified: true, provider: 'atomicswap', checks: [], timestamp: Date.now() };
        }

        const qr = await this.platform.generateQr(btcAddress);
        this.setFlowContext({
          qr,
          verification,
          depositAmount: deposit ? (deposit.value / 1e8).toFixed(8) : this.flowCtx?.depositAmount ?? null,
          extra: { text: `Resuming swap (${detail.status})...`, type: 'message' },
        });

        // Core supplies verification via progress callbacks on resume; base
        // FlowContext is enough for the entry transition.
        this.transition({
          phase: 'creating-swap',
          snapshot: this.flowCtx as FlowContext,
          message: `Resuming swap (${detail.status})...`,
        });

        await this.driveSwapToCompletion(existingSwapId);
        return;
      }

      this.logger.info({ btcAddress }, 'Resume Path B: local keystore');
      const deposit = await this.platform.fetchUtxo(btcAddress, network);

      // expectedOut is required for PopulatedFlowContext. Pre-funding resume
      // has no on-chain deposit, so pull the original amount from the
      // keystore metadata (saveKeystore stores it as `label`).
      let amountForQuote: string;
      if (deposit) {
        amountForQuote = (deposit.value / 1e8).toFixed(8);
      } else {
        const meta = await this.platform.listKeystores();
        const ksMeta = meta.find((m) => m.id === keystoreId);
        amountForQuote = ksMeta?.amount ?? '0';
      }
      let expectedOut: string | null = this.flowCtx?.expectedOut ?? null;
      if (!expectedOut && amountForQuote !== '0') {
        try {
          const quotes = await this.api.getQuotes({
            from: 'BTC',
            to: 'XMR',
            amount: amountForQuote,
          });
          const q = quotes.quotes?.find((x: { provider: string }) => x.provider === 'atomicswap');
          expectedOut = q?.expectedOutput ?? null;
        } catch { /* non-fatal — requirePopulated will catch if still null */ }
      }
      const qr = await this.platform.generateQr(btcAddress);

      if (deposit) {
        this.deposit = deposit;
        this.setFlowContext({
          qr,
          expectedOut,
          depositAmount: amountForQuote,
          extra: { text: 'Deposit found. Creating swap...', type: 'message' },
        });

        const populated = this.requirePopulated('deposit-detected');
        if (!populated) return;

        this.transition({
          phase: 'deposit-detected',
          snapshot: populated,
          deposit: { txid: deposit.txid, vout: deposit.vout, value: deposit.value },
          message: 'Deposit found. Creating swap...',
        });

        await this.driveSwapToCompletion(null);
      } else {
        this.setFlowContext({
          qr,
          expectedOut,
          depositAmount: amountForQuote === '0' ? null : amountForQuote,
          extra: { text: 'Send BTC to the address above to begin the swap.', type: 'message' },
        });

        const populated = this.requirePopulated('awaiting-deposit');
        if (!populated) return;

        this.transition({
          phase: 'awaiting-deposit',
          snapshot: populated,
          message: 'Send BTC to the address above to begin the swap.',
        });

        this.checkAborted();
        this.deposit = await this.platform.watchDeposit(
          btcAddress, network, this.signal,
          (msg: string) => this.logger.debug({}, msg),
        );

        this.setFlowContext({
          depositAmount: (this.deposit.value / 1e8).toFixed(8),
          extra: { text: 'Deposit detected. Creating swap...', type: 'message' },
        });

        const populatedAfterDeposit = this.requirePopulated('deposit-detected');
        if (!populatedAfterDeposit) return;

        this.transition({
          phase: 'deposit-detected',
          snapshot: populatedAfterDeposit,
          deposit: {
          txid: this.deposit.txid,
          vout: this.deposit.vout,
          value: this.deposit.value,
          utxos: this.deposit.utxos?.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
        },
          message: 'Deposit detected. Creating swap...',
        });

        await this.driveSwapToCompletion(null);
      }
    } catch (err: unknown) {
      this.handleError(err);
    }
  }

  private async fetchDetailWithRetry(swapId: string): Promise<SwapDetail> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      try {
        return await this.api.getSwapDetail(swapId);
      } catch (err: unknown) {
        if (!isTransientError(err)) throw err;
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn({ swapId, attempt: attempt + 1, error: msg }, 'Server error fetching swap, retrying');
        this.setFlowContext({
          extra: { text: `Server error, retrying (${attempt + 1}/${MAX_TRANSIENT_RETRIES})...`, type: 'warning' },
        });
        this.transition({
          phase: 'creating-swap',
          snapshot: this.flowCtx as FlowContext,
          message: `Server error, retrying (${attempt + 1}/${MAX_TRANSIENT_RETRIES})...`,
        });
        await delay(this.pollMs * (attempt + 1), this.signal).catch(() => {});
        if (this.signal.aborted) throw new SwapCancelledError();
      }
    }
    throw lastErr ?? new Error(`Failed to fetch swap ${swapId} after retries`);
  }

  private async driveSwapToCompletion(existingSwapId: string | null): Promise<void> {
    if (!this.keystore) {
      throw new Error('keystore must be set before driving swap');
    }

    const network = (this.keystore.btc?.network ?? 'mainnet') as 'mainnet' | 'testnet' | 'regtest';

    // AV-B.2 (resume): the driver reconstructs TxLock via this provider when
    // recomputing the redeem digest. Shared across the driver's lifetime.
    const blockchain = await this.platform.createBlockchainProvider(network);

    const result = await coreResumeAtomicSwap({
      api: this.api,
      params: {
        keystore: this.keystore,
        deposit: this.deposit ?? { txid: '', vout: 0, value: 0, confirmations: 0, status: 'mempool' as const, utxos: [] },
        network,
        blockchain,
        existingSwapId: existingSwapId ?? undefined,
        logger: this.logger,
        monerodNodes: this.config.monerodNodes,
        ...(this.variantId !== undefined ? { variantId: this.variantId } : {}),
      },
      onProgress: (p: AtomicSwapProgress) => this.mapCoreProgress(p),
      signal: this.signal,
      fetchFn: this.config.fetchFn,
      saveProtocolSnapshot: this.platform.saveProtocolSnapshot,
      loadProtocolSnapshot: this.platform.loadProtocolSnapshot,
    });

    // Skip the server re-check if mapCoreProgress already emitted terminal:
    // the server has no on-chain XMR scanner so it still reports
    // requiredAction=sweep right after our broadcast, which would trigger a
    // phantom second executeSweep and a spurious completed -> sweeping flicker.
    if (this.hasReachedTerminal) return;

    let finalStatus = 'completed';
    let requiredAction: RequiredAction | null = null;
    try {
      const detail = await this.api.getSwapDetail(result.swapId);
      finalStatus = detail.status;
      requiredAction = detail.requiredAction ?? null;
      this.setFlowContext({ swapId: result.swapId, swapNumber: detail.swapNumber ?? null });
    } catch { /* best effort */ }

    if (requiredAction?.type === 'refund') {
      await this.executeRefund(result.swapId);
      return;
    }

    if (requiredAction?.type === 'sweep' || finalStatus === 'sending') {
      await this.executeSweep(result.swapId);
      return;
    }

    if (TERMINAL_STATUSES.has(finalStatus as SwapStatus)) {
      this.emitTerminal(result.swapId, finalStatus, undefined);
      return;
    }

    // Non-terminal with no actionable requiredAction (e.g. server still
    // broadcasting TxCancel). Sidecar handles cancel; we wait for the
    // action to flip to 'refund' or the swap to reach terminal.
    this.setFlowContext({
      extra: { text: requiredAction?.message ?? 'Waiting for server...', type: 'message' },
    });
    await this.pollUntilTerminal(result.swapId);
  }

  private mapCoreProgress(p: AtomicSwapProgress): void {
    const progressKey = `${p.stage}|${p.swapId ?? ''}|${p.message}`;
    if (progressKey !== this.lastProgressKey) {
      this.logger.debug({ stage: p.stage, swapId: p.swapId ?? null, message: p.message }, 'Core progress');
      this.lastProgressKey = progressKey;
    }
    if (p.swapId) this.setFlowContext({ swapId: p.swapId });
    if (p.swapNumber) this.setFlowContext({ swapNumber: p.swapNumber });
    if (p.verification) this.setFlowContext({ verification: p.verification });

    switch (p.stage) {
      case 'keygen':
      case 'keystore_saved':
      case 'awaiting_deposit':
      case 'deposit_detected':
      case 'creating_swap':
      case 'initializing':
      case 'pending':
      case 'awaiting_funding':
        this.setFlowContext({ extra: { text: p.message, type: 'message' } });
        this.transition({
          phase: 'creating-swap',
          snapshot: this.flowCtx as FlowContext,
          message: p.message,
        });
        break;

      case 'verifying_xmr': {
        this.setFlowContext({ extra: { text: p.message, type: 'message' } });
        const v = this.requireVerified('confirming');
        if (v) this.transition({ phase: 'confirming', snapshot: v, message: p.message });
        break;
      }

      case 'signing_psbt': {
        this.setFlowContext({ extra: { text: p.message, type: 'message' } });
        const v = this.requireVerified('signing');
        if (v) this.transition({ phase: 'signing', snapshot: v, message: p.message });
        break;
      }

      case 'funding': {
        this.setFlowContext({ extra: { text: p.message, type: 'message' } });
        const v = this.requireVerified('funding');
        if (v) this.transition({ phase: 'funding', snapshot: v, message: p.message });
        break;
      }

      case 'submit_encsig': {
        this.setFlowContext({ extra: { text: p.message, type: 'message' } });
        const v = this.requireVerified('computing-encsig');
        if (v) this.transition({ phase: 'computing-encsig', snapshot: v, message: p.message });
        break;
      }

      case 'confirming':
      case 'deposited': {
        this.setFlowContext({ extra: { text: p.message, type: 'message' } });
        const v = this.requireVerified('confirming');
        if (v) this.transition({ phase: 'confirming', snapshot: v, message: p.message });
        break;
      }

      case 'swapping':
      case 'sending': {
        this.setFlowContext({ extra: { text: p.message, type: 'message' } });
        const v = this.requireVerified('swapping');
        if (v) this.transition({ phase: 'swapping', snapshot: v, message: p.message });
        break;
      }

      case 'sweeping': {
        this.setFlowContext({ extra: { text: p.message, type: 'message' } });
        const v = this.requireVerified('sweeping');
        if (v) this.transition({ phase: 'sweeping', snapshot: v, message: p.message, sweepStep: 'get-outputs' });
        break;
      }

      case 'complete':
      case 'completed':
        this.setFlowContext({ extra: { text: 'Swap completed', type: 'message' } });
        this.hasReachedTerminal = true;
        this.transition({
          phase: 'completed',
          snapshot: this.flowCtx as FlowContext,
          outputTxHash: p.txHash ?? null,
          // Atomic swaps have no slippage; buyer receives exactly rate * deposit.
          // Fall back to expectedOut so the receipt shows the right number even
          // when the progress event doesn't carry it.
          actualOut: this.flowCtx?.expectedOut ?? '',
          durationSec: null,
        });
        break;

      case 'failed':
      case 'error':
        this.setFlowContext({ extra: { text: p.message, type: 'error' } });
        this.hasReachedTerminal = true;
        this.transition({
          phase: 'failed',
          snapshot: this.flowCtx,
          error: p.message,
        });
        break;

      case 'refunded':
        this.hasReachedTerminal = true;
        this.transition({
          phase: 'refunded',
          snapshot: this.flowCtx,
          swapId: p.swapId ?? this.flowCtx?.swapId ?? '',
          refundTxid: p.txHash ?? null,
        });
        break;

      case 'cancelled':
        this.hasReachedTerminal = true;
        this.transition({
          phase: 'cancelled',
          snapshot: this.flowCtx,
          swapId: p.swapId ?? this.flowCtx?.swapId ?? null,
          txCancelTxid: null,
        });
        break;

      case 'cancelling':
        // TxCancel in flight; refund follows. Stay watching until the row
        // settles in 'refunded' (or 'failed' if the refund never lands).
        this.setFlowContext({ extra: { text: p.message, type: 'warning' } });
        this.transition({
          phase: 'creating-swap',
          snapshot: this.flowCtx as FlowContext,
          message: p.message,
        });
        break;

      case 'withheld':
      case 'expired':
        // Both are terminal in TerminalStatus. Emit 'failed' so poll
        // consumers see a terminal transition and resolve.
        this.transition({
          phase: 'failed',
          snapshot: this.flowCtx,
          error: p.message,
        });
        break;

      case 'punished': {
        // Not terminal. Alice published TxPunish (Bob missed the refund
        // window), but the sidecar runs cooperative_xmr_redeem_after_punish
        // to recover s_a; the server then flips requiredAction to 'sweep'
        // and drive.ts finishes via the sweep branch.
        const reason =
          p.message ||
          'BTC punished — recovering XMR via cooperative_xmr_redeem_after_punish...';
        this.setFlowContext({ extra: { text: reason, type: 'warning' } });
        const verified = this.requireVerified('swapping');
        if (verified) {
          this.transition({ phase: 'swapping', snapshot: verified, message: reason });
        }
        break;
      }

      default:
        this.logger.warn({ stage: p.stage }, `Unhandled atomic progress stage: ${p.stage}`);
        break;
    }
  }

  async userCancel(): Promise<void> {
    const state = this.getCurrentAwaitingActionState();
    if (!state) return;

    const { requiredAction } = state;
    const swapId = this.flowCtx?.swapId ?? '';
    this.logger.info({ swapId, action: 'cancel', blocksRemaining: requiredAction.blocksRemaining }, 'User cancel initiated');

    if (requiredAction.blocksRemaining && requiredAction.blocksRemaining > 0) {
      this.transition({
        ...state,
        error: `TxCancel not available — ${requiredAction.blocksRemaining} blocks remaining`,
      });
      return;
    }

    this.setFlowContext({ extra: { text: 'Broadcasting TxCancel...', type: 'message' } });
    this.transition({
      phase: 'cancelling',
      snapshot: this.flowCtx as FlowContext,
      message: 'Broadcasting TxCancel...',
    });

    try {
      const result = await this.api.executeAction(swapId, { type: 'cancel' });
      this.transition({
        phase: 'cancelled',
        snapshot: this.flowCtx,
        swapId,
        txCancelTxid:
          result.protocolData && 'tx_cancel_txid' in result.protocolData
            ? (result.protocolData.tx_cancel_txid as string | null)
            : null,
      });
    } catch (err: unknown) {
      this.transition({
        ...state,
        error: `Cancel failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    this.resumeActionLoop();
  }

  async userRefund(): Promise<void> {
    const state = this.getCurrentAwaitingActionState();
    if (!state || !this.keystore) return;

    const swapId = this.flowCtx?.swapId ?? '';
    this.logger.info({ swapId, action: 'refund' }, 'User refund initiated');
    await this.executeRefund(swapId);
    this.resumeActionLoop();
  }

  async userRetrySweep(): Promise<void> {
    const swapId = this.flowCtx?.swapId ?? '';
    if (!swapId) return;
    this.logger.info({ swapId, action: 'retry-sweep' }, 'User retry sweep');
    await this.executeSweep(swapId);
  }

  private async executeSweep(swapId: string): Promise<void> {
    if (!this.keystore) {
      this.emitError('sweeping', 'Keystore not available for sweep');
      return;
    }

    this.logger.info({ swapId }, 'Starting XMR sweep');
    this.setFlowContext({ extra: { text: 'Starting XMR sweep...', type: 'message' } });
    const verified = this.requireVerified('sweeping');
    if (!verified) return;

    this.transition({
      phase: 'sweeping', snapshot: verified,
      message: 'Starting XMR sweep...', sweepStep: 'get-outputs',
    });

    try {
      const s_b_bytes = new Uint8Array(
        (this.keystore.keys.s_b.match(/.{2}/g) ?? []).map((b: string) => parseInt(b, 16)),
      );

      const freshDetail = await this.api.getSwapDetail(swapId);
      const pp =
        freshDetail.protocolData?.type === 'atomicswap'
          ? freshDetail.protocolData.params
          : null;
      if (!pp?.S_a_monero) {
        throw new ProtocolError(
          'E_PROTOCOL_PARAMS_MISSING',
          'sweep requires S_a_monero in protocol params',
        );
      }

      const result = await sweepMonero(this.api, {
        swapId, s_b: s_b_bytes,
        receiveAddress: this.keystore.swap.receiveAddress,
        expectedSAMonero: pp.S_a_monero,
        monerodNodes: this.config.monerodNodes,
        onProgress: (stage: string) => {
          const sweepStep = stage.includes('key') ? 'key-images'
            : stage.includes('submit') || stage.includes('broadcast') ? 'broadcasting'
            : stage.includes('sign') ? 'submitting' : 'get-outputs';
          this.setFlowContext({ extra: { text: stage, type: 'message' } });
          const v = this.requireVerified('sweeping');
          if (v) this.transition({
            phase: 'sweeping', snapshot: v, message: stage,
            sweepStep: sweepStep as AtomicSweepingPhase['sweepStep'],
          });
        },
      });

      const amountXmr = result.amount !== 'unknown'
        ? (Number(result.amount) / 1e12).toFixed(12).replace(/\.?0+$/, '') : '';

      this.logger.info({ swapId, txHash: result.txHash, amountXmr }, 'Sweep completed');
      this.setFlowContext({ extra: { text: 'Sweep complete', type: 'message' } });
      this.transition({
        phase: 'completed', snapshot: this.flowCtx as FlowContext,
        outputTxHash: result.txHash, actualOut: amountXmr, durationSec: null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ swapId, error: msg }, 'Sweep failed');
      if (msg.includes("'completed'") || msg.includes('"completed"')) {
        try {
          const detail = await this.api.getSwapDetail(swapId);
          this.emitTerminal(swapId, 'completed', detail);
          return;
        } catch { /* fall through */ }
      }
      this.setFlowContext({ extra: { text: `Sweep failed: ${msg}. Press w to retry.`, type: 'error' } });
      this.transition({
        phase: 'failed', snapshot: this.flowCtx, error: `Sweep failed: ${msg}. Press w to retry.`,
      });
    }
  }

  private async executeRefund(swapId: string): Promise<void> {
    if (!this.keystore) {
      this.emitError('refunding', 'Keystore not available for refund');
      return;
    }

    this.logger.info({ swapId }, 'Starting client-side refund');

    const detail = await this.api.getSwapDetail(swapId).catch(() => null);
    if (!detail) {
      this.emitError('refunding', 'Could not fetch swap detail for refund');
      return;
    }

    const lockAddress = this.resolveLockAddress(detail);
    if (!lockAddress) {
      this.logger.error({ swapId }, 'Cannot determine lock address for refund');
      this.setFlowContext({
        extra: {
          text: 'Cannot determine lock address — unable to verify TxCancel',
          type: 'error',
        },
      });
      this.transition({
        phase: 'failed',
        snapshot: this.flowCtx,
        error: 'Cannot determine lock address — unable to verify TxCancel',
      });
      return;
    }

    const protocolParams = await this.resolveProtocolParams(swapId, detail);
    if (!protocolParams) {
      this.emitRefundAborted(
        swapId,
        'Server did not return protocol params and no local cache available — cannot build refund',
      );
      return;
    }
    if (!hasRefundEscapeHatch(protocolParams)) {
      this.emitRefundAborted(
        swapId,
        'No refund encsig in protocol params (need either tx_full_refund_encsig, or tx_partial_refund_encsig with the amnesty triple) — cannot construct refund',
      );
      return;
    }

    this.logger.info({ swapId, lockAddress }, 'Verifying TxCancel on-chain');
    this.setFlowContext({ extra: { text: 'Verifying TxCancel on-chain...', type: 'message' } });
    this.transition({
      phase: 'verifying-cancel',
      snapshot: this.flowCtx as FlowContext,
      message: 'Verifying TxCancel on-chain...',
    });

    const blockchain = await this.platform.createBlockchainProvider(this.config.network);
    const verification = await discoverAndVerifyTxCancel(
      blockchain,
      lockAddress,
      detail.depositTxHash ?? '',
      this.config.network,
    );

    if (!verification.verified || !verification.txCancelHex) {
      this.logger.error(
        { swapId, reason: verification.reason },
        'TxCancel verification failed — refund aborted',
      );
      const reason = verification.reason || 'TxCancel not verified';
      this.setFlowContext({ extra: { text: `REFUSED: ${reason}. Refund aborted.`, type: 'error' } });
      this.transition({
        phase: 'failed',
        snapshot: this.flowCtx,
        error: `REFUSED: ${reason}. Refund aborted.`,
      });
      return;
    }

    this.logger.info(
      { swapId, reason: verification.reason },
      'TxCancel verified — assembling refund locally',
    );
    this.setFlowContext({
      extra: { text: 'TxCancel confirmed. Signing refund locally...', type: 'message' },
    });
    this.transition({
      phase: 'refunding',
      snapshot: this.flowCtx as FlowContext,
      message: 'TxCancel confirmed. Signing refund locally...',
    });

    await ensureWasm();

    const useAmnesty =
      protocolParams.tx_partial_refund_encsig !== undefined &&
      protocolParams.amnesty_amount_sats !== undefined &&
      protocolParams.tx_partial_refund_fee_sats !== undefined;

    const aPubHex = protocolParams.A;
    const bPubHex = this.keystore.keys.B;
    const witnessScript = buildMultisigWitnessScript(aPubHex, bPubHex);
    const refundAddress = this.keystore.swap.refundAddress;

    let txRefundHex: string;
    let cancelOutputValueSats: bigint;
    let encsigRefund: string;

    if (useAmnesty) {
      const built = buildPartialRefund({
        txCancelHex: verification.txCancelHex,
        refundAddress,
        refundFeeSats: BigInt(protocolParams.tx_partial_refund_fee_sats ?? 0),
        network: this.config.network,
        amnestyAmountSats: BigInt(protocolParams.amnesty_amount_sats ?? 0),
        partialRefundFeeSats: BigInt(protocolParams.tx_partial_refund_fee_sats ?? 0),
        aPubHex,
        bPubHex,
      });
      txRefundHex = built.txRefundHex;
      cancelOutputValueSats = built.cancelOutputValueSats;
      encsigRefund = protocolParams.tx_partial_refund_encsig ?? '';
    } else {
      const built = buildFullRefund({
        txCancelHex: verification.txCancelHex,
        refundAddress,
        refundFeeSats: BigInt(protocolParams.tx_refund_fee_sats),
        network: this.config.network,
      });
      txRefundHex = built.txRefundHex;
      cancelOutputValueSats = built.cancelOutputValueSats;
      encsigRefund = protocolParams.tx_full_refund_encsig ?? '';
    }

    let assembled: ReturnType<typeof signRefund>;
    try {
      assembled = signRefund({
        txRefundHex,
        witnessScript,
        txCancelOutputValueSats: cancelOutputValueSats,
        encsigRefund,
        sBHexLE: this.keystore.keys.s_b,
        bHex: this.keystore.keys.b,
        aPubHex,
        bPubHex,
        sBPubHex: this.keystore.keys.S_b_bitcoin,
        logger: this.logger,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ swapId, error: msg }, 'Refund assembly failed');
      this.setFlowContext({ extra: { text: `Refund failed: ${msg}`, type: 'error' } });
      this.transition({ phase: 'failed', snapshot: this.flowCtx, error: `Refund failed: ${msg}` });
      return;
    }

    this.logger.info(
      { swapId, txid: assembled.txid },
      'Broadcasting client-signed refund',
    );
    let broadcastTxid: string;
    try {
      broadcastTxid = await blockchain.broadcastTransaction(assembled.hex);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already in mempool|already exists|already known/i.test(msg)) {
        this.logger.warn({ swapId, txid: assembled.txid }, 'Refund already broadcast; continuing');
        broadcastTxid = assembled.txid;
      } else {
        this.logger.error({ swapId, error: msg }, 'Refund broadcast failed');
        this.setFlowContext({
          extra: { text: `Refund broadcast failed: ${msg}`, type: 'error' },
        });
        this.transition({
          phase: 'failed',
          snapshot: this.flowCtx,
          error: `Refund broadcast failed: ${msg}`,
        });
        return;
      }
    }

    try {
      await this.api.executeAction(swapId, {
        type: 'notify-refund',
        refund_txid: broadcastTxid,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { swapId, txid: broadcastTxid, error: msg },
        'notify-refund server call failed; refund tx is on-chain — continuing',
      );
    }

    this.logger.info(
      { swapId, refundTxid: broadcastTxid },
      'Client-side refund broadcast successful',
    );
    this.transition({
      phase: 'refunded',
      snapshot: this.flowCtx,
      swapId,
      refundTxid: broadcastTxid,
    });
  }

  private resolveLockAddress(detail: SwapDetail): string {
    if (detail.depositAddress) return detail.depositAddress;
    const v = detail.verification;
    if (v && typeof v === 'object' && 'lock_address' in v) {
      const candidate = (v as { lock_address?: unknown }).lock_address;
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
    return '';
  }

  // Server response first; fall back to the platform adapter's optional
  // write-through cache when the server omitted the refund encsig. On a
  // good server response, prime the cache so later refunds survive a brief
  // backend outage.
  private async resolveProtocolParams(
    swapId: string,
    detail: SwapDetail,
  ): Promise<ProtocolParams | null> {
    const fromServer = extractProtocolData(detail).params;
    if (fromServer && hasRefundEscapeHatch(fromServer)) {
      await this.cacheProtocolParams(swapId, fromServer);
      return fromServer;
    }

    const loadFn = this.platform.loadSwapProtocol;
    if (loadFn) {
      try {
        const cached = await loadFn(swapId);
        if (cached && hasRefundEscapeHatch(cached)) {
          this.logger.info(
            { swapId },
            'Server omitted refund encsig — loaded from local protocol cache',
          );
          return cached;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          { swapId, error: msg },
          'Local protocol cache read failed — proceeding with server response',
        );
      }
    }

    return fromServer;
  }

  private async cacheProtocolParams(
    swapId: string,
    params: ProtocolParams,
  ): Promise<void> {
    const saveFn = this.platform.saveSwapProtocol;
    if (!saveFn) return;
    try {
      await saveFn(swapId, params);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { swapId, error: msg },
        'Failed to cache protocol params — refund still works via server',
      );
    }
  }

  private emitRefundAborted(swapId: string, reason: string): void {
    this.logger.error({ swapId, reason }, 'Refund aborted');
    this.setFlowContext({ extra: { text: `REFUSED: ${reason}`, type: 'error' } });
    this.transition({
      phase: 'failed',
      snapshot: this.flowCtx,
      error: `REFUSED: ${reason}`,
    });
  }

  private async pollUntilTerminal(swapId: string): Promise<void> {
    while (!this.signal.aborted) {
      try {
        const detail = await this.api.getSwapDetail(swapId);
        if (TERMINAL_STATUSES.has(detail.status)) {
          this.emitTerminal(swapId, detail.status, detail);
          return;
        }

        // Prime the protocol cache while the server is up; the refund path
        // falls back to it if the server goes down later.
        const polledParams = extractProtocolData(detail).params;
        if (polledParams?.tx_full_refund_encsig) {
          await this.cacheProtocolParams(swapId, polledParams);
        }

        // 'refund' flip means TxCancel confirmed and the refund window is
        // open. Auto-trigger so we don't drift toward the punish deadline.
        const action = detail.requiredAction ?? null;
        if (action?.type === 'refund') {
          this.logger.info(
            { swapId, blocksRemaining: action.blocksRemaining ?? null },
            'Required action flipped to refund — auto-triggering client-side refund',
          );
          await this.executeRefund(swapId);
          return;
        }

        if (action?.type === 'sweep') {
          this.logger.info({ swapId }, 'Required action flipped to sweep — auto-triggering sweep');
          await this.executeSweep(swapId);
          return;
        }
      } catch { /* retry */ }
      await delay(this.pollMs, this.signal).catch(() => {});
      if (this.signal.aborted) return;
    }
  }

  private emitTerminal(swapId: string, status: string, detail?: SwapDetail): void {
    this.setFlowContext({ swapId, swapNumber: detail?.swapNumber ?? null });
    if (status === 'completed') {
      this.setFlowContext({ extra: { text: 'Swap completed', type: 'message' } });
      this.transition({
        phase: 'completed', snapshot: this.flowCtx as FlowContext,
        outputTxHash: detail?.outputTxHash ?? null,
        actualOut: detail?.actualAmountOut ?? '', durationSec: detail?.durationSeconds ?? null,
      });
    } else if (status === 'refunded') {
      this.transition({
        phase: 'refunded', snapshot: this.flowCtx, swapId,
        refundTxid: detail?.refundTxHash ?? null,
      });
    } else {
      this.setFlowContext({ extra: { text: `Swap ended: ${status}`, type: 'error' } });
      this.transition({
        phase: 'failed', snapshot: this.flowCtx, error: `Swap ended: ${status}`,
      });
    }
  }

  private resumeActionLoop(): void {
    this.userActionResolver?.();
    this.userActionResolver = null;
  }

  private checkAborted(): void {
    if (this.signal.aborted) throw new SwapCancelledError();
  }

  private handleError(err: unknown): void {
    if (err instanceof SwapCancelledError || this.signal.aborted) {
      this.logger.info({ swapId: this.flowCtx?.swapId ?? null }, 'AtomicFlow cancelled');
      this.transition({ phase: 'cancelled', snapshot: this.flowCtx, swapId: null, txCancelTxid: null });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error({ swapId: this.flowCtx?.swapId ?? null, error: message }, 'AtomicFlow error');
    this.setFlowContext({ extra: { text: message, type: 'error' } });
    this.transition({
      phase: 'failed', snapshot: this.flowCtx,
      error: message,
    });
  }

  private getCurrentAwaitingActionState(): (AtomicFlowState & { phase: 'awaiting-user-action' }) | null {
    if (this.lastEmittedState.phase === 'awaiting-user-action') return this.lastEmittedState;
    return null;
  }
}

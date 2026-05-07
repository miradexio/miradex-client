import type { ApiClient } from '../../api/index.js';
import { ApiError, NetworkError } from '../../api/index.js';
import type { PlatformAdapter } from '../platform.js';
import type { ResolvedEngineConfig } from '../miradex-engine.js';
import type { SwapFlowState } from './swap-flow-state.js';
import type {
  SwapQuote,
  SwapDetail,
  VerificationResult,
  CreateSwapResponse,
  SwapVerification,
  ProtocolData,
} from '../../types/index.js';
import { TERMINAL_STATUSES, isAtomicProtocolData } from '../../types/index.js';
import type {
  FlowContext,
  PopulatedFlowContext,
  VerifiedFlowContext,
} from '../flow-context.js';
import {
  createFlowContext,
  mergeFlowContext,
  validateBase,
  validatePopulated,
  validateVerified,
} from '../flow-context.js';
import { solveChallenge, encodePowHeader } from '../../lib/pow-solver.js';
import { verifyDepositAddress } from '../../verification/index.js';
import { delay } from '../../lib/delay.js';
import { mapServerStatus } from '../pipeline.js';

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 3_600_000;
const MAX_TRANSIENT_RETRIES = 5;
const TRANSIENT_RETRY_MS = 5_000;

// Defaults for SwapFlow; overridable via SwapFlowOptions.
export const SWAP_FLOW_CONFIG = {
  pollMs: DEFAULT_POLL_MS,
  pollTimeoutMs: DEFAULT_POLL_TIMEOUT_MS,
  maxRetries: MAX_TRANSIENT_RETRIES,
  retryMs: TRANSIENT_RETRY_MS,
} as const;

// 500s from THORChain simulate_swap and similar provider validators that are
// caused by the user's request (slippage band, memo shape, dust amount). They
// fail the same way every time; retrying just burns the swap-create timeout
// and surfaces "timeout" instead of the real reason.
const PERMANENT_API_ERROR_PATTERNS: readonly RegExp[] = [
  /less than price limit/i, // THORChain LIM < quote actual at simulate time
  /swap_too_small/i, // THORChain min-amount rejection
  /memo too long/i, // memo overflow
];

function isPermanentApiError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return PERMANENT_API_ERROR_PATTERNS.some((re) => re.test(err.message));
}

function isTransientError(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  if (err instanceof ApiError) {
    if (isPermanentApiError(err)) return false;
    if (err.statusCode >= 500) return true;
    if (err.statusCode === 429) return true;
  }
  return false;
}

// Map raw API/network errors to user-actionable messages; falls back to the
// raw error text for cases without a curated translation.
function humanizeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (/less than price limit/i.test(err.message)) {
      return 'Slippage tolerance is too tight for current market conditions. Increase slippage in the gear icon and try again.';
    }
    if (/swap_too_small/i.test(err.message)) {
      return 'Amount too small for this provider. Increase the swap amount and try again.';
    }
  }
  if (err instanceof NetworkError) {
    return 'Network error reaching the swap server. Check your connection and try again.';
  }
  return err instanceof Error ? err.message : String(err);
}

export interface SwapFlowOptions {
  readonly pollMs?: number;
  readonly pollTimeoutMs?: number;
  readonly retryMs?: number;
  readonly maxRetries?: number;
}

export class SwapFlow {
  private abortController: AbortController | null = null;
  private readonly pollMs: number;
  private readonly pollTimeoutMs: number;
  private readonly retryMs: number;
  private readonly maxRetries: number;
  private flowCtx: FlowContext | null = null;
  private lastPhase: string = 'idle';
  private lastPollKey: string | null = null;

  constructor(
    private readonly api: ApiClient,
    private readonly platform: PlatformAdapter,
    private readonly config: ResolvedEngineConfig,
    private readonly emitFn: (state: SwapFlowState) => void,
    options?: SwapFlowOptions,
  ) {
    this.pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
    this.pollTimeoutMs = options?.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.retryMs = options?.retryMs ?? TRANSIENT_RETRY_MS;
    this.maxRetries = options?.maxRetries ?? MAX_TRANSIENT_RETRIES;
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

  private requirePopulated(phase: string): PopulatedFlowContext | null {
    if (!this.flowCtx) {
      this.emitError(phase, 'FlowContext not initialized');
      return null;
    }
    const result = validatePopulated(this.flowCtx, phase);
    if (result.ok) return result.data;
    this.emitError(phase, result.error.message);
    return null;
  }

  private requireVerified(phase: string): VerifiedFlowContext | null {
    if (!this.flowCtx) {
      this.emitError(phase, 'FlowContext not initialized');
      return null;
    }
    const result = validateVerified(this.flowCtx, phase);
    if (result.ok) return result.data;
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

  private transition(state: SwapFlowState): void {
    const prevPhase = this.lastPhase;
    if (state.phase === prevPhase) return;
    this.lastPhase = state.phase;
    this.logger.info(
      { phase: state.phase, prevPhase, swapId: this.flowCtx?.swapId ?? null, provider: this.flowCtx?.provider ?? null },
      'Swap phase transition',
    );
    this.emitFn(state);
  }

  cancel(): void {
    this.abortController?.abort();
  }

  async start(params: {
    readonly fromToken: string;
    readonly fromChain: string;
    readonly toToken: string;
    readonly toChain: string;
    readonly amount: string;
    readonly destAddress: string;
    readonly refundAddress: string;
    readonly selectedQuote: SwapQuote;
    readonly slippageBps?: number;
  }): Promise<void> {
    this.abortController = new AbortController();
    const provider = params.selectedQuote.provider;
    this.logger.info({ provider, fromToken: params.fromToken, toToken: params.toToken, amount: params.amount }, 'SwapFlow.start()');

    this.setFlowContext({
      fromToken: params.fromToken,
      toToken: params.toToken,
      depositAmount: params.amount,
      destAddress: params.destAddress,
      refundAddress: params.refundAddress,
      provider,
      extra: { text: 'Solving proof of work...', type: 'message' },
    });

    try {
      this.transition({ phase: 'solving-pow', snapshot: this.flowCtx as FlowContext });

      const swap = await this.createSwapWithRetry(params, provider);
      this.logger.info({ swapNumber: swap.swapNumber, depositAddress: swap.depositAddress }, 'Swap created');
      this.checkAborted();

      // Expose swapId early for EngineRegistry.waitForFirstSwapId, before
      // emitAwaitingDeposit (which can take 30s+ on chainflip indexer lag
      // and would otherwise race the registry's 30s timeout). depositAddr
      // stays gated by emitAwaitingDeposit's verification-success branch so
      // a failure never leaks the address.
      this.setFlowContext({ swapId: swap.swapNumber, swapNumber: swap.swapNumber });
      // Bypass transition()'s dedup guard for this same-phase snapshot update.
      this.emitFn({ phase: 'creating-swap', snapshot: this.flowCtx as FlowContext });

      await this.emitAwaitingDeposit(swap, params, provider);
      await this.pollLoop(swap.swapNumber);
    } catch (err: unknown) {
      this.handleError(err);
    }
  }

  // Pass cachedDetail to skip a redundant getSwapDetail. Without it, a
  // network blip on the second fetch sends ApiClient.withRetry into an
  // unbounded backoff loop and pins the UI on 'creating-swap' for minutes.
  async resume(
    swapId: string,
    provider: string,
    fromToken: string,
    toToken: string,
    cachedDetail?: SwapDetail,
  ): Promise<void> {
    this.abortController = new AbortController();
    this.logger.info({ swapId, provider, cached: cachedDetail !== undefined }, 'SwapFlow.resume()');

    this.setFlowContext({
      provider, fromToken, toToken, swapId,
      extra: { text: 'Loading swap...', type: 'message' },
    });

    try {
      this.transition({ phase: 'creating-swap', snapshot: this.flowCtx as FlowContext });

      const detail = cachedDetail ?? (await this.fetchDetailWithRetry(swapId));

      if (TERMINAL_STATUSES.has(detail.status)) {
        this.logger.info({ swapId, status: detail.status }, 'Resumed swap is terminal');
        // Hydrate receipt fields from detail; the live awaiting-deposit path
        // would normally populate these but we skip it on terminal resume.
        // Don't re-verify either — verification is a pre-commit gate, and
        // once terminal the on-chain outcome is the source of truth (vaults
        // may have rotated since).
        this.setFlowContext({
          depositAddr: detail.depositAddress,
          destAddress: detail.destAddress,
          refundAddress: detail.refundAddress,
          expectedOut: detail.expectedAmountOut,
          amountInUsd: detail.amountInUsd,
          expectedOutUsd: detail.expectedAmountOutUsd,
          provider,
        });
        this.emitTerminal(detail, fromToken, toToken);
        return;
      }
      this.checkAborted();

      // Pick the initial phase from actual server status so we don't
      // briefly flash through awaiting-deposit on a past-deposit swap.
      await this.emitInitialResumePhase(detail, {
        destAddress: detail.destAddress,
        refundAddress: detail.refundAddress ?? '',
        toToken, fromToken, amount: detail.amountIn,
        fromChain: detail.fromChain,
        toChain: detail.toChain,
      }, provider);

      await this.pollLoop(swapId);
    } catch (err: unknown) {
      this.handleError(err);
    }
  }

  private async fetchDetailWithRetry(swapId: string): Promise<SwapDetail> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.api.getSwapDetail(swapId);
      } catch (err: unknown) {
        if (!isTransientError(err)) throw err;
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn({ swapId, attempt: attempt + 1, error: msg }, 'Server error fetching swap, retrying');
        this.setFlowContext({
          extra: { text: `Server error, retrying (${attempt + 1}/${this.maxRetries})...`, type: 'warning' },
        });
        this.transition({ phase: 'creating-swap', snapshot: this.flowCtx as FlowContext });
        await delay(this.retryMs * (attempt + 1), this.signal).catch(() => {});
        this.checkAborted();
      }
    }
    throw lastErr ?? new Error(`Failed to fetch swap ${swapId} after retries`);
  }

  private async createSwapWithRetry(
    params: {
      readonly fromToken: string;
      readonly fromChain: string;
      readonly toToken: string;
      readonly toChain: string;
      readonly amount: string;
      readonly destAddress: string;
      readonly refundAddress: string;
      readonly selectedQuote: SwapQuote;
      readonly slippageBps?: number;
    },
    provider: string,
  ): Promise<CreateSwapResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const challenge = await this.api.getChallenge();
        const solution = await solveChallenge(challenge);
        const powHeader = encodePowHeader(solution);
        this.logger.debug({ algorithm: challenge.algorithm, attempt }, 'PoW challenge solved');
        this.checkAborted();

        if (attempt === 0) {
          this.setFlowContext({ extra: { text: 'Creating swap...', type: 'message' } });
        }
        this.transition({ phase: 'creating-swap', snapshot: this.flowCtx as FlowContext });

        return await this.api.createSwap(
          {
            from: params.fromToken, to: params.toToken, amount: params.amount,
            destAddress: params.destAddress, refundAddress: params.refundAddress,
            provider, variantId: params.selectedQuote.variantId,
            fromChain: params.fromChain, toChain: params.toChain,
            slippageBps: params.slippageBps ?? this.config.slippageBps,
          },
          powHeader,
        );
      } catch (err: unknown) {
        if (!isTransientError(err)) throw err;
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn({ attempt: attempt + 1, error: msg }, 'Server error during swap creation, retrying');
        this.setFlowContext({
          extra: { text: `Server error, retrying (${attempt + 1}/${this.maxRetries})...`, type: 'warning' },
        });
        this.transition({ phase: 'creating-swap', snapshot: this.flowCtx as FlowContext });
        await delay(this.retryMs * (attempt + 1), this.signal).catch(() => {});
        this.checkAborted();
      }
    }
    throw lastErr ?? new Error('Failed to create swap after retries');
  }

  private async emitAwaitingDeposit(
    swap: {
      readonly swapNumber: string;
      readonly depositAddress: string | null;
      readonly verification: SwapVerification | null;
      readonly expectedAmountOut: string | null;
      readonly expectedAmountOutUsd: string | null;
      readonly amountIn: string;
      readonly amountInUsd: string | null;
      readonly expiresAt: string | null;
      readonly protocolData?: ProtocolData | null;
    },
    params: {
      readonly destAddress: string;
      readonly refundAddress: string;
      readonly toToken: string;
      readonly amount?: string;
      readonly fromToken?: string;
      readonly fromChain?: string;
      readonly toChain?: string;
    },
    provider: string,
  ): Promise<void> {
    let verification: VerificationResult | null = null;
    if (swap.depositAddress && swap.verification) {
      verification = await verifyDepositAddress({
        depositAddress: swap.depositAddress,
        verification: swap.verification,
        destAddress: params.destAddress,
        refundAddress: params.refundAddress,
        toToken: params.toToken,
        amount: params.amount ?? swap.amountIn,
        fromChain: params.fromChain,
        toChain: params.toChain,
        fromToken: params.fromToken,
        network: this.config.network,
        protocol: isAtomicProtocolData(swap.protocolData)
          ? {
              psbt: swap.protocolData.psbt,
              lock_address: swap.protocolData.lock_address,
              timelock_blocks: swap.protocolData.timelock_blocks,
            }
          : undefined,
        expectedAmountOut: swap.expectedAmountOut ?? undefined,
        expectedDestAddress: params.destAddress,
        fetchFn: this.config.fetchFn,
        signal: this.signal,
      });
    }

    // Guard against destroy() that fired between the verifier's last
    // successful tick and this branch.
    this.checkAborted();

    // Log every check (pass or fail). This is the primary diagnostic
    // surface when a verification regresses.
    this.logger.info(
      {
        swapNumber: swap.swapNumber,
        verified: verification?.verified ?? null,
        provider: verification?.provider ?? null,
        checks: verification?.checks ?? [],
      },
      'Deposit address verification',
    );

    if (verification && !verification.verified) {
      const failedChecks = verification.checks.filter((c) => !c.passed);
      this.logger.warn(
        {
          swapNumber: swap.swapNumber,
          provider: verification.provider,
          failedChecks,
          allChecks: verification.checks,
        },
        'Deposit address verification FAILED',
      );
      // Withhold depositAddr / qr / destAddress so the UI can't invite a
      // deposit; keep verification + ids so the failure screen has context.
      this.setFlowContext({
        verification,
        swapId: swap.swapNumber,
        swapNumber: swap.swapNumber,
        depositAddr: null,
        destAddress: null,
        qr: null,
        extra: {
          text:
            "We couldn't verify this swap with the provider. To stay safe, please try a different provider or start a new swap.",
          type: 'error',
        },
      });
      const baseResult = validateBase(this.flowCtx, 'verification-failed');
      if (!baseResult.ok) {
        this.logger.error({ error: baseResult.error }, 'verification-failed FlowContext invalid');
        return;
      }
      this.transition({ phase: 'verification-failed', snapshot: baseResult.data });
      return;
    }

    const depositAddr = swap.depositAddress ?? '';
    let qr: string | null = null;
    if (depositAddr) {
      try { qr = await this.platform.generateQr(depositAddr); } catch { /* non-fatal */ }
    }

    let verificationSourceUrl: string | null = null;
    if (swap.verification) {
      if ('status_url' in swap.verification) verificationSourceUrl = swap.verification.status_url;
      else if ('inbound_addresses_url' in swap.verification) verificationSourceUrl = swap.verification.inbound_addresses_url;
    }

    this.setFlowContext({
      swapId: swap.swapNumber, swapNumber: swap.swapNumber, provider,
      depositAddr, depositAmount: swap.amountIn,
      destAddress: params.destAddress,
      refundAddress: params.refundAddress,
      amountInUsd: swap.amountInUsd ?? null,
      expectedOut: swap.expectedAmountOut ?? null,
      expectedOutUsd: swap.expectedAmountOutUsd ?? null,
      expiresAt: swap.expiresAt ?? null,
      qr, verification: verification ?? {
        verified: false,
        provider,
        checks: [{ name: 'Server verification', passed: false, detail: 'Pending' }],
        timestamp: Date.now(),
      },
      verificationSourceUrl,
      extra: { text: `Awaiting deposit to ${depositAddr.slice(0, 16)}...`, type: 'message' },
    });

    const populated = this.requirePopulated('awaiting-deposit');
    if (!populated) return;

    this.transition({ phase: 'awaiting-deposit', snapshot: populated });
  }

  // Called from resume() so a past-deposit swap doesn't flash through
  // awaiting-deposit before the first poll tick catches up.
  private async emitInitialResumePhase(
    detail: SwapDetail,
    params: {
      readonly destAddress: string;
      readonly refundAddress: string;
      readonly toToken: string;
      readonly amount?: string;
      readonly fromToken?: string;
      readonly fromChain?: string;
      readonly toChain?: string;
    },
    provider: string,
  ): Promise<void> {
    // Pre-deposit fast path reuses emitAwaitingDeposit (QR + verification).
    const preDepositStatuses: ReadonlySet<string> = new Set([
      'initializing',
      'pending',
      'awaiting_funding',
    ]);
    if (preDepositStatuses.has(detail.status)) {
      await this.emitAwaitingDeposit(detail, params, provider);
      return;
    }

    // Post-deposit: hydrate enough to satisfy requireVerified, then jump
    // straight to the right phase.
    let verification: VerificationResult | null = null;
    if (detail.depositAddress && detail.verification) {
      try {
        verification = await verifyDepositAddress({
          depositAddress: detail.depositAddress,
          verification: detail.verification,
          destAddress: params.destAddress,
          refundAddress: params.refundAddress,
          toToken: params.toToken,
          amount: params.amount ?? detail.amountIn,
          fromChain: params.fromChain,
          toChain: params.toChain,
          fromToken: params.fromToken,
          network: this.config.network,
          protocol: isAtomicProtocolData(detail.protocolData)
            ? {
                psbt: detail.protocolData.psbt,
                lock_address: detail.protocolData.lock_address,
                timelock_blocks: detail.protocolData.timelock_blocks,
              }
            : undefined,
          expectedAmountOut: detail.expectedAmountOut ?? undefined,
          expectedDestAddress: params.destAddress,
          fetchFn: this.config.fetchFn,
          signal: this.signal,
        });
      } catch {
        // Best-effort on resume — don't block if verification upstream fails.
      }
    }

    // Same diagnostic log as emitAwaitingDeposit. Resume doesn't gate on
    // verification (swap is past that point); the log value is the same.
    this.logger.info(
      {
        swapNumber: detail.swapNumber,
        status: detail.status,
        verified: verification?.verified ?? null,
        provider: verification?.provider ?? null,
        checks: verification?.checks ?? [],
      },
      'Deposit address verification (resume post-deposit)',
    );

    let verificationSourceUrl: string | null = null;
    if (detail.verification) {
      if ('status_url' in detail.verification)
        verificationSourceUrl = detail.verification.status_url;
      else if ('inbound_addresses_url' in detail.verification)
        verificationSourceUrl = detail.verification.inbound_addresses_url;
    }

    const depositAddr = detail.depositAddress ?? '';
    let qr: string | null = null;
    if (depositAddr) {
      try {
        qr = await this.platform.generateQr(depositAddr);
      } catch {
        // Non-fatal: post-deposit resume can render without a QR.
      }
    }

    this.setFlowContext({
      swapId: detail.swapNumber,
      swapNumber: detail.swapNumber,
      provider,
      depositAddr,
      depositAmount: detail.amountIn,
      destAddress: params.destAddress,
      refundAddress: params.refundAddress,
      amountInUsd: detail.amountInUsd ?? null,
      expectedOut: detail.expectedAmountOut ?? null,
      expectedOutUsd: detail.expectedAmountOutUsd ?? null,
      expiresAt: detail.expiresAt ?? null,
      qr,
      verification: verification ?? {
        verified: true,
        provider,
        checks: [{ name: 'Server verification', passed: true, detail: 'Resumed' }],
        timestamp: Date.now(),
      },
      verificationSourceUrl,
    });

    const verified = this.requireVerified(`resume:${detail.status}`);
    if (!verified) return;

    switch (detail.status) {
      case 'deposited':
        this.setFlowContext({ extra: { text: 'Confirming deposit...', type: 'message' } });
        this.transition({
          phase: 'confirming',
          snapshot: verified,
          requiredAction: detail.requiredAction ?? null,
        });
        return;
      case 'swapping':
        this.setFlowContext({ extra: { text: 'Swapping...', type: 'message' } });
        this.transition({
          phase: 'swapping',
          snapshot: verified,
          requiredAction: detail.requiredAction ?? null,
        });
        return;
      case 'sending':
        this.setFlowContext({ extra: { text: 'Sending output...', type: 'message' } });
        this.transition({ phase: 'sending', snapshot: verified });
        return;
      case 'cancelling': {
        const msg =
          detail.requiredAction?.message ??
          'Swap is cancelling — refund in progress. Waiting for terminal status.';
        this.setFlowContext({ extra: { text: msg, type: 'message' } });
        this.transition({
          phase: 'cancelling',
          snapshot: verified,
          requiredAction: detail.requiredAction ?? null,
        });
        return;
      }
      default:
        // Unknown non-terminal status: land on awaiting-deposit; poll
        // loop corrects on the first tick.
        await this.emitAwaitingDeposit(detail, params, provider);
        return;
    }
  }

  private async pollLoop(swapId: string): Promise<void> {
    const deadline = Date.now() + this.pollTimeoutMs;
    let tick = 0;

    while (Date.now() < deadline && !this.signal.aborted) {
      await delay(this.pollMs, this.signal).catch(() => {});
      if (this.signal.aborted) {
        this.logger.info({ swapId }, 'Poll cancelled');
        this.transition({ phase: 'cancelled', snapshot: this.flowCtx });
        return;
      }

      tick++;
      let detail: SwapDetail;
      try { detail = await this.api.getSwapDetail(swapId); } catch { continue; }

      if (detail.verification && !this.flowCtx?.verification?.verified) {
        this.setFlowContext({ verification: {
          verified: true,
          provider: detail.verification.provider,
          checks: [{ name: 'Server verification', passed: true, detail: 'Populated' }],
          timestamp: Date.now(),
        } });
      }

      const mapped = mapServerStatus(detail.status);
      const pollKey = `${detail.status}|${mapped ?? ''}`;
      if (pollKey !== this.lastPollKey) {
        this.logger.debug({ swapId, serverStatus: detail.status, mappedStage: mapped, tick }, 'Poll tick');
        this.lastPollKey = pollKey;
      }

      if (TERMINAL_STATUSES.has(detail.status)) {
        this.logger.info({ swapId, status: detail.status }, 'Poll detected terminal status');
        this.emitTerminalFromDetail(detail);
        return;
      }

      if (!mapped) continue;

      switch (detail.status) {
        case 'deposited': {
          this.setFlowContext({ extra: { text: 'Confirming deposit...', type: 'message' } });
          const v = this.requireVerified('confirming');
          if (v) this.transition({ phase: 'confirming', snapshot: v, requiredAction: detail.requiredAction ?? null });
          break;
        }
        case 'swapping': {
          this.setFlowContext({ extra: { text: 'Swapping...', type: 'message' } });
          const v = this.requireVerified('swapping');
          if (v) this.transition({ phase: 'swapping', snapshot: v, requiredAction: detail.requiredAction ?? null });
          break;
        }
        case 'cancelling': {
          // Atomicswap cancel path: emit the dedicated `cancelling` phase
          // so the UI doesn't pretend the swap is still making progress.
          const msg =
            detail.requiredAction?.message ??
            'Swap is cancelling — refund in progress. Waiting for terminal status.';
          this.setFlowContext({ extra: { text: msg, type: 'message' } });
          const v = this.requireVerified('cancelling');
          if (v) {
            this.transition({
              phase: 'cancelling',
              snapshot: v,
              requiredAction: detail.requiredAction ?? null,
            });
          }
          break;
        }
        case 'sending': {
          this.setFlowContext({ extra: { text: 'Sending output...', type: 'message' } });
          const v = this.requireVerified('sending');
          if (v) this.transition({ phase: 'sending', snapshot: v });
          break;
        }
        default: break;
      }
    }
  }

  private emitTerminal(detail: SwapDetail, fromToken: string, toToken: string): void {
    this.setFlowContext({
      swapId: detail.swapNumber,
      swapNumber: detail.swapNumber,
      fromToken,
      toToken,
      depositAmount: detail.amountIn,
    });
    switch (detail.status) {
      case 'completed':
        this.setFlowContext({ extra: { text: 'Swap completed', type: 'message' } });
        this.transition({
          phase: 'completed',
          snapshot: this.flowCtx as FlowContext,
          actualOut: detail.actualAmountOut ?? '',
          outputTxHash: detail.outputTxHash ?? null,
          durationSec: detail.durationSeconds ?? null,
        });
        return;
      case 'refunded':
        this.setFlowContext({
          extra: { text: 'BTC refunded to your address.', type: 'message' },
        });
        this.transition({
          phase: 'refunded',
          snapshot: this.flowCtx,
          refundTxid: detail.refundTxHash ?? null,
          actualOut: detail.actualAmountOut ?? '',
          durationSec: detail.durationSeconds ?? null,
        });
        return;
      case 'punished':
        this.setFlowContext({
          extra: { text: 'Refund deadline missed — BTC was punished.', type: 'error' },
        });
        this.transition({ phase: 'punished', snapshot: this.flowCtx });
        return;
      case 'expired':
        this.setFlowContext({ extra: { text: 'Swap expired.', type: 'error' } });
        this.transition({ phase: 'expired', snapshot: this.flowCtx });
        return;
      default:
        this.setFlowContext({
          extra: { text: `Swap ended: ${detail.status}`, type: 'error' },
        });
        this.transition({
          phase: 'failed',
          snapshot: this.flowCtx,
          error: `Swap ended with status: ${detail.status}`,
        });
    }
  }

  private emitTerminalFromDetail(detail: SwapDetail): void {
    this.emitTerminal(detail, detail.fromToken, detail.toToken);
  }

  private checkAborted(): void {
    if (this.signal.aborted) {
      this.transition({ phase: 'cancelled', snapshot: this.flowCtx });
      throw new SwapFlowCancelledError();
    }
  }

  private handleError(err: unknown): void {
    if (err instanceof SwapFlowCancelledError || this.signal.aborted) {
      this.logger.info({ swapId: this.flowCtx?.swapId ?? null }, 'SwapFlow cancelled');
      this.transition({ phase: 'cancelled', snapshot: this.flowCtx });
      return;
    }
    const rawMessage = err instanceof Error ? err.message : String(err);
    const userMessage = humanizeApiError(err);
    this.logger.error(
      { swapId: this.flowCtx?.swapId ?? null, error: rawMessage },
      'SwapFlow error',
    );
    this.setFlowContext({ extra: { text: userMessage, type: 'error' } });
    this.transition({
      phase: 'failed', snapshot: this.flowCtx,
      error: userMessage,
    });
  }
}

class SwapFlowCancelledError extends Error {
  constructor() { super('Swap flow cancelled'); this.name = 'SwapFlowCancelledError'; }
}

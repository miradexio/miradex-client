
import { EventEmitter } from 'eventemitter3';
import { ApiClient } from '../api/index.js';
import type { PlatformAdapter } from './platform.js';
import type { EngineState, ActiveFlow } from './engine-state.js';
import { createInitialEngineState } from './engine-state.js';
import type { SwapFlowState } from './flows/swap-flow-state.js';
import type { AtomicFlowState } from './flows/atomic-flow-state.js';
import type { SwapQuote } from '../types/index.js';
import { VerificationError } from '../types/index.js';
import { validateAddress } from '../address/index.js';
import {
  ENGINE_SLIPPAGE_MIN_BPS,
  ENGINE_SLIPPAGE_MAX_BPS,
  ENGINE_RETRY_MIN,
  ENGINE_RETRY_MAX,
} from '../lib/default-config.js';
import type { SwapFlow } from './flows/swap-flow.js';
import type { AtomicFlow } from './flows/atomic-flow.js';

export interface StartSwapParams {
  readonly fromToken: string;
  readonly fromChain: string;
  readonly toToken: string;
  readonly toChain: string;
  readonly amount: string;
  readonly destAddress: string;
  readonly refundAddress: string;
  readonly selectedQuote: SwapQuote;
  // Per-swap override. Same band as the constructor: [MIN, MAX] on
  // mainnet/testnet, [MIN, 10_000] on regtest. Out-of-range -> E_SLIPPAGE_OUT_OF_RANGE.
  readonly slippageBps?: number;
}

export interface StartAtomicSwapParams {
  readonly amount: string;
  readonly destAddress: string;
  readonly refundAddress: string;
  // Pin an atomicswap maker by variantId from /quotes (e.g. "maker-K4ZK7eSx").
  // Otherwise the server picks the top-scored maker.
  readonly variantId?: string;
  // Reuse an existing keystore instead of keygen + saveKeystore. The new swap
  // binds to the existing BTC key + funding address — used when a prior swap
  // failed but funds are still at the funding address and the user wants to
  // re-quote without depositing again. params.destAddress / refundAddress
  // still drive the new swap; the keystore's stored copies are historical.
  readonly existingKeystoreId?: string;
}

export interface EngineConfig {
  readonly apiUrl: string;
  readonly apiTimeout?: number;
  readonly apiMaxRetries?: number;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly network?: 'mainnet' | 'testnet' | 'regtest';
  readonly slippageBps?: number;
  /** Optional override for Monero RPC node URLs. Defaults to DEFAULT_NODES[network].monero. */
  readonly monerodNodes?: readonly string[];
}

export interface ResolvedEngineConfig {
  readonly apiUrl: string;
  readonly apiTimeout: number;
  readonly apiMaxRetries: number;
  readonly fetchFn: typeof globalThis.fetch;
  readonly network: 'mainnet' | 'testnet' | 'regtest';
  readonly slippageBps: number;
  readonly monerodNodes: readonly string[] | undefined;
}

// Defaults applied when a config field is unset. Exported so consumers can
// inspect them without constructing an engine.
export const DEFAULT_ENGINE_CONFIG = {
  apiTimeout: 60_000,
  apiMaxRetries: 3,
  network: 'mainnet' as const,
  slippageBps: 300,
} as const;

interface EngineEvents {
  state: (state: EngineState) => void;
}

export class MiradexEngine extends EventEmitter<EngineEvents> {
  private readonly api: ApiClient;
  private readonly platform: PlatformAdapter;
  private readonly resolvedConfig: ResolvedEngineConfig;

  private swapFlow: SwapFlow | null = null;
  private atomicFlow: AtomicFlow | null = null;
  private swapFlowGeneration = 0;
  private atomicFlowGeneration = 0;

  private _state: EngineState;

  private get logger(): PlatformAdapter['logger'] {
    return this.platform.logger;
  }

  constructor(config: EngineConfig, platform: PlatformAdapter) {
    super();

    const slippageBps = config.slippageBps ?? 300;
    // Tight band on mainnet/testnet (UX guard against catastrophic trades);
    // wide on regtest to accommodate shallow mocknet pools.
    const network = config.network ?? 'mainnet';
    const maxSlippage = network === 'regtest' ? 10_000 : ENGINE_SLIPPAGE_MAX_BPS;
    if (slippageBps < ENGINE_SLIPPAGE_MIN_BPS || slippageBps > maxSlippage) {
      throw new VerificationError(
        'E_SLIPPAGE_OUT_OF_RANGE',
        `slippageBps must be in [${String(ENGINE_SLIPPAGE_MIN_BPS)}, ${String(maxSlippage)}], got ${String(slippageBps)}`,
      );
    }
    const apiMaxRetries = config.apiMaxRetries ?? 3;
    if (apiMaxRetries < ENGINE_RETRY_MIN || apiMaxRetries > ENGINE_RETRY_MAX) {
      throw new VerificationError(
        'E_RETRIES_OUT_OF_RANGE',
        `apiMaxRetries must be in [${String(ENGINE_RETRY_MIN)}, ${String(ENGINE_RETRY_MAX)}], got ${String(apiMaxRetries)}`,
      );
    }

    this.resolvedConfig = {
      apiUrl: config.apiUrl,
      apiTimeout: config.apiTimeout ?? 60_000,
      apiMaxRetries,
      fetchFn: config.fetchFn ?? globalThis.fetch,
      network: config.network ?? 'mainnet',
      slippageBps,
      monerodNodes: config.monerodNodes,
    };

    this.api = new ApiClient({
      baseUrl: this.resolvedConfig.apiUrl,
      timeout: this.resolvedConfig.apiTimeout,
      maxRetries: this.resolvedConfig.apiMaxRetries,
      fetchFn: this.resolvedConfig.fetchFn,
    });

    this.platform = platform;
    this._state = createInitialEngineState();
  }

  get state(): EngineState {
    return this._state;
  }

  /** Expose the ApiClient for consumers that need direct API access. */
  get apiClient(): ApiClient {
    return this.api;
  }

  /** Expose the resolved config for flows. */
  get config(): ResolvedEngineConfig {
    return this.resolvedConfig;
  }

  /** Expose platform adapter for flows. */
  get platformAdapter(): PlatformAdapter {
    return this.platform;
  }

  // Each flow gets a scoped callback. When a new flow replaces the old one
  // the old callback becomes a no-op; its emissions are silently discarded.
  private createScopedSwapEmit(): (s: SwapFlowState) => void {
    this.swapFlow?.cancel();
    this.swapFlowGeneration++;
    const gen = this.swapFlowGeneration;
    return (s: SwapFlowState): void => {
      if (gen === this.swapFlowGeneration) this.setSwapState(s);
    };
  }

  private createScopedAtomicEmit(): (s: AtomicFlowState) => void {
    this.atomicFlow?.cancel();
    this.atomicFlowGeneration++;
    const gen = this.atomicFlowGeneration;
    return (s: AtomicFlowState): void => {
      if (gen === this.atomicFlowGeneration) this.setAtomicState(s);
    };
  }

  private updateState(partial: Partial<EngineState>): void {
    this._state = { ...this._state, ...partial };
    this.emit('state', this._state);
  }

  setSwapState(swap: SwapFlowState): void {
    this.updateState({ swap });
  }

  setAtomicState(atomic: AtomicFlowState): void {
    this.updateState({ atomic });
  }

  setActiveFlow(flow: ActiveFlow): void {
    this.updateState({ activeFlow: flow });
  }

  // Cancel all active flows, remove listeners.
  destroy(): void {
    this.logger.info({}, 'Engine destroyed');
    this.swapFlow?.cancel();
    this.atomicFlow?.cancel();
    this.removeAllListeners();
  }

  async startSwap(params: StartSwapParams): Promise<void> {
    if (params.slippageBps !== undefined) {
      const maxSlippage =
        this.resolvedConfig.network === 'regtest' ? 10_000 : ENGINE_SLIPPAGE_MAX_BPS;
      if (params.slippageBps < ENGINE_SLIPPAGE_MIN_BPS || params.slippageBps > maxSlippage) {
        throw new VerificationError(
          'E_SLIPPAGE_OUT_OF_RANGE',
          `slippageBps must be in [${String(ENGINE_SLIPPAGE_MIN_BPS)}, ${String(maxSlippage)}], got ${String(params.slippageBps)}`,
        );
      }
    }
    const destCheck = validateAddress(params.destAddress, params.toChain);
    if (!destCheck.valid) {
      throw new VerificationError(
        'E_INVALID_DEST_ADDRESS',
        `destAddress is not a valid ${params.toToken} (${params.toChain}) address: ${destCheck.reason ?? 'unknown reason'}`,
      );
    }
    this.logger.info({ flow: 'swap', fromToken: params.fromToken, toToken: params.toToken, amount: params.amount, slippageBps: params.slippageBps ?? this.resolvedConfig.slippageBps }, 'Starting standard swap');
    const emit = this.createScopedSwapEmit();
    const { SwapFlow } = await import('./flows/swap-flow.js');
    this.swapFlow = new SwapFlow(this.api, this.platform, this.resolvedConfig, emit);
    this.setActiveFlow('swap');
    void this.swapFlow.start(params);
  }

  // Routes to the right flow based on provider; caller doesn't need to know.
  async resume(swapId: string, keystoreAddress?: string): Promise<void> {
    this.logger.info({ swapId, keystoreAddress: keystoreAddress ?? null }, 'Resuming swap');
    // Cancel both flows first so a ghost emitter doesn't fire after resume
    // picks the other flow.
    this.swapFlow?.cancel();
    this.atomicFlow?.cancel();
    try {
      const detail = await this.api.getSwapDetail(swapId);

      const knownProviders: readonly string[] = ['atomicswap', 'thorchain', 'chainflip', 'near_intents'];
      if (!knownProviders.includes(detail.provider)) {
        throw new VerificationError(
          'E_PROVIDER_UNKNOWN',
          `server returned unknown provider: ${detail.provider}`,
        );
      }

      if (detail.provider === 'atomicswap') {
        let keystoreId: string | null = null;
        try {
          const keystores = await this.platform.listKeystores();
          const funding = detail.fundingAddress || keystoreAddress;
          const match = keystores.find(
            (ks) => ks.swapId === swapId || (funding && ks.btcAddress === funding),
          );
          keystoreId = match?.id ?? null;
        } catch { /* platform may not support listing */ }

        if (keystoreId) {
          const atomicEmit = this.createScopedAtomicEmit();
          const { AtomicFlow } = await import('./flows/atomic-flow.js');
          this.atomicFlow = new AtomicFlow(
            this.api, this.platform, this.resolvedConfig, atomicEmit,
          );
          this.setActiveFlow('atomic');
          void this.atomicFlow.resumeFromKeystore(keystoreId, swapId);
        } else {
          const swapEmit = this.createScopedSwapEmit();
          const { SwapFlow } = await import('./flows/swap-flow.js');
          this.swapFlow = new SwapFlow(
            this.api, this.platform, this.resolvedConfig, swapEmit,
          );
          this.setActiveFlow('swap');
          void this.swapFlow.resume(swapId, detail.provider, detail.fromToken, detail.toToken, detail);
        }
      } else {
        const swapEmit = this.createScopedSwapEmit();
        const { SwapFlow } = await import('./flows/swap-flow.js');
        this.swapFlow = new SwapFlow(
          this.api, this.platform, this.resolvedConfig, swapEmit,
        );
        this.setActiveFlow('swap');
        void this.swapFlow.resume(swapId, detail.provider, detail.fromToken, detail.toToken, detail);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ swapId, error: message }, 'Resume failed');
      this.setActiveFlow('swap');
      this.setSwapState({
        phase: 'failed',
        snapshot: null,
        error: `Resume failed: ${message}`,
      });
    }
  }

  cancelSwap(): void {
    this.swapFlow?.cancel();
    this.setSwapState({ phase: 'cancelled', snapshot: this._state.swap.snapshot });
  }

  async startAtomicSwap(params: StartAtomicSwapParams): Promise<void> {
    const destCheck = validateAddress(params.destAddress, 'XMR');
    if (!destCheck.valid) {
      throw new VerificationError(
        'E_INVALID_DEST_ADDRESS',
        `destAddress is not a valid XMR address: ${destCheck.reason ?? 'unknown reason'}`,
      );
    }
    this.logger.info({ flow: 'atomic', amount: params.amount, destAddress: params.destAddress }, 'Starting atomic swap');
    const emit = this.createScopedAtomicEmit();
    const { AtomicFlow } = await import('./flows/atomic-flow.js');
    this.atomicFlow = new AtomicFlow(this.api, this.platform, this.resolvedConfig, emit);
    this.setActiveFlow('atomic');
    void this.atomicFlow.start(params);
  }

  // Called from both /resume and /keystores modes.
  async resumeAtomicSwap(keystoreId: string, swapId?: string): Promise<void> {
    this.logger.info({ flow: 'atomic', keystoreId, swapId: swapId ?? null }, 'Resuming atomic swap');
    const emit = this.createScopedAtomicEmit();
    const { AtomicFlow } = await import('./flows/atomic-flow.js');
    this.atomicFlow = new AtomicFlow(this.api, this.platform, this.resolvedConfig, emit);
    this.setActiveFlow('atomic');
    void this.atomicFlow.resumeFromKeystore(keystoreId, swapId);
  }

  cancelAtomicSwap(): void {
    this.atomicFlow?.cancel();
    this.setAtomicState({ phase: 'cancelled', snapshot: this._state.atomic.snapshot, swapId: null, txCancelTxid: null });
  }

  // Broadcast TxCancel. Only valid in atomic.phase=awaiting-user-action with
  // requiredAction.type=cancel.
  userCancel(): void {
    if (this._state.atomic.phase !== 'awaiting-user-action') return;
    void this.atomicFlow?.userCancel();
  }

  // Verify TxCancel on-chain then share s_b. Only valid in
  // atomic.phase=awaiting-user-action with requiredAction.type=refund.
  userRefund(): void {
    if (this._state.atomic.phase !== 'awaiting-user-action') return;
    void this.atomicFlow?.userRefund();
  }

  userRetrySweep(): void {
    void this.atomicFlow?.userRetrySweep();
  }

  // Cancels any active operation.
  exitToIdle(): void {
    this.logger.info({}, 'Exiting to idle');
    this.swapFlow?.cancel();
    this.atomicFlow?.cancel();
    this.updateState({
      activeFlow: 'idle',
      swap: { phase: 'idle', snapshot: null },
      atomic: { phase: 'idle', snapshot: null },
    });
  }
}

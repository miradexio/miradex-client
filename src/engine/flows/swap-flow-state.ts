import type { SwapQuote, RequiredAction, LimitsResponse } from '../../types/index.js';
import type {
  FlowContext,
  PopulatedFlowContext,
  VerifiedFlowContext,
} from '../flow-context.js';

export interface WizardFromPhase {
  readonly phase: 'wizard-from';
  readonly snapshot: null;
}

export interface WizardToPhase {
  readonly phase: 'wizard-to';
  readonly snapshot: null;
  readonly fromToken: string;
  readonly fromChain: string;
}

export interface WizardAmountPhase {
  readonly phase: 'wizard-amount';
  readonly snapshot: null;
  readonly fromToken: string;
  readonly fromChain: string;
  readonly toToken: string;
  readonly toChain: string;
  readonly limits: LimitsResponse | null;
  readonly quotes: readonly SwapQuote[];
  readonly quotesLoading: boolean;
}

export interface WizardDestPhase {
  readonly phase: 'wizard-dest';
  readonly snapshot: null;
  readonly fromToken: string;
  readonly fromChain: string;
  readonly toToken: string;
  readonly toChain: string;
  readonly amount: string;
  readonly amountInUsd: string | null;
  readonly quotes: readonly SwapQuote[];
  readonly selectedQuote: SwapQuote;
}

export interface WizardRefundPhase {
  readonly phase: 'wizard-refund';
  readonly snapshot: null;
  readonly fromToken: string;
  readonly fromChain: string;
  readonly toToken: string;
  readonly toChain: string;
  readonly amount: string;
  readonly destAddress: string;
  readonly selectedQuote: SwapQuote;
}

export interface WizardConfirmPhase {
  readonly phase: 'wizard-confirm';
  readonly snapshot: null;
  readonly fromToken: string;
  readonly fromChain: string;
  readonly toToken: string;
  readonly toChain: string;
  readonly amount: string;
  readonly amountInUsd: string | null;
  readonly destAddress: string;
  readonly refundAddress: string;
  readonly selectedQuote: SwapQuote;
}

export interface ProviderWarningPhase {
  readonly phase: 'provider-warning';
  readonly snapshot: null;
  readonly provider: string;
  readonly fromToken: string;
  readonly amount: string;
  readonly destAddress: string;
  readonly refundAddress: string;
  readonly selectedQuote: SwapQuote;
}

export interface SolvingPowPhase {
  readonly phase: 'solving-pow';
  readonly snapshot: FlowContext;
}

export interface CreatingSwapPhase {
  readonly phase: 'creating-swap';
  readonly snapshot: FlowContext;
}

export interface AwaitingDepositPhase {
  readonly phase: 'awaiting-deposit';
  readonly snapshot: PopulatedFlowContext;
}

export interface VerificationFailedPhase {
  readonly phase: 'verification-failed';
  // Deliberately uses the loose FlowContext (not PopulatedFlowContext): when
  // verification fails the SDK refuses to expose deposit address / QR — those
  // are kept null so a UI cannot accidentally invite the user to send funds.
  // The verification result itself is the only payload the failure screen
  // needs.
  readonly snapshot: FlowContext;
}

/**
 * Snapshot for a swap tracked WITHOUT an ownership proof (server returned
 * access:'restricted'). Sensitive fields (depositAddr, destAddress, refund,
 * verification, qr) are guaranteed null; consumers must narrow on
 * `restricted` before relying on the verified guarantees.
 */
export type RestrictedFlowSnapshot = FlowContext & { readonly restricted: true };

export interface ConfirmingPhase {
  readonly phase: 'confirming';
  readonly snapshot: VerifiedFlowContext | RestrictedFlowSnapshot;
  readonly requiredAction: RequiredAction | null;
}

export interface SwappingPhase {
  readonly phase: 'swapping';
  readonly snapshot: VerifiedFlowContext | RestrictedFlowSnapshot;
  readonly requiredAction: RequiredAction | null;
}

export interface SendingPhase {
  readonly phase: 'sending';
  readonly snapshot: VerifiedFlowContext | RestrictedFlowSnapshot;
}

/**
 * Atomicswap cancel-path phase. Entered when the server reports `cancelling`
 * status — a TxCancel has been broadcast and either Bob's client is about to
 * broadcast TxRefund (keystore mode via AtomicFlow) or the user is just
 * watching from a non-keystore SwapFlow for terminal status.
 */
export interface CancellingPhase {
  readonly phase: 'cancelling';
  readonly snapshot: VerifiedFlowContext | RestrictedFlowSnapshot;
  readonly requiredAction: RequiredAction | null;
}

export interface CompletedPhase {
  readonly phase: 'completed';
  readonly snapshot: FlowContext;
  readonly actualOut: string;
  readonly outputTxHash: string | null;
  readonly durationSec: number | null;
}

/** Swap ended with Bob getting his BTC back via TxRefund (atomicswap cancel path). */
export interface RefundedPhase {
  readonly phase: 'refunded';
  readonly snapshot: FlowContext | null;
  readonly refundTxid: string | null;
  /**
   * The actual amount returned to the refund address (in human-decimal of the
   * source asset). Differs from `snapshot.depositAmount` by the network fee
   * the chain charged on the refund tx, so renderers should display this
   * value (not the original deposit) as the "you got back" number.
   */
  readonly actualOut: string;
  readonly durationSec: number | null;
}

/** Refund window closed before TxRefund broadcast — Alice took the BTC via TxPunish. */
export interface PunishedPhase {
  readonly phase: 'punished';
  readonly snapshot: FlowContext | null;
}

/** Server-side expiry (e.g. no deposit received). */
export interface ExpiredPhase {
  readonly phase: 'expired';
  readonly snapshot: FlowContext | null;
}

export interface FailedPhase {
  readonly phase: 'failed';
  readonly snapshot: FlowContext | null;
  readonly error: string;
}

export interface CancelledPhase {
  readonly phase: 'cancelled';
  readonly snapshot: FlowContext | null;
}

export type SwapFlowState =
  | { readonly phase: 'idle'; readonly snapshot: null }
  | WizardFromPhase
  | WizardToPhase
  | WizardAmountPhase
  | WizardDestPhase
  | WizardRefundPhase
  | WizardConfirmPhase
  | ProviderWarningPhase
  | SolvingPowPhase
  | CreatingSwapPhase
  | AwaitingDepositPhase
  | VerificationFailedPhase
  | ConfirmingPhase
  | SwappingPhase
  | SendingPhase
  | CancellingPhase
  | CompletedPhase
  | RefundedPhase
  | PunishedPhase
  | ExpiredPhase
  | FailedPhase
  | CancelledPhase;

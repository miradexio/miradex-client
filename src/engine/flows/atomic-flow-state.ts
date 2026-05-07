import type { RequiredAction } from '../../types/index.js';
import type {
  FlowContext,
  PopulatedFlowContext,
  VerifiedFlowContext,
} from '../flow-context.js';

export interface AtomicIdlePhase {
  readonly phase: 'idle';
  readonly snapshot: null;
}

export interface AtomicKeygenPhase {
  readonly phase: 'keygen';
  readonly snapshot: FlowContext | null;
  readonly message: string;
}

export interface AtomicKeystoreSavedPhase {
  readonly phase: 'keystore-saved';
  readonly snapshot: FlowContext;
  readonly message: string;
}

export interface AtomicAwaitingDepositPhase {
  readonly phase: 'awaiting-deposit';
  readonly snapshot: PopulatedFlowContext;
  readonly message: string;
}

export interface AtomicDepositDetectedPhase {
  readonly phase: 'deposit-detected';
  readonly snapshot: PopulatedFlowContext;
  readonly deposit: {
    readonly txid: string;
    readonly vout: number;
    readonly value: number;
    readonly utxos?: readonly { readonly txid: string; readonly vout: number; readonly value: number }[];
  };
  readonly message: string;
}

export interface AtomicCreatingSwapPhase {
  readonly phase: 'creating-swap';
  readonly snapshot: FlowContext;
  readonly message: string;
}

export interface AtomicVerifyingPhase {
  readonly phase: 'verifying';
  readonly snapshot: FlowContext;
  readonly message: string;
}

export interface AtomicSigningPhase {
  readonly phase: 'signing';
  readonly snapshot: VerifiedFlowContext;
  readonly message: string;
}

export interface AtomicFundingPhase {
  readonly phase: 'funding';
  readonly snapshot: VerifiedFlowContext;
  readonly message: string;
}

export interface AtomicComputingEncsigPhase {
  readonly phase: 'computing-encsig';
  readonly snapshot: VerifiedFlowContext;
  readonly message: string;
}

export interface AtomicConfirmingPhase {
  readonly phase: 'confirming';
  readonly snapshot: VerifiedFlowContext;
  readonly message: string;
}

export interface AtomicSwappingPhase {
  readonly phase: 'swapping';
  readonly snapshot: VerifiedFlowContext;
  readonly message: string;
}

export interface AtomicSweepingPhase {
  readonly phase: 'sweeping';
  readonly snapshot: VerifiedFlowContext;
  readonly message: string;
  readonly sweepStep: 'get-outputs' | 'key-images' | 'submitting' | 'broadcasting';
}

export interface AtomicAwaitingUserActionPhase {
  readonly phase: 'awaiting-user-action';
  readonly snapshot: VerifiedFlowContext;
  readonly requiredAction: RequiredAction;
  readonly error: string | null;
}

export interface AtomicVerifyingCancelPhase {
  readonly phase: 'verifying-cancel';
  readonly snapshot: FlowContext;
  readonly message: string;
}

export interface AtomicCancellingPhase {
  readonly phase: 'cancelling';
  readonly snapshot: FlowContext;
  readonly message: string;
}

export interface AtomicRefundingPhase {
  readonly phase: 'refunding';
  readonly snapshot: FlowContext;
  readonly message: string;
}

export interface AtomicCompletedPhase {
  readonly phase: 'completed';
  readonly snapshot: FlowContext;
  readonly outputTxHash: string | null;
  readonly actualOut: string;
  readonly durationSec: number | null;
}

export interface AtomicRefundedPhase {
  readonly phase: 'refunded';
  readonly snapshot: FlowContext | null;
  readonly swapId: string;
  readonly refundTxid: string | null;
}

export interface AtomicCancelledPhase {
  readonly phase: 'cancelled';
  readonly snapshot: FlowContext | null;
  readonly swapId: string | null;
  readonly txCancelTxid: string | null;
}

export interface AtomicFailedPhase {
  readonly phase: 'failed';
  readonly snapshot: FlowContext | null;
  readonly error: string;
}

export type AtomicFlowState =
  | AtomicIdlePhase
  | AtomicKeygenPhase
  | AtomicKeystoreSavedPhase
  | AtomicAwaitingDepositPhase
  | AtomicDepositDetectedPhase
  | AtomicCreatingSwapPhase
  | AtomicVerifyingPhase
  | AtomicSigningPhase
  | AtomicFundingPhase
  | AtomicComputingEncsigPhase
  | AtomicConfirmingPhase
  | AtomicSwappingPhase
  | AtomicSweepingPhase
  | AtomicAwaitingUserActionPhase
  | AtomicVerifyingCancelPhase
  | AtomicCancellingPhase
  | AtomicRefundingPhase
  | AtomicCompletedPhase
  | AtomicRefundedPhase
  | AtomicCancelledPhase
  | AtomicFailedPhase;

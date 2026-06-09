import type { SwapFlowState } from './flows/swap-flow-state.js';
import type { AtomicFlowState } from './flows/atomic-flow-state.js';

export type PipelineStage =
  | 'pending'
  | 'deposit'
  | 'confirming'
  | 'exchanging'
  | 'cancelling'
  | 'refunded'
  | 'expired'
  | 'complete';

export interface PipelineLabel {
  readonly key: PipelineStage;
  readonly label: string;
}

export const PIPELINE_LABELS: readonly PipelineLabel[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'deposit', label: 'Deposit' },
  { key: 'confirming', label: 'Confirming' },
  { key: 'exchanging', label: 'Exchanging' },
  { key: 'complete', label: 'Complete' },
];

export const PIPELINE_LABELS_CANCEL: readonly PipelineLabel[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'deposit', label: 'Deposit' },
  { key: 'confirming', label: 'Confirming' },
  { key: 'exchanging', label: 'Exchanging' },
  { key: 'cancelling', label: 'Cancelling' },
];

export const PIPELINE_LABELS_REFUND: readonly PipelineLabel[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'deposit', label: 'Deposit' },
  { key: 'confirming', label: 'Confirming' },
  { key: 'exchanging', label: 'Exchanging' },
  { key: 'refunded', label: 'Refunded' },
];

export const PIPELINE_LABELS_EXPIRED: readonly PipelineLabel[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'deposit', label: 'Deposit' },
  { key: 'confirming', label: 'Confirming' },
  { key: 'exchanging', label: 'Exchanging' },
  { key: 'expired', label: 'Expired' },
];

const STAGE_ORDER: readonly PipelineStage[] = [
  'pending',
  'deposit',
  'confirming',
  'exchanging',
];

export function swapPipelineStage(phase: SwapFlowState['phase']): PipelineStage | null {
  switch (phase) {
    case 'idle':
    case 'wizard-from':
    case 'wizard-to':
    case 'wizard-amount':
    case 'wizard-dest':
    case 'wizard-refund':
    case 'wizard-confirm':
    case 'provider-warning':
      return null;
    case 'solving-pow':
    case 'creating-swap':
      return 'pending';
    case 'awaiting-deposit':
    case 'verification-failed':
      return 'deposit';
    case 'confirming':
      return 'confirming';
    case 'swapping':
    case 'sending':
      return 'exchanging';
    case 'cancelling':
      return 'cancelling';
    case 'completed':
      return 'complete';
    case 'refunded':
      return 'refunded';
    case 'expired':
      return 'expired';
    case 'punished':
      return 'complete';
    case 'failed':
    case 'cancelled':
      return null;
  }
}

export function atomicPipelineStage(phase: AtomicFlowState['phase']): PipelineStage | null {
  switch (phase) {
    case 'idle':
      return null;
    case 'keygen':
    case 'keystore-saved':
      return 'pending';
    case 'awaiting-deposit':
    case 'deposit-detected':
      return 'deposit';
    case 'creating-swap':
    case 'verifying':
    case 'signing':
    case 'funding':
      return 'confirming';
    case 'computing-encsig':
    case 'confirming':
    case 'swapping':
    case 'sweeping':
    case 'awaiting-user-action':
      return 'exchanging';
    case 'verifying-cancel':
    case 'cancelling':
    case 'refunding':
      return 'cancelling';
    case 'completed':
      return 'complete';
    case 'refunded':
    case 'cancelled':
      // Atomic refund/cancel both return BTC to the buyer; render the refund
      // chip rather than pretending the swap completed.
      return 'refunded';
    case 'failed':
      return null;
    case 'stalled':
      return 'exchanging';
  }
}

// 'cancelling' and 'complete' both sit past the base 4 stages, so the
// base stages are all marked done when either is current.
export function computeDoneStages(currentStage: PipelineStage | null): ReadonlySet<PipelineStage> {
  if (!currentStage) return new Set();

  if (currentStage === 'cancelling' || currentStage === 'complete') {
    return new Set(STAGE_ORDER);
  }

  // Refund means BTC was on-chain (THORChain rejected at the swap step).
  // Mark pending/deposit/confirming green; exchanging + refunded are warn.
  if (currentStage === 'refunded') {
    return new Set(['pending', 'deposit', 'confirming']);
  }

  // Expiry means swap created but deposit window closed before any funds
  // arrived. Only 'pending' is unambiguously done.
  if (currentStage === 'expired') {
    return new Set(['pending']);
  }

  const idx = STAGE_ORDER.indexOf(currentStage);
  if (idx < 0) return new Set();

  return new Set(STAGE_ORDER.slice(0, idx));
}

// One map shared by every flow. Returns null on unknown status; caller skips.
export function mapServerStatus(status: string): PipelineStage | null {
  switch (status) {
    case 'initializing':
    case 'pending':
      return 'pending';
    case 'awaiting_funding':
      return 'deposit';
    case 'deposited':
      return 'confirming';
    case 'swapping':
    case 'sending':
      return 'exchanging';
    case 'cancelling':
      return 'cancelling';
    case 'completed':
    case 'withheld':
    case 'punished':
      return 'complete';
    default:
      return null;
  }
}

import { describe, it, expect } from 'vitest';
import {
  swapPipelineStage,
  atomicPipelineStage,
  computeDoneStages,
  mapServerStatus,
  PIPELINE_LABELS,
  PIPELINE_LABELS_CANCEL,
} from '../../../src/engine/pipeline.js';
import type { SwapFlowState } from '../../../src/engine/flows/swap-flow-state.js';
import type { AtomicFlowState } from '../../../src/engine/flows/atomic-flow-state.js';

describe('swapPipelineStage', () => {
  it('returns null for idle', () => {
    expect(swapPipelineStage('idle')).toBeNull();
  });

  it('returns null for wizard phases', () => {
    const wizardPhases: SwapFlowState['phase'][] = [
      'wizard-from',
      'wizard-to',
      'wizard-amount',
      'wizard-dest',
      'wizard-refund',
      'wizard-confirm',
      'provider-warning',
    ];
    for (const phase of wizardPhases) {
      expect(swapPipelineStage(phase)).toBeNull();
    }
  });

  it('maps solving-pow to pending', () => {
    expect(swapPipelineStage('solving-pow')).toBe('pending');
  });

  it('maps creating-swap to pending', () => {
    expect(swapPipelineStage('creating-swap')).toBe('pending');
  });

  it('maps awaiting-deposit to deposit', () => {
    expect(swapPipelineStage('awaiting-deposit')).toBe('deposit');
  });

  it('maps verification-failed to deposit', () => {
    expect(swapPipelineStage('verification-failed')).toBe('deposit');
  });

  it('maps confirming to confirming', () => {
    expect(swapPipelineStage('confirming')).toBe('confirming');
  });

  it('maps swapping to exchanging', () => {
    expect(swapPipelineStage('swapping')).toBe('exchanging');
  });

  it('maps sending to exchanging', () => {
    expect(swapPipelineStage('sending')).toBe('exchanging');
  });

  it('maps completed to complete', () => {
    expect(swapPipelineStage('completed')).toBe('complete');
  });

  it('returns null for failed', () => {
    expect(swapPipelineStage('failed')).toBeNull();
  });

  it('returns null for cancelled', () => {
    expect(swapPipelineStage('cancelled')).toBeNull();
  });
});

describe('atomicPipelineStage', () => {
  it('returns null for idle', () => {
    expect(atomicPipelineStage('idle')).toBeNull();
  });

  it('maps keygen to pending', () => {
    expect(atomicPipelineStage('keygen')).toBe('pending');
  });

  it('maps keystore-saved to pending', () => {
    expect(atomicPipelineStage('keystore-saved')).toBe('pending');
  });

  it('maps awaiting-deposit to deposit', () => {
    expect(atomicPipelineStage('awaiting-deposit')).toBe('deposit');
  });

  it('maps deposit-detected to deposit', () => {
    expect(atomicPipelineStage('deposit-detected')).toBe('deposit');
  });

  it('maps creating-swap to confirming', () => {
    expect(atomicPipelineStage('creating-swap')).toBe('confirming');
  });

  it('maps verifying to confirming', () => {
    expect(atomicPipelineStage('verifying')).toBe('confirming');
  });

  it('maps signing to confirming', () => {
    expect(atomicPipelineStage('signing')).toBe('confirming');
  });

  it('maps funding to confirming', () => {
    expect(atomicPipelineStage('funding')).toBe('confirming');
  });

  it('maps computing-encsig to exchanging', () => {
    expect(atomicPipelineStage('computing-encsig')).toBe('exchanging');
  });

  it('maps confirming to exchanging', () => {
    expect(atomicPipelineStage('confirming')).toBe('exchanging');
  });

  it('maps swapping to exchanging', () => {
    expect(atomicPipelineStage('swapping')).toBe('exchanging');
  });

  it('maps sweeping to exchanging', () => {
    expect(atomicPipelineStage('sweeping')).toBe('exchanging');
  });

  it('maps awaiting-user-action to exchanging', () => {
    expect(atomicPipelineStage('awaiting-user-action')).toBe('exchanging');
  });

  it('maps verifying-cancel to cancelling', () => {
    expect(atomicPipelineStage('verifying-cancel')).toBe('cancelling');
  });

  it('maps cancelling to cancelling', () => {
    expect(atomicPipelineStage('cancelling')).toBe('cancelling');
  });

  it('maps refunding to cancelling', () => {
    expect(atomicPipelineStage('refunding')).toBe('cancelling');
  });

  it('maps completed to complete', () => {
    expect(atomicPipelineStage('completed')).toBe('complete');
  });

  it('maps refunded to refunded', () => {
    expect(atomicPipelineStage('refunded')).toBe('refunded');
  });

  it('maps cancelled to refunded', () => {
    expect(atomicPipelineStage('cancelled')).toBe('refunded');
  });

  it('returns null for failed', () => {
    expect(atomicPipelineStage('failed')).toBeNull();
  });

  it('covers every AtomicFlowState phase', () => {
    const allPhases: AtomicFlowState['phase'][] = [
      'idle',
      'keygen',
      'keystore-saved',
      'awaiting-deposit',
      'deposit-detected',
      'creating-swap',
      'verifying',
      'signing',
      'funding',
      'computing-encsig',
      'confirming',
      'swapping',
      'sweeping',
      'awaiting-user-action',
      'verifying-cancel',
      'cancelling',
      'refunding',
      'completed',
      'refunded',
      'cancelled',
      'failed',
    ];
    for (const phase of allPhases) {
      const result = atomicPipelineStage(phase);
      expect(result === null || typeof result === 'string').toBe(true);
    }
  });
});

describe('computeDoneStages', () => {
  it('returns empty set for null', () => {
    expect(computeDoneStages(null).size).toBe(0);
  });

  it('returns empty set for first stage (pending)', () => {
    const done = computeDoneStages('pending');
    expect(done.size).toBe(0);
  });

  it('marks pending as done when at deposit', () => {
    const done = computeDoneStages('deposit');
    expect(done.has('pending')).toBe(true);
    expect(done.has('deposit')).toBe(false);
    expect(done.size).toBe(1);
  });

  it('marks first 3 stages as done when at exchanging', () => {
    const done = computeDoneStages('exchanging');
    expect(done.has('pending')).toBe(true);
    expect(done.has('deposit')).toBe(true);
    expect(done.has('confirming')).toBe(true);
    expect(done.has('exchanging')).toBe(false);
    expect(done.size).toBe(3);
  });

  it('marks all 4 base stages as done when at complete', () => {
    const done = computeDoneStages('complete');
    expect(done.has('pending')).toBe(true);
    expect(done.has('deposit')).toBe(true);
    expect(done.has('confirming')).toBe(true);
    expect(done.has('exchanging')).toBe(true);
    expect(done.has('complete')).toBe(false);
    expect(done.size).toBe(4);
  });

  it('marks all 4 base stages as done when at cancelling', () => {
    const done = computeDoneStages('cancelling');
    expect(done.has('pending')).toBe(true);
    expect(done.has('deposit')).toBe(true);
    expect(done.has('confirming')).toBe(true);
    expect(done.has('exchanging')).toBe(true);
    expect(done.has('cancelling')).toBe(false);
    expect(done.size).toBe(4);
  });
});

describe('mapServerStatus', () => {
  it('maps initializing to pending', () => {
    expect(mapServerStatus('initializing')).toBe('pending');
  });

  it('maps pending to pending', () => {
    expect(mapServerStatus('pending')).toBe('pending');
  });

  it('maps awaiting_funding to deposit', () => {
    expect(mapServerStatus('awaiting_funding')).toBe('deposit');
  });

  it('maps deposited to confirming', () => {
    expect(mapServerStatus('deposited')).toBe('confirming');
  });

  it('maps swapping to exchanging', () => {
    expect(mapServerStatus('swapping')).toBe('exchanging');
  });

  it('maps sending to exchanging', () => {
    expect(mapServerStatus('sending')).toBe('exchanging');
  });

  it('maps cancelling to cancelling', () => {
    expect(mapServerStatus('cancelling')).toBe('cancelling');
  });

  it('maps completed to complete', () => {
    expect(mapServerStatus('completed')).toBe('complete');
  });

  it('maps withheld to complete', () => {
    expect(mapServerStatus('withheld')).toBe('complete');
  });

  it('returns null for unknown statuses', () => {
    expect(mapServerStatus('some_future_status')).toBeNull();
    expect(mapServerStatus('')).toBeNull();
    expect(mapServerStatus('failed')).toBeNull();
    expect(mapServerStatus('refunded')).toBeNull();
    expect(mapServerStatus('expired')).toBeNull();
  });
});

describe('PIPELINE_LABELS', () => {
  it('has 5 stages for normal flow', () => {
    expect(PIPELINE_LABELS).toHaveLength(5);
    expect(PIPELINE_LABELS.map((l) => l.key)).toEqual([
      'pending', 'deposit', 'confirming', 'exchanging', 'complete',
    ]);
  });

  it('has 5 stages for cancel flow', () => {
    expect(PIPELINE_LABELS_CANCEL).toHaveLength(5);
    expect(PIPELINE_LABELS_CANCEL.map((l) => l.key)).toEqual([
      'pending', 'deposit', 'confirming', 'exchanging', 'cancelling',
    ]);
  });

  it('shares the first 4 stages between normal and cancel', () => {
    for (let i = 0; i < 4; i++) {
      expect(PIPELINE_LABELS[i]!.key).toBe(PIPELINE_LABELS_CANCEL[i]!.key);
      expect(PIPELINE_LABELS[i]!.label).toBe(PIPELINE_LABELS_CANCEL[i]!.label);
    }
  });
});

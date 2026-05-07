import type { SwapFlowState } from './flows/swap-flow-state.js';
import type { AtomicFlowState } from './flows/atomic-flow-state.js';

// Re-export FlowContext types from the Zod-based module.
export type {
  FlowContext,
  PopulatedFlowContext,
  VerifiedFlowContext,
  FlowContextExtra,
  FlowContextExtraType,
  FlowContextValidationError,
  FlowContextResult,
} from './flow-context.js';

export {
  createFlowContext,
  mergeFlowContext,
  validateBase,
  validatePopulated,
  validateVerified,
  FlowContextBaseSchema,
  PopulatedFlowContextSchema,
  VerifiedFlowContextSchema,
  FlowContextExtraSchema,
  VerificationResultSchema,
  VerificationCheckSchema,
} from './flow-context.js';

// Emitted on every state transition. One engine drives one swap, so only
// `swap` (provider) and `atomic` (BTC<->XMR) are meaningful flow branches;
// cross-flow concerns (tokens, history, quotes, providers, connection)
// live outside the engine.
export interface EngineState {
  readonly activeFlow: ActiveFlow;
  readonly swap: SwapFlowState;
  readonly atomic: AtomicFlowState;
}

export type ActiveFlow =
  | 'idle'
  | 'swap'
  | 'atomic'
  | 'tokens'
  | 'history'
  | 'quote'
  | 'providers'
  | 'settings'
  | 'help'
  | 'keystores'
  | 'resume'
  | 'price'
  | 'quit';

export function createInitialEngineState(): EngineState {
  return {
    activeFlow: 'idle',
    swap: { phase: 'idle', snapshot: null },
    atomic: { phase: 'idle', snapshot: null },
  };
}

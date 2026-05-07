// Portable subset of @miradexio/client. Browser / Electron-renderer / RN /
// any runtime without Node built-ins. Pure-TS only (no fs/net deps); server
// and signing code live in the main barrel.

export {
  swapPipelineStage,
  atomicPipelineStage,
  computeDoneStages,
  mapServerStatus,
  PIPELINE_LABELS,
  PIPELINE_LABELS_CANCEL,
  PIPELINE_LABELS_REFUND,
  PIPELINE_LABELS_EXPIRED,
} from './engine/pipeline.js';
export type { PipelineStage, PipelineLabel } from './engine/pipeline.js';

export { TERMINAL_STATUSES } from './types/index.js';

export { createInitialEngineState } from './engine/engine-state.js';

export type {
  SwapStatus,
  TerminalStatus,
  SwapProvider,
  SwapQuote,
  SwapDetail,
  SwapFee,
  SwapTokenInfo,
  SwapTokenMap,
  SwapPair,
  SwapVerification,
  CreateSwapBody,
  CreateSwapResponse,
  VerificationCheck,
  VerificationResult,
  QuotesResponse,
  RateResponse,
  LimitsResponse,
  ProviderInfo,
  ProvidersResponse,
  RecentSwap,
  HistoryEntry,
  RequiredAction,
} from './types/index.js';

export type { EngineState, ActiveFlow } from './engine/engine-state.js';
export type { SwapFlowState } from './engine/flows/swap-flow-state.js';
export type { AtomicFlowState } from './engine/flows/atomic-flow-state.js';
export type { KeystoreMetadata, KeystoreStatus } from './engine/platform.js';
export type { VerifyDepositParams } from './verification/index.js';
export type { StartSwapParams, StartAtomicSwapParams } from './engine/miradex-engine.js';
export type { GetQuotesParams, GetRateParams, GetLimitsParams } from './api/index.js';

export {
  validateAddress,
  resolveChain,
  getSupportedChains,
  tokensForChain,
} from './address/index.js';
export type { ValidationResult } from './address/index.js';

export {
  DEFAULT_NODES,
  MONERO_MAINNET_NODES,
  MONERO_STAGENET_NODES,
  ELECTRUM_SERVERS,
  ELECTRUM_PRIMARY_URL,
  ELECTRUM_TESTNET_URL,
  electrumUrlForNetwork,
} from './lib/default-config.js';
export type { DefaultNodeBlockchain, ElectrumServerEntry } from './lib/default-config.js';

export { ensureWasm } from './lib/crypto/wasm.js';
export type { EnsureWasmOptions } from './lib/crypto/wasm.js';
export { WasmError } from './lib/crypto/errors.js';
export type { WasmModule } from './lib/crypto/types.js';
export { detectPlatform } from './lib/crypto/platform.js';
export type { Platform } from './lib/crypto/platform.js';

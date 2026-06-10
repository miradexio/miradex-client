// Public API surface for @miradexio/client. Sub-path entries in
// package.json#exports give consumers narrower bundles.

export { SwapExecutor } from './swap-executor.js';
export { MiradexEngine, DEFAULT_ENGINE_CONFIG } from './engine/miradex-engine.js';
export type {
  EngineConfig,
  ResolvedEngineConfig,
  StartSwapParams,
  StartAtomicSwapParams,
} from './engine/miradex-engine.js';
export { SwapFlow } from './engine/flows/swap-flow.js';
export { AtomicFlow } from './engine/flows/atomic-flow.js';
export { SWAP_FLOW_CONFIG } from './engine/flows/swap-flow.js';
export { createInitialEngineState } from './engine/engine-state.js';
export type { EngineState, ActiveFlow } from './engine/engine-state.js';
export type { SwapFlowState } from './engine/flows/swap-flow-state.js';
export type { AtomicFlowState } from './engine/flows/atomic-flow-state.js';
export type {
  FlowContext,
  PopulatedFlowContext,
  VerifiedFlowContext,
  FlowContextExtra,
  FlowContextExtraType,
  FlowContextValidationError,
  FlowContextResult,
} from './engine/flow-context.js';
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
} from './engine/flow-context.js';
export type {
  PlatformAdapter,
  DetectedDeposit,
  UtxoInput,
  FeeEstimate,
  KeystoreSaveResult,
  KeystoreMetadata,
  KeystoreStatus,
} from './engine/platform.js';
export type { BlockchainQuerier, TxSummary } from './engine/blockchain-querier.js';
export {
  swapPipelineStage,
  atomicPipelineStage,
  computeDoneStages,
  mapServerStatus,
  PIPELINE_LABELS,
  PIPELINE_LABELS_CANCEL,
} from './engine/pipeline.js';
export type { PipelineStage, PipelineLabel } from './engine/pipeline.js';

// @internal driver primitives. Prefer SwapExecutor / MiradexEngine.
export {
  runAtomicSwap,
  resumeAtomicSwap,
  submitEncsigWhenReady,
  SwapCancelledError,
} from './atomic-swap/index.js';
export type {
  AtomicSwapParams,
  AtomicSwapCallbacks,
  AtomicSwapProgress,
  ResumeAtomicSwapParams,
  RunAtomicSwapOptions,
  ResumeAtomicSwapOptions,
  SubmitEncsigParams,
} from './atomic-swap/index.js';

// Verification primitives.
export {
  buildMultisigWitnessScript,
  computePreSigs,
  computeRedeemDigest,
  computeRedeemDigestFromTxHex,
  deriveLockAddress,
} from './atomic-swap/presign.js';
export type {
  ComputePreSigsParams,
  ComputeRedeemDigestParams,
  ComputeRedeemDigestFromTxHexParams,
  NetworkName,
} from './atomic-swap/presign.js';
export { validateCooperativeRedeem } from './cooperative-redeem.js';
export type { CooperativeRedeemInput } from './cooperative-redeem.js';
export {
  hashQuote,
  requireQuoteHashMatches,
  requireQuoteFresh,
  QUOTE_MAX_AGE_MS,
} from './quote-binding.js';
export type { AcceptedQuote } from './quote-binding.js';
export {
  verifyDepositAddress,
  verifyAtomicSwap,
  verifyThorchain,
  verifyChainflip,
  verifyNearIntents,
  fetchThorchainVaults,
  verifyThorchainQuote,
  verifyChainflipChannel,
  fetchNearIntentStatus,
  requireIntentBinds,
  requireIntentDeadlineMargin,
  verifyNearIntentOnChain,
  fetchConsensusRate,
  parseThorchainMemo,
  requireMemoBindsDestination,
  VERIFY_FETCH_TIMEOUT_MS,
  VERIFY_MAX_ATTEMPTS,
  VERIFY_RETRY_DELAY_MS,
} from './verification/index.js';
export type {
  ParsedThorchainMemo,
  FetchThorchainVaultsInput,
  VerifyThorchainQuoteInput,
  VerifyChainflipChannelInput,
  FetchNearIntentStatusInput,
  RequireIntentBindsInput,
  VerifyNearIntentOnChainInput,
  RateOracleConfig,
  VerifyDepositParams,
} from './verification/index.js';
export { verifyTxCancel, verifyLockAddressSpent, discoverAndVerifyTxCancel } from './lib/bitcoin/tx-verify.js';
export { verifyXmrLocked } from './lib/monero/verify-lock.js';
export type { XmrLockVerification, VerifyXmrLockParams } from './lib/monero/verify-lock.js';
export { verifySweepTx } from './lib/monero/verify-sweep.js';
export type { SweepVerificationResult, SweepConstructionData } from './lib/monero/verify-sweep.js';
export { scanTransactionOutputs } from './lib/monero/output-scanner.js';
export type { ScannedOutput } from './lib/monero/output-scanner.js';

// Server-response shapes inferred from zod schemas in src/wire/server/.
// Re-exported so consumers can validate cached data / external snapshots.
export {
  apiEnvelopeSchema,
  tolerantEnum,
  isKnownEnumValue,
  DecimalAmountSchema,
  NonNegativeDecimalSchema,
  IsoTimestampSchema,
  SwapIdSchema,
  SwapNumberSchema,
  TxHashSchema,
  swapTokenInfoSchema,
  swapTokenMapSchema,
  swapPairSchema,
  swapProviderSchema,
  swapFeeSchema,
  swapQuoteSchema,
  quotesResponseSchema,
  rateResponseSchema,
  limitsResponseSchema,
  providerInfoSchema,
  providersResponseSchema,
  providerLiquidityDataSchema,
  providerLiquidityEntrySchema,
  liquidityEntrySchema,
  liquidityTotalsSchema,
  liquidityResponseSchema,
  swapStatusSchema,
  swapAccessSchema,
  isRestrictedDetail,
  swapVerificationSchema,
  requiredActionSchema,
  requiredActionTypeSchema,
  actionUrgencySchema,
  createSwapBodySchema,
  createSwapResponseSchema,
  swapDetailSchema,
  swapProtocolDataSchema,
  protocolParamsSchema,
  recentSwapSchema,
  preSigsSchema,
  swapActionBodySchema,
  swapActionResponseSchema,
  actionProtocolDataSchema,
  powChallengeSchema,
  powPayloadSchema,
  verifyKeysBodySchema,
  verifyKeysResponseSchema,
  chainflipVerificationSchema,
  thorchainVerificationSchema,
  nearIntentsVerificationSchema,
  atomicSwapVerificationSchema,
} from './wire/server/index.js';

export type {
  SwapTokenInfo,
  SwapTokenMap,
  SwapPair,
  SwapFee,
  SwapProvider,
  SwapQuote,
  QuotesResponse,
  RateResponse,
  LimitsResponse,
  ProviderInfo,
  ProvidersResponse,
  ProviderLiquidityData,
  ProviderLiquidityEntry,
  ProviderLiquidityOutcome,
  LiquidityEntry,
  LiquiditySource,
  LiquidityTotals,
  LiquidityType,
  LiquidityResponse,
  SwapStatus,
  SwapAccess,
  SwapVerification,
  ChainflipVerification,
  ThorchainVerification,
  NearIntentsVerification,
  AtomicSwapVerification,
  RequiredAction,
  RequiredActionType,
  ActionUrgency,
  CreateSwapBody,
  CreateSwapResponse,
  SwapDetail,
  SwapDetailProtocolData,
  RecentSwap,
  PreSigs,
  SwapAction,
  SwapActionResponse,
  SwapActionProtocolData,
  PowChallenge,
  PowPayload,
  VerifyKeysBody,
  VerifyKeysResponse,
  SwapProtocolData,
} from './wire/server/index.js';

// Client-side types (not server-response shapes).
export type { HistoryEntry, ProtocolData } from './types/api.js';
export { isAtomicProtocolData } from './types/api.js';
export type {
  ClientKeys,
  ClientKeysApi,
  VerificationCheck,
  VerificationResult,
  ErrorCode,
  TerminalStatus,
  ProtocolParams,
  FeePolicy,
  AmnestyPolicy,
  DustPolicy,
  SafeBigInt,
  BlockHeightSource,
} from './types/index.js';
export {
  TERMINAL_STATUSES,
  DEFAULT_FEE_POLICY,
  DEFAULT_AMNESTY_POLICY,
  DEFAULT_DUST_POLICY,
  ERROR_CODES,
  VerificationError,
  ProtocolError,
} from './types/index.js';

// Network: HTTP client, retry policy, blockchain providers.
export { ApiClient, ApiError, NetworkError } from './api/index.js';
export type {
  ApiClientConfig,
  GetQuotesParams,
  GetRateParams,
  GetLimitsParams,
} from './api/index.js';
export {
  MiradexError,
  classifyError,
  errorMessage,
  isRetryable,
  isUnboundedRetry,
  deriveApiCategory,
} from './lib/errors.js';
export type { ErrorCategory, MiradexErrorOptions } from './lib/errors.js';
export { withRetry, computeBackoffMs } from './lib/retry.js';
export type { RetryOptions, RetryInfo } from './lib/retry.js';
export { createQuorumProvider } from './blockchain/quorum-provider.js';
export type { QuorumProviderConfig } from './blockchain/quorum-provider.js';
export type {
  BlockchainDataProvider,
  Utxo,
  ScriptHashHistoryEntry,
} from './interfaces/blockchain.js';
export { addressToScriptHash, parseElectrumUrl } from './lib/bitcoin/script-hash.js';
export type { ElectrumServer } from './lib/bitcoin/script-hash.js';
export {
  checkDeposit,
  watchForDeposit,
  estimateLockTxFee,
  resolveElectrumServers,
} from './lib/bitcoin/deposit-watcher.js';
export type {
  WatchDepositParams,
  CheckDepositParams,
  EstimateFeeParams,
} from './lib/bitcoin/deposit-watcher.js';
export {
  buildSweepTx,
  estimateSweep,
  broadcastSweep,
  fetchUtxo,
  listConfirmedUtxos,
  pickPrimaryUtxo,
  aggregateUtxosAsDeposit,
} from './lib/bitcoin/sweep.js';
export type { SweepEstimate } from './lib/bitcoin/sweep.js';
export {
  fetchTransaction,
  fetchTransactionQuorum,
  fetchOutputKeys,
  fetchChainHeight,
  fetchOutputDistribution,
  fetchFeeEstimate,
  broadcastTransaction,
  MAINNET_NODES,
  STAGENET_NODES,
} from './lib/monero/rpc.js';
export type {
  MonerodConfig,
  MoneroQuorumConfig,
  MoneroTxJson,
  FetchedTransaction,
  OutputKeyInfo,
  FeeEstimate as MoneroFeeEstimate,
} from './lib/monero/rpc.js';
export { sweepMonero } from './atomic-swap/monero-sweep/index.js';

// WASM is loaded once per process via ensureWasm(); the wrappers below
// operate on the cached module.
export {
  ensureWasm,
  generateClientKeys,
  generateClientKeysFromSeed,
  verifyDleqProof,
  signDigest,
  encsignDigest,
  decryptSignature,
  verifyEncsig,
  recoverAdaptorScalar,
  deriveKeyImages,
  selectDecoys,
  signSweepTx,
  computeCommitmentMask,
  verifyCommitment,
  decryptAmount,
  secp256k1ScalarToEd25519,
  ed25519ScalarAdd,
  isKeygenAvailable,
  initKeygen,
} from './lib/crypto/wasm.js';
export { WasmError } from './lib/crypto/errors.js';
export type { EnsureWasmOptions } from './lib/crypto/wasm.js';
export type { WasmModule } from './lib/crypto/types.js';
export { detectPlatform } from './lib/crypto/platform.js';
export type { Platform } from './lib/crypto/platform.js';

// Utilities: addresses, wallets, keystore, mnemonic, snapshot, PoW, scalars, defaults.
export { validateAddress, resolveChain, getSupportedChains, tokensForChain } from './address/index.js';
export type { ValidationResult } from './address/index.js';
export {
  createTempWallet,
  signPsbt,
  buildAndSignFundingPsbt,
  walletFromWif,
  buildUnsignedFundingPsbt,
  signFundingPsbt,
} from './lib/bitcoin/wallet.js';
export type { TempBtcWallet, UnsignedFundingPsbt } from './lib/bitcoin/wallet.js';
export { createKeystore, parseKeystore } from './lib/keystore.js';
export type { SwapKeystore, KeystoreDerivation } from './lib/keystore.js';
export { generateMnemonicKeys, deriveFromMnemonic } from './lib/crypto/mnemonic.js';
export { MnemonicError } from './lib/crypto/mnemonic.js';
export { deriveLibp2pIdentity } from './lib/crypto/libp2p-identity.js';
export type { DerivedLibp2pIdentity } from './lib/crypto/libp2p-identity.js';
export {
  buildProtocolSnapshot,
  canonicalSerialize,
  computeSnapshotDigest,
  verifySnapshotIntegrity,
  SNAPSHOT_VERSION,
} from './atomic-swap/snapshot.js';
export type {
  ProtocolSnapshot,
  ProtocolSnapshotPhase,
  ProtocolParamsSnapshot,
  LockTxSnapshot,
  MakerSnapshot,
  ChainSnapshot,
  BuildProtocolSnapshotInput,
} from './atomic-swap/snapshot.js';
export { solveChallenge, encodePowHeader } from './lib/pow-solver.js';
export { addScalars, bytesToBigInt, bigIntToBytes } from './lib/crypto/scalars.js';
export {
  ED25519_GROUP_ORDER,
  bytesToBigIntBE,
  bytesToBigIntLE,
  hexToScalarLE,
} from './lib/crypto/scalars.js';
export {
  bytesToHex,
  hexToBytes,
  uint8ArrayEquals,
  constantTimeEqualHex,
  wipe,
} from './lib/crypto/bytes.js';
export { delay } from './lib/delay.js';
export {
  SWAP_WASM_SHA256,
  KEYGEN_WASM_SHA256,
  MONERO_SWEEP_WASM_SHA256,
} from './wasm-pins.js';
export * from './lib/default-config.js';

// Logger.
export type { Logger } from './interfaces/logger.js';
export { noopLogger } from './interfaces/logger.js';

import type { Logger } from '../interfaces/logger.js';
import type { SwapApi } from '../api/index.js';
import type { VerificationResult, ClientKeys } from '../types/index.js';
import type { TempBtcWallet } from '../lib/bitcoin/wallet.js';
import type { SwapKeystore } from '../lib/keystore.js';
import type { DetectedDeposit } from '../lib/bitcoin/deposit-watcher.js';
import type { BlockchainDataProvider } from '../interfaces/blockchain.js';

export type AtomicSwapStage =
  | 'keygen'
  | 'keystore_saved'
  | 'awaiting_deposit'
  | 'deposit_detected'
  | 'creating_swap'
  | 'signing_psbt'
  | 'funding'
  | 'submit_encsig'
  | 'verifying_xmr'
  | 'confirming'
  | 'sweeping'
  | 'complete'
  | 'cancelled'
  | 'error'
  | 'initializing'
  | 'pending'
  | 'awaiting_funding'
  | 'deposited'
  | 'swapping'
  | 'sending'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'cancelling'
  | 'withheld'
  | 'expired'
  | 'punished'
  | `unknown:${string}`;

// Per-stage fields (`message` is always set):
//   keygen | cancelled | error           - message only (+ swapId on error)
//   keystore_saved                       - keystoreId, depositAddress
//   awaiting_deposit                     - depositAddress, depositAmount, qr?, expectedOutput?
//   deposit_detected                     - depositAddress
//   creating_swap                        - swapId?, swapNumber?, expectedOutput?
//   signing_psbt                         - swapId, verification?
//   funding | submit_encsig | verifying_xmr | confirming | sweeping
//                                        - swapId
//   complete                             - swapId, txHash
//   error                                - swapId?, errorCode?
// Single readonly shape (not a discriminated union) to preserve call-site
// compatibility; UIs narrow by inspecting `stage`.
export interface AtomicSwapProgress {
  readonly stage: AtomicSwapStage;
  readonly message: string;
  readonly keystoreId?: string;
  readonly depositAddress?: string;
  readonly depositAmount?: string;
  readonly swapId?: string;
  readonly txHash?: string;
  readonly qr?: string;
  readonly expectedOutput?: string;
  readonly swapNumber?: string;
  readonly verification?: VerificationResult;
  /** Set on stage='error'. Maps to one of `ERROR_CODES`. */
  readonly errorCode?: string;
}

export type ProgressCallback = (p: AtomicSwapProgress) => void;

export interface AtomicSwapCallbacks {
  readonly onProgress: ProgressCallback;
  readonly onDepositRequired: (address: string, amount: string, qr?: string) => void;
  readonly saveKeystore: (id: string, json: string) => Promise<void>;
  readonly loadKeystore: (id: string) => Promise<string | null>;
  // Called once per swap, after /presigs and before /fund. The snapshot pairs
  // with the keystore for cross-binary recovery (e.g. eigenwallet CLI).
  // Optional for back-compat.
  readonly saveProtocolSnapshot?: (swapId: string, snapshotJson: string) => Promise<void>;
  readonly loadProtocolSnapshot?: (swapId: string) => Promise<string | null>;
}

export interface AtomicSwapParams {
  readonly amount: string;
  readonly destAddress: string;
  readonly refundAddress: string;
  readonly network?: 'mainnet' | 'testnet' | 'regtest';
  readonly blockchain?: BlockchainDataProvider;
  readonly logger?: Logger;
  readonly monerodNodes?: readonly string[];
  // Pin a maker by variantId from /quotes (e.g. "maker-K4ZK7eSx"); otherwise
  // the server picks. Useful for multi-maker load-distribution tests.
  readonly variantId?: string;
}

export interface AtomicSwapHandle {
  readonly keystoreId: string;
  readonly depositAddress: string;
  readonly abort: () => void;
}

export interface RunAtomicSwapOptions {
  readonly api: SwapApi;
  readonly params: AtomicSwapParams;
  readonly callbacks: AtomicSwapCallbacks;
  readonly signal?: AbortSignal;
  readonly fetchFn?: typeof globalThis.fetch;
}

export interface ResumeAtomicSwapParams {
  readonly keystore: SwapKeystore;
  readonly deposit: DetectedDeposit;
  readonly network?: 'mainnet' | 'testnet' | 'regtest';
  readonly blockchain?: BlockchainDataProvider;
  readonly logger?: Logger;
  readonly existingSwapId?: string;
  readonly monerodNodes?: readonly string[];
  // Pins a maker on the createSwap call. Ignored when existingSwapId is set
  // (the maker was already chosen).
  readonly variantId?: string;
}

export interface ResumeAtomicSwapOptions {
  readonly api: SwapApi;
  readonly params: ResumeAtomicSwapParams;
  readonly onProgress: ProgressCallback;
  readonly signal?: AbortSignal;
  readonly fetchFn?: typeof globalThis.fetch;
  // Resume path only writes a snapshot if none was captured yet and the swap
  // is still pre-fund; normally the snapshot was written during the original
  // run between /presigs and /fund.
  readonly saveProtocolSnapshot?: (swapId: string, snapshotJson: string) => Promise<void>;
  readonly loadProtocolSnapshot?: (swapId: string) => Promise<string | null>;
}

export interface SubmitEncsigParams {
  readonly api: SwapApi;
  readonly swapId: string;
  readonly keys: Pick<ClientKeys, 'b' | 'B'>;
  readonly signedPsbtBase64: string;
  readonly network: 'mainnet' | 'testnet' | 'regtest';
  readonly onProgress: ProgressCallback;
  readonly signal?: AbortSignal;
}

export interface DriveSwapOptions {
  readonly api: SwapApi;
  readonly swapId: string;
  readonly keystoreId: string;
  readonly wallet: TempBtcWallet;
  readonly deposit: DetectedDeposit;
  readonly keystore: SwapKeystore;
  readonly network: 'mainnet' | 'testnet' | 'regtest';
  readonly onProgress: ProgressCallback;
  readonly signal?: AbortSignal;
  readonly logger: Logger;
  // Resume path uses this to fetch raw TxLock hex for local redeem-digest
  // recompute. Fresh-fund path never reads from it.
  readonly blockchain?: BlockchainDataProvider;
  // Driver writes a snapshot between /presigs and /fund, before any on-chain
  // commitment. Optional.
  readonly saveProtocolSnapshot?: (swapId: string, snapshotJson: string) => Promise<void>;
  readonly loadProtocolSnapshot?: (swapId: string) => Promise<string | null>;
  /** Maker peer-id captured at swap-creation time, for the snapshot. */
  readonly makerPeerId?: string;
  /** Maker multiaddrs captured at swap-creation time, for the snapshot. */
  readonly makerMultiaddrs?: ReadonlyArray<string>;
  /** Package version stamped into the snapshot for diagnostics. */
  readonly clientVersion?: string;
  /** Override for Monero RPC nodes. Defaults to DEFAULT_NODES[network].monero. */
  readonly monerodNodes?: readonly string[];
}

export interface FundingProofEntry {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  readonly address: string;
  readonly nonce: string;
  readonly signature: string;
}

// Lives in lib/errors.ts to keep retry.ts free of an api/index.js cycle;
// re-exported here so the historical import path still works.
export { SwapCancelledError } from '../lib/errors.js';

// Reference adapters: NodeAdapter (Electrum, fs, qrcode-terminal),
// BrowserAdapter (mempool, localStorage, QR canvas).

import type { SwapKeystore } from '../lib/keystore.js';
import type { Logger } from '../interfaces/logger.js';
import type { BlockchainQuerier } from './blockchain-querier.js';
import type { BlockchainDataProvider } from '../interfaces/blockchain.js';
import type { ProtocolParams } from '../types/index.js';

// Single UTXO input for a PSBT.
export interface UtxoInput {
  readonly txid: string;
  readonly vout: number;
  readonly value: number; // satoshis
  readonly height: number;
}

// With multiple UTXOs on the address: `value` is the sum, `txid`/`vout`
// point at the primary, individual UTXOs are in `utxos`.
export interface DetectedDeposit {
  readonly txid: string;
  readonly vout: number;
  readonly value: number; // satoshis (sum of utxos when present)
  readonly confirmations: number;
  readonly status: 'mempool' | 'confirmed';
  readonly utxos?: readonly UtxoInput[];
}

export interface FeeEstimate {
  readonly feeSats: number;
  readonly feeRate: number; // sat/vbyte
}

// id is an opaque path / localStorage key.
export interface KeystoreSaveResult {
  readonly id: string;
}

// Listing-only metadata (no key material).
export interface KeystoreMetadata {
  readonly id: string; // opaque identifier
  readonly btcAddress: string;
  readonly destAddress: string;
  readonly refundAddress: string;
  readonly amount: string;
  readonly network: 'mainnet' | 'testnet' | 'regtest';
  readonly status: KeystoreStatus;
  readonly depositTxid: string | null;
  readonly depositValue: number | null;
  readonly swapId: string | null;
  readonly createdAt: string;
}

export type KeystoreStatus =
  | 'created'
  | 'awaiting_deposit'
  | 'deposited'
  | 'swap_created'
  | 'completed'
  | 'swept'
  | 'cancelled';

export interface PlatformAdapter {
  // Resolves when a mempool or confirmed deposit appears on `address`.
  watchDeposit(
    address: string,
    network: 'mainnet' | 'testnet' | 'regtest',
    signal: AbortSignal,
    onStatus?: (msg: string) => void,
  ): Promise<DetectedDeposit>;

  // One-shot. Returns null on no deposit.
  checkDeposit(
    address: string,
    network: 'mainnet' | 'testnet' | 'regtest',
  ): Promise<DetectedDeposit | null>;

  // Used on resume when the deposit is known but UTXO details are stale.
  fetchUtxo(
    address: string,
    network: 'mainnet' | 'testnet' | 'regtest',
  ): Promise<DetectedDeposit | null>;

  estimateFee(network: 'mainnet' | 'testnet' | 'regtest'): Promise<FeeEstimate>;

  // Holds private keys. Must be stored with care:
  // node = chmod 0o600, browser = localStorage + download backup.
  saveKeystore(keystore: SwapKeystore, label: string): Promise<KeystoreSaveResult>;

  loadKeystore(id: string): Promise<SwapKeystore>;

  // Metadata only (no key material).
  listKeystores(): Promise<readonly KeystoreMetadata[]>;

  deleteKeystore(id: string): Promise<void>;

  // Optional write-through cache of per-swap ProtocolParams keyed by swapId.
  // Used as a fallback during client-side refund when the server is briefly
  // unreachable. Public data only (no key material), so plain fs / localStorage
  // is fine. Pair with loadSwapProtocol or omit both.
  readonly saveSwapProtocol?: (
    swapId: string,
    params: ProtocolParams,
  ) => Promise<void>;

  // Counterpart to saveSwapProtocol. Returns null on miss; must NOT throw.
  readonly loadSwapProtocol?: (
    swapId: string,
  ) => Promise<ProtocolParams | null>;

  // One-shot recovery snapshot. Written between /presigs and /fund, so it's
  // on disk before any on-chain commitment. Public data (Alice's encsig,
  // protocol params, maker info, unsigned PSBT). chmod 0o600 / fsync where
  // possible. Pair with loadProtocolSnapshot or omit both.
  readonly saveProtocolSnapshot?: (swapId: string, snapshotJson: string) => Promise<void>;

  // Counterpart to saveProtocolSnapshot. Null on miss; lets the SDK skip
  // re-writing.
  readonly loadProtocolSnapshot?: (swapId: string) => Promise<string | null>;

  // Node = qrcode-terminal ASCII; browser = qrcode data URL / SVG.
  generateQr(text: string): Promise<string>;

  // Node = Electrum then mempool.space; browser = mempool.space POST /tx.
  broadcastTx(rawHex: string, network: 'mainnet' | 'testnet' | 'regtest'): Promise<string>;

  // Independent BTC querier used by zero-trust TxCancel verification — never
  // trusts the server's hex.
  createBlockchainQuerier(network: 'mainnet' | 'testnet' | 'regtest'): BlockchainQuerier;

  // Electrum-style scriptHash queries used by discoverAndVerifyTxCancel.
  createBlockchainProvider(network: 'mainnet' | 'testnet' | 'regtest'): Promise<BlockchainDataProvider>;

  readonly logger: Logger;
}

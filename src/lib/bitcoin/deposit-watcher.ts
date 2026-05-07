// Primary: caller-injected BlockchainDataProvider (Electrum, WebSocket, ...).
// Fallback: mempool.space REST.

import { delay } from '../delay.js';
import { addressToScriptHash, parseElectrumUrl, type ElectrumServer } from './script-hash.js';
import type { BlockchainDataProvider, Utxo } from '../../interfaces/blockchain.js';
import {
  MEMPOOL_API,
  MEMPOOL_TESTNET_API,
  LOCK_TX_VBYTES,
  FALLBACK_FEE_RATE,
  MIN_FEE_RATE,
  MAX_FEE_RATE_MAINNET,
  MAX_FEE_RATE_TESTNET,
  FEE_MARGIN_MULTIPLIER,
  DEPOSIT_POLL_MS,
  MAX_DEPOSIT_UTXOS,
} from '../default-config.js';
import { VerificationError } from '../../types/index.js';

export interface UtxoInput {
  readonly txid: string;
  readonly vout: number;
  readonly value: number; // satoshis
  readonly height: number;
}

export interface DetectedDeposit {
  readonly txid: string;
  readonly vout: number;
  readonly value: number; // satoshis (sum of all UTXOs when utxos is present)
  readonly confirmations: number;
  readonly status: 'mempool' | 'confirmed';
  readonly utxos?: readonly UtxoInput[];
}

export interface WatchDepositParams {
  readonly address: string;
  readonly network?: 'mainnet' | 'testnet' | 'regtest';
  readonly onStatus?: (msg: string) => void;
  readonly signal?: AbortSignal;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly blockchain?: BlockchainDataProvider;
}

export interface CheckDepositParams {
  readonly address: string;
  readonly network?: 'mainnet' | 'testnet' | 'regtest';
  readonly fetchFn?: typeof globalThis.fetch;
  readonly blockchain?: BlockchainDataProvider;
}

export interface EstimateFeeParams {
  readonly network?: 'mainnet' | 'testnet' | 'regtest';
  readonly fetchFn?: typeof globalThis.fetch;
  readonly blockchain?: BlockchainDataProvider;
}

interface MempoolVout {
  scriptpubkey_address: string;
  value: number;
}

interface MempoolTx {
  txid: string;
  vout: MempoolVout[];
  status: { confirmed: boolean };
}

export function resolveElectrumServers(configServer?: string): readonly ElectrumServer[] {
  if (!configServer || configServer === 'mempool.space') {
    return [];
  }
  return [parseElectrumUrl(configServer)];
}

// Provider first, mempool.space fallback. Null on no deposit.
export async function checkDeposit(params: CheckDepositParams): Promise<DetectedDeposit | null> {
  const { address, network = 'mainnet', fetchFn = globalThis.fetch, blockchain } = params;

  if (blockchain) {
    const deposit = await checkDepositProvider(address, network, blockchain);
    if (deposit !== null) return deposit;
  }

  return checkDepositMempool(address, network, fetchFn);
}

function aggregateUtxos(utxos: readonly Utxo[]): DetectedDeposit {
  if (utxos.length > MAX_DEPOSIT_UTXOS) {
    throw new VerificationError(
      'E_DEPOSIT_TOO_MANY_UTXOS',
      `deposit address received ${String(utxos.length)} UTXOs (cap ${String(MAX_DEPOSIT_UTXOS)}), possible dust-storm attack`,
    );
  }
  const primary = utxos[0];
  if (!primary) {
    throw new Error('aggregateUtxos called with empty utxo list');
  }
  const totalValue = utxos.reduce((sum, u) => sum + u.value, 0);
  const hasMempool = utxos.some((u) => u.confirmations === 0);
  const minConfirmations = hasMempool
    ? 0
    : Math.min(...utxos.map((u) => u.confirmations));

  return {
    txid: primary.txid,
    vout: primary.vout,
    value: totalValue,
    confirmations: minConfirmations,
    status: hasMempool ? 'mempool' : 'confirmed',
    utxos: utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, height: u.height ?? 0 })),
  };
}

async function checkDepositProvider(
  address: string,
  network: 'mainnet' | 'testnet' | 'regtest',
  blockchain: BlockchainDataProvider,
): Promise<DetectedDeposit | null> {
  try {
    const scriptHash = addressToScriptHash(address, network);
    const utxos = await blockchain.listUnspent(scriptHash);
    if (utxos.length === 0) return null;
    return aggregateUtxos(utxos);
  } catch {
    return null;
  }
}

async function checkDepositMempool(
  address: string,
  network: 'mainnet' | 'testnet' | 'regtest',
  fetchFn: typeof globalThis.fetch,
): Promise<DetectedDeposit | null> {
  const baseUrl = network === 'mainnet' ? MEMPOOL_API : MEMPOOL_TESTNET_API;
  try {
    const collected: UtxoInput[] = [];
    let hasMempool = false;

    const mempoolRes = await fetchFn(`${baseUrl}/address/${address}/txs/mempool`);
    const mempoolTxs = (await mempoolRes.json()) as MempoolTx[];
    for (const tx of mempoolTxs) {
      for (let i = 0; i < tx.vout.length; i++) {
        const output = tx.vout[i]!;
        if (output.scriptpubkey_address === address) {
          collected.push({ txid: tx.txid, vout: i, value: output.value, height: 0 });
          hasMempool = true;
        }
      }
    }

    const confirmedRes = await fetchFn(`${baseUrl}/address/${address}/txs`);
    const confirmedTxs = (await confirmedRes.json()) as MempoolTx[];
    for (const tx of confirmedTxs) {
      for (let i = 0; i < tx.vout.length; i++) {
        const output = tx.vout[i]!;
        if (output.scriptpubkey_address === address) {
          const height = tx.status.confirmed ? 1 : 0;
          collected.push({ txid: tx.txid, vout: i, value: output.value, height });
          if (!tx.status.confirmed) hasMempool = true;
        }
      }
    }

    if (collected.length === 0) return null;

    const primary = collected[0]!;
    const totalValue = collected.reduce((sum, u) => sum + u.value, 0);
    return {
      txid: primary.txid,
      vout: primary.vout,
      value: totalValue,
      confirmations: hasMempool ? 0 : 1,
      status: hasMempool ? 'mempool' : 'confirmed',
      utxos: collected,
    };
  } catch {
    return null;
  }
}

// Provider primary, per-poll mempool.space fallback if absent or failing.
export async function watchForDeposit(params: WatchDepositParams): Promise<DetectedDeposit> {
  const {
    address,
    network = 'mainnet',
    onStatus,
    signal,
    fetchFn = globalThis.fetch,
  } = params;
  let { blockchain } = params;
  const scriptHash = addressToScriptHash(address, network);

  if (blockchain) {
    onStatus?.('Connected to blockchain provider');
  } else {
    onStatus?.('Using mempool.space fallback...');
  }

  while (!signal?.aborted) {
    if (blockchain) {
      try {
        const utxos = await blockchain.listUnspent(scriptHash);
        if (utxos.length > 0) {
          onStatus?.('Deposit detected via blockchain provider');
          return aggregateUtxos(utxos);
        }
        onStatus?.('Waiting for BTC deposit...');
      } catch {
        onStatus?.('Blockchain provider error, falling back to mempool.space...');
        blockchain = undefined;
      }
    } else {
      const deposit = await checkDepositMempool(address, network, fetchFn);
      if (deposit) {
        onStatus?.('Deposit detected via mempool.space');
        return deposit;
      }
      onStatus?.('Waiting for BTC deposit...');
    }

    await delay(DEPOSIT_POLL_MS);
  }

  throw new Error('Deposit watch aborted');
}

interface MempoolFeeEstimate {
  readonly fastestFee: number;
  readonly halfHourFee: number;
  readonly hourFee: number;
  readonly economyFee: number;
  readonly minimumFee: number;
}

// Provider (6-block target) -> mempool.space -> 10 sat/vB fallback.
export async function estimateLockTxFee(
  params: EstimateFeeParams = {},
): Promise<{ readonly feeSats: number; readonly feeRate: number }> {
  const { network = 'mainnet', fetchFn = globalThis.fetch, blockchain } = params;

  if (blockchain) {
    const providerResult = await estimateFeeProvider(blockchain, network);
    if (providerResult) return providerResult;
  }

  const mempoolResult = await estimateFeeMempool(network, fetchFn);
  if (mempoolResult) return mempoolResult;

  return { feeSats: Math.ceil(LOCK_TX_VBYTES * FALLBACK_FEE_RATE), feeRate: FALLBACK_FEE_RATE };
}

function maxFeeRateFor(network: 'mainnet' | 'testnet' | 'regtest'): number {
  return network === 'mainnet' ? MAX_FEE_RATE_MAINNET : MAX_FEE_RATE_TESTNET;
}

// Floor (Electrum minrelaytxfee), pad (mempool drift between estimate and
// broadcast), ceiling (oracle inflation, especially testnet halfHourFee).
function applyFeePolicy(
  rawSatPerVbyte: number,
  network: 'mainnet' | 'testnet' | 'regtest',
): number {
  const padded = Math.ceil(rawSatPerVbyte * FEE_MARGIN_MULTIPLIER);
  const floored = Math.max(MIN_FEE_RATE, padded);
  return Math.min(maxFeeRateFor(network), floored);
}

async function estimateFeeProvider(
  blockchain: BlockchainDataProvider,
  network: 'mainnet' | 'testnet' | 'regtest',
): Promise<{ readonly feeSats: number; readonly feeRate: number } | null> {
  try {
    const btcPerKb = await blockchain.estimateFee(6);
    if (btcPerKb <= 0) return null;
    const raw = Math.ceil((btcPerKb * 1e8) / 1000);
    const satPerVbyte = applyFeePolicy(raw, network);
    return { feeSats: Math.ceil(LOCK_TX_VBYTES * satPerVbyte), feeRate: satPerVbyte };
  } catch {
    return null;
  }
}

async function estimateFeeMempool(
  network: 'mainnet' | 'testnet' | 'regtest',
  fetchFn: typeof globalThis.fetch,
): Promise<{ readonly feeSats: number; readonly feeRate: number } | null> {
  const baseUrl = network === 'mainnet' ? MEMPOOL_API : MEMPOOL_TESTNET_API;
  try {
    const res = await fetchFn(`${baseUrl}/v1/fees/recommended`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as MempoolFeeEstimate;
    const base = data.halfHourFee > 0 ? data.halfHourFee : FALLBACK_FEE_RATE;
    const rate = applyFeePolicy(base, network);
    return { feeSats: Math.ceil(LOCK_TX_VBYTES * rate), feeRate: rate };
  } catch {
    return null;
  }
}

// Sweep keystore UTXO(s) to a user-specified destination, full balance minus fee.

import * as bitcoin from 'bitcoinjs-lib';
import { walletFromWif } from './wallet.js';
import { addressToScriptHash } from './script-hash.js';
import type { BlockchainDataProvider, Utxo } from '../../interfaces/blockchain.js';
import { type DetectedDeposit, estimateLockTxFee } from './deposit-watcher.js';
import {
  MEMPOOL_API,
  MEMPOOL_TESTNET_API,
  MAX_DEPOSIT_UTXOS,
  BROADCAST_TIMEOUT_MS,
} from '../default-config.js';
import { VerificationError, DEFAULT_DUST_POLICY } from '../../types/index.js';

export interface SweepEstimate {
  readonly sendSats: number;
  readonly feeSats: number;
  readonly feeRate: number;
  readonly destAddress: string;
  readonly fromAddress: string;
}

export interface SweepResult {
  readonly txid: string;
  readonly sendSats: number;
  readonly feeSats: number;
}

const P2WPKH_INPUT_VBYTES = 68;
// Tx overhead + single P2WPKH output.
const TX_OVERHEAD_VBYTES = 42;

function estimateSweepVbytes(inputCount: number): number {
  return P2WPKH_INPUT_VBYTES * inputCount + TX_OVERHEAD_VBYTES;
}

// Same Electrum -> mempool.space -> fallback chain as the lock-tx fee path.
// Fee scales with input count.
export async function estimateSweep(
  deposit: DetectedDeposit,
  fromAddress: string,
  destAddress: string,
  network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet',
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  blockchain?: BlockchainDataProvider,
): Promise<SweepEstimate> {
  const { feeRate } = await estimateLockTxFee({ network, fetchFn, blockchain });
  const inputCount = deposit.utxos ? deposit.utxos.length : 1;
  const feeSats = Math.ceil(estimateSweepVbytes(inputCount) * feeRate);
  const sendSats = deposit.value - feeSats;

  if (sendSats <= 0) {
    throw new Error(
      `Balance too small: ${String(deposit.value)} sats cannot cover ${String(feeSats)} sat fee`,
    );
  }

  return { sendSats, feeSats, feeRate, destAddress, fromAddress };
}

// Consolidates all UTXOs (deposit.utxos or the deposit itself) into one
// output to destAddress. Returns raw hex ready to broadcast.
export function buildSweepTx(
  wif: string,
  deposit: DetectedDeposit,
  destAddress: string,
  sendSats: number,
  network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet',
): string {
  const net = network === 'mainnet' ? bitcoin.networks.bitcoin : (network === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet);
  try { bitcoin.address.toOutputScript(destAddress, net); }
  catch {
    throw new VerificationError(
      'E_DEST_ADDR_INVALID',
      `destAddress ${destAddress} is invalid for ${network}`,
    );
  }
  const inputs = deposit.utxos ?? [deposit];
  if (inputs.length > MAX_DEPOSIT_UTXOS) {
    throw new VerificationError(
      'E_DEPOSIT_TOO_MANY_UTXOS',
      `sweep refuses ${String(inputs.length)} inputs (cap ${String(MAX_DEPOSIT_UTXOS)}), possible dust-storm attack`,
    );
  }
  if (BigInt(sendSats) < DEFAULT_DUST_POLICY.p2wpkhDustSats) {
    throw new VerificationError(
      'E_SWEEP_DUST',
      `sweep output ${String(sendSats)} below dust floor ${DEFAULT_DUST_POLICY.p2wpkhDustSats.toString()}`,
    );
  }
  const wallet = walletFromWif(wif, network);

  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(wallet.keyPair.publicKey),
    network: net,
  });

  if (!p2wpkh.output) throw new Error('Failed to derive P2WPKH script');

  const psbt = new bitcoin.Psbt({ network: net });

  for (const utxo of inputs) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: p2wpkh.output,
        value: BigInt(utxo.value),
      },
    });
  }

  psbt.addOutput({
    address: destAddress,
    value: BigInt(sendSats),
  });

  psbt.signAllInputs(wallet.keyPair);
  psbt.finalizeAllInputs();

  return psbt.extractTransaction().toHex();
}

// Electrum primary, mempool.space fallback.
export async function broadcastSweep(
  rawHex: string,
  network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet',
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  blockchain?: BlockchainDataProvider,
): Promise<string> {
  if (blockchain) {
    const txid = await broadcastViaProvider(rawHex, blockchain);
    if (txid) return txid;
  }
  return broadcastViaMempool(rawHex, network, fetchFn);
}

async function broadcastViaProvider(
  rawHex: string,
  blockchain: BlockchainDataProvider,
): Promise<string | null> {
  try {
    return await blockchain.broadcastTransaction(rawHex);
  } catch {
    return null;
  }
}

async function broadcastViaMempool(
  rawHex: string,
  network: 'mainnet' | 'testnet' | 'regtest',
  fetchFn: typeof globalThis.fetch,
): Promise<string> {
  const baseUrl = network === 'mainnet' ? MEMPOOL_API : MEMPOOL_TESTNET_API;
  const res = await fetchFn(`${baseUrl}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: rawHex,
    signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => 'unknown error');
    throw new Error(`Broadcast failed: ${body}`);
  }

  return (await res.text()).trim();
}

// Empty array when the provider is absent or there are no UTXOs.
export async function listConfirmedUtxos(input: {
  readonly address: string;
  readonly network: 'mainnet' | 'testnet' | 'regtest';
  readonly blockchain?: BlockchainDataProvider;
}): Promise<readonly Utxo[]> {
  if (!input.blockchain) return [];
  try {
    const scriptHash = addressToScriptHash(input.address, input.network);
    return await input.blockchain.listUnspent(scriptHash);
  } catch {
    return [];
  }
}

// Largest-value UTXO is "primary" for display.
export function pickPrimaryUtxo(utxos: readonly Utxo[]): Utxo | null {
  if (utxos.length === 0) return null;
  return utxos.reduce((best, u) => (u.value > best.value ? u : best));
}

// AV-A.20: throws E_DEPOSIT_TOO_MANY_UTXOS above MAX_DEPOSIT_UTXOS.
export function aggregateUtxosAsDeposit(utxos: readonly Utxo[]): DetectedDeposit | null {
  if (utxos.length === 0) return null;
  if (utxos.length > MAX_DEPOSIT_UTXOS) {
    throw new VerificationError(
      'E_DEPOSIT_TOO_MANY_UTXOS',
      `sweep refuses ${String(utxos.length)} inputs (cap ${String(MAX_DEPOSIT_UTXOS)}), possible dust-storm attack`,
    );
  }
  const primary = pickPrimaryUtxo(utxos);
  if (!primary) return null;
  const totalValue = utxos.reduce((sum, u) => sum + u.value, 0);
  const hasMempool = utxos.some((u) => u.confirmations === 0);
  return {
    txid: primary.txid,
    vout: primary.vout,
    value: totalValue,
    confirmations: hasMempool ? 0 : 1,
    status: hasMempool ? 'mempool' : 'confirmed',
    utxos: utxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      height: u.height ?? 0,
    })),
  };
}

// Composes listConfirmedUtxos + aggregateUtxosAsDeposit.
export async function fetchUtxo(
  address: string,
  network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet',
  blockchain?: BlockchainDataProvider,
): Promise<DetectedDeposit | null> {
  const utxos = await listConfirmedUtxos({ address, network, blockchain });
  if (utxos.length === 0) return null;
  try {
    return aggregateUtxosAsDeposit(utxos);
  } catch {
    return null;
  }
}

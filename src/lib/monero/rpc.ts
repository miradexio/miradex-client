// Multi-node fallback: try each node in order until one succeeds. Supports
// binary RPC (POST to path) and JSON-RPC (POST /json_rpc). Works on the
// restricted RPC port (18089 / 38089).

import type { Logger } from '../../interfaces/logger.js';
import { noopLogger } from '../../interfaces/logger.js';
import { VerificationError } from '../../types/index.js';

export interface MonerodConfig {
  readonly nodes: readonly string[];
  readonly logger?: Logger;
}

import {
  MONERO_MAINNET_NODES,
  MONERO_STAGENET_NODES,
} from '../default-config.js';

// Re-exports (source of truth in default-config.ts).
export const MAINNET_NODES = MONERO_MAINNET_NODES;
export const STAGENET_NODES = MONERO_STAGENET_NODES;

export interface MoneroTxJson {
  readonly extra: readonly number[];
  readonly unlock_time?: number;
  readonly vout: readonly {
    readonly amount: number;
    readonly target: {
      readonly tagged_key?: { readonly key: string; readonly view_tag: string };
      readonly key?: string;
    };
    readonly unlock_time?: number;
  }[];
  readonly rct_signatures: {
    readonly type: number;
    readonly ecdhInfo: readonly { readonly amount: string }[];
    readonly outPk: readonly string[];
  };
}

export interface FetchedTransaction {
  readonly txJson: MoneroTxJson;
  readonly blockHeight: number;
  readonly confirmations: number;
  readonly inPool: boolean;
  /** Global output indices for each output in the transaction. */
  readonly outputIndices: readonly number[];
  readonly txHash: string;
}

export interface OutputKeyInfo {
  readonly key: string;
  readonly mask: string;
  readonly unlocked: boolean;
  readonly height: number;
}

export interface FeeEstimate {
  readonly feePerByte: number;
  readonly quantizationMask: number;
}

async function tryNodes<T>(
  config: MonerodConfig,
  label: string,
  makeRequest: (nodeUrl: string) => Promise<T>,
): Promise<T> {
  const log = config.logger ?? noopLogger;
  const errors: string[] = [];

  for (const nodeUrl of config.nodes) {
    try {
      log.debug({ nodeUrl, label }, 'Trying monerod node');
      return await makeRequest(nodeUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${nodeUrl}: ${msg}`);
      log.warn({ nodeUrl, error: msg, label }, 'Monerod node failed, trying next');
    }
  }

  throw new Error(`${label}: all ${String(config.nodes.length)} nodes failed. Errors: ${errors.join('; ')}`);
}

// Returns the parsed tx JSON, global output indices, and metadata.
export async function fetchTransaction(
  config: MonerodConfig,
  txHash: string,
): Promise<FetchedTransaction> {
  return tryNodes(config, 'get_transactions', async (nodeUrl) => {
    const response = await fetch(`${nodeUrl}/get_transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txs_hashes: [txHash], decode_as_json: true }),
    });

    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);

    const result = (await response.json()) as {
      status: string;
      txs?: readonly {
        as_json: string;
        block_height: number;
        confirmations: number;
        in_pool: boolean;
        tx_hash: string;
        output_indices?: readonly number[];
      }[];
      missed_tx?: readonly string[];
    };

    if (result.status !== 'OK') throw new Error(`RPC status: ${result.status}`);
    if (!result.txs || result.txs.length === 0) {
      const missed = result.missed_tx?.join(', ') ?? txHash;
      throw new Error(`Transaction not found: ${missed}`);
    }

    const entry = result.txs[0];
    if (!entry) throw new Error('Empty txs array');

    return {
      txJson: JSON.parse(entry.as_json) as MoneroTxJson,
      blockHeight: entry.block_height,
      confirmations: entry.confirmations,
      inPool: entry.in_pool,
      outputIndices: entry.output_indices ?? [],
      txHash: entry.tx_hash,
    };
  });
}

export interface MoneroQuorumConfig {
  readonly nodes: readonly string[];
  readonly quorum: number;
  readonly timeoutMs: number;
  readonly logger?: Logger;
}

// AV-E.5: parallel quorum fetch from N nodes; require >=quorum to agree on
// canonical fields (extra, vout, ecdhInfo, unlock_time). Confirmations may
// drift by +/-2. Throws E_MONERO_QUORUM if too few nodes respond.
export async function fetchTransactionQuorum(
  config: MoneroQuorumConfig,
  lockTxHash: string,
): Promise<FetchedTransaction> {
  const log = config.logger ?? noopLogger;
  const attempts = config.nodes.map((url) =>
    withTimeout(fetchTransaction({ nodes: [url], logger: log }, lockTxHash), config.timeoutMs),
  );
  const settled = await Promise.allSettled(attempts);
  const successes = settled
    .filter((s): s is PromiseFulfilledResult<FetchedTransaction> => s.status === 'fulfilled')
    .map((s) => s.value);
  if (successes.length < config.quorum) {
    throw new VerificationError(
      'E_MONERO_QUORUM',
      `only ${String(successes.length)} of ${String(config.nodes.length)} nodes responded, need ${String(config.quorum)}`,
    );
  }
  return pickAgreeingTransaction(successes, config.quorum);
}

function canonicalTxKey(tx: FetchedTransaction): string {
  const { txJson } = tx;
  return JSON.stringify({
    extra: txJson.extra,
    unlock_time: txJson.unlock_time ?? 0,
    vout: txJson.vout,
    ecdhInfo: txJson.rct_signatures.ecdhInfo,
    outPk: txJson.rct_signatures.outPk,
  });
}

function pickAgreeingTransaction(
  successes: readonly FetchedTransaction[],
  quorum: number,
): FetchedTransaction {
  const buckets = new Map<string, FetchedTransaction[]>();
  for (const tx of successes) {
    const key = canonicalTxKey(tx);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(tx);
    else buckets.set(key, [tx]);
  }
  for (const [, txs] of buckets) {
    if (txs.length >= quorum) {
      const confirmations = medianConfirmations(txs);
      const first = txs[0];
      if (!first) continue;
      return { ...first, confirmations };
    }
  }
  throw new VerificationError(
    'E_MONERO_QUORUM',
    `no ${String(quorum)} nodes returned byte-identical transaction data`,
  );
}

function medianConfirmations(txs: readonly FetchedTransaction[]): number {
  const values = txs.map((t) => t.confirmations).sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${String(ms)}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))); },
    );
  });
}

// Output public keys + commitments by global index. Used to build the ring.
export async function fetchOutputKeys(
  config: MonerodConfig,
  globalIndices: readonly number[],
): Promise<readonly OutputKeyInfo[]> {
  return tryNodes(config, 'get_outs', async (nodeUrl) => {
    const response = await fetch(`${nodeUrl}/get_outs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outputs: globalIndices.map((index) => ({ amount: 0, index })),
        get_txid: false,
      }),
    });

    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);

    const result = (await response.json()) as {
      status: string;
      outs?: readonly OutputKeyInfo[];
    };

    if (result.status !== 'OK' || !result.outs) {
      throw new Error(`get_outs failed: ${result.status}`);
    }

    return result.outs;
  });
}

export async function fetchChainHeight(config: MonerodConfig): Promise<number> {
  return tryNodes(config, 'get_info', async (nodeUrl) => {
    const response = await fetch(`${nodeUrl}/get_info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);

    const result = (await response.json()) as { status: string; height: number };
    if (result.status !== 'OK') throw new Error(`get_info failed: ${result.status}`);

    return result.height;
  });
}

export interface BroadcastResult {
  readonly txHash: string;
  readonly status: string;
  // True when the tx was rejected as already-spent. Only we hold the spend key,
  // so this must be a prior broadcast of the same tx.
  readonly alreadySpent: boolean;
}

// double_spend is treated as a prior successful broadcast and returned as
// alreadySpent: true rather than thrown.
export async function broadcastTransaction(
  config: MonerodConfig,
  rawTxHex: string,
): Promise<BroadcastResult> {
  return tryNodes(config, 'send_raw_transaction', async (nodeUrl) => {
    const response = await fetch(`${nodeUrl}/send_raw_transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_as_hex: rawTxHex, do_not_relay: false }),
    });

    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);

    const result = (await response.json()) as {
      status: string;
      reason?: string;
      tx_hash?: string;
      double_spend?: boolean;
      fee_too_low?: boolean;
      invalid_input?: boolean;
      invalid_output?: boolean;
      too_big?: boolean;
      overspend?: boolean;
      too_few_outputs?: boolean;
      sanity_check_failed?: boolean;
      tx_extra_too_big?: boolean;
      low_mixin?: boolean;
    };

    if (result.status === 'OK') {
      return { txHash: result.tx_hash ?? '', status: 'OK', alreadySpent: false };
    }

    if (result.double_spend) {
      return { txHash: '', status: 'double_spend', alreadySpent: true };
    }

    const flags = Object.entries(result)
      .filter(([k, v]) => k !== 'status' && k !== 'reason' && k !== 'tx_hash' && v === true)
      .map(([k]) => k);
    const detail = flags.length > 0 ? ` [flags: ${flags.join(', ')}]` : '';
    throw new Error(
      `Daemon rejected tx: ${result.reason || 'unknown reason'}${detail} (status: ${result.status})`,
    );
  });
}

async function jsonRpc<T>(nodeUrl: string, method: string, params: unknown): Promise<T> {
  const response = await fetch(`${nodeUrl}/json_rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
  });

  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);

  const result = (await response.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };

  if (result.error) throw new Error(`JSON-RPC error: ${result.error.message}`);
  if (!result.result) throw new Error(`JSON-RPC returned no result for ${method}`);

  return result.result;
}

// Cumulative RCT output distribution per block, used by the gamma decoy
// picker. Returns absolute cumulative counts from block 0 (base added per
// entry). Must request binary:false; the default binary format embeds raw
// bytes that break JSON.parse.
export async function fetchOutputDistribution(
  config: MonerodConfig,
): Promise<readonly number[]> {
  return tryNodes(config, 'get_output_distribution', async (nodeUrl) => {
    const result = await jsonRpc<{
      status: string;
      distributions: readonly {
        amount: number;
        start_height: number;
        base: number;
        distribution: readonly number[];
        binary: boolean;
      }[];
    }>(nodeUrl, 'get_output_distribution', {
      amounts: [0],
      cumulative: true,
      from_height: 0,
      binary: false,
    });

    if (result.status !== 'OK' || !result.distributions || result.distributions.length === 0) {
      throw new Error(`get_output_distribution failed: ${result.status}`);
    }

    const dist = result.distributions[0];
    if (!dist) throw new Error('Empty distributions array');

    // from_height > 0 returns a base-relative distribution; add base for absolute.
    if (dist.base > 0) {
      return dist.distribution.map((v) => v + dist.base);
    }

    return dist.distribution;
  });
}

// Fee per byte in piconeros.
export async function fetchFeeEstimate(config: MonerodConfig): Promise<FeeEstimate> {
  return tryNodes(config, 'get_fee_estimate', async (nodeUrl) => {
    const result = await jsonRpc<{
      status: string;
      fee: number;
      quantization_mask: number;
    }>(nodeUrl, 'get_fee_estimate', { grace_blocks: 10 });

    if (result.status !== 'OK') {
      throw new Error(`get_fee_estimate failed: ${result.status}`);
    }

    return {
      feePerByte: result.fee,
      quantizationMask: result.quantization_mask,
    };
  });
}

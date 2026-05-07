// AV-E.4: N-of-M quorum BlockchainDataProvider. Reads require >=quorum
// underlying providers to agree. Broadcast is not gated — one honest relay
// is enough to reach the network.

import type {
  BlockchainDataProvider,
  ScriptHashHistoryEntry,
  Utxo,
} from '../interfaces/blockchain.js';
import type { Logger } from '../interfaces/logger.js';
import { noopLogger } from '../interfaces/logger.js';
import { VerificationError } from '../types/index.js';

export interface QuorumProviderConfig {
  readonly providers: ReadonlyArray<BlockchainDataProvider>;
  /** Minimum number of providers that must agree. Typically 2-of-3. */
  readonly quorum: number;
  readonly logger?: Logger;
}

// Throws E_QUORUM_IMPOSSIBLE when providers < quorum;
// method calls throw E_QUORUM_DISAGREE when too few agree.
export function createQuorumProvider(config: QuorumProviderConfig): BlockchainDataProvider {
  if (config.providers.length < config.quorum) {
    throw new VerificationError(
      'E_QUORUM_IMPOSSIBLE',
      `need ${String(config.quorum)} providers but only ${String(config.providers.length)} supplied`,
    );
  }
  const log = config.logger ?? noopLogger;
  const providers = config.providers;
  const quorum = config.quorum;

  return {
    async listUnspent(scriptHash: string): Promise<readonly Utxo[]> {
      const settled = await Promise.allSettled(providers.map((p) => p.listUnspent(scriptHash)));
      return pickQuorumUtxos(settled, quorum, log);
    },
    async getTransaction(txid: string): Promise<string> {
      const settled = await Promise.allSettled(providers.map((p) => p.getTransaction(txid)));
      return pickQuorumString(settled, quorum, log, 'getTransaction');
    },
    async getTransactionHeight(txid: string): Promise<number> {
      const settled = await Promise.allSettled(providers.map((p) => p.getTransactionHeight(txid)));
      return pickQuorumNumber(settled, quorum, log, 'getTransactionHeight');
    },
    async getHistory(scriptHash: string): Promise<readonly ScriptHashHistoryEntry[]> {
      const settled = await Promise.allSettled(providers.map((p) => p.getHistory(scriptHash)));
      return pickQuorumHistory(settled, quorum, log);
    },
    async broadcastTransaction(hex: string): Promise<string> {
      const errors: string[] = [];
      for (const p of providers) {
        try {
          return await p.broadcastTransaction(hex);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      throw new VerificationError(
        'E_QUORUM_DISAGREE',
        `broadcast failed on every provider: ${errors.join('; ')}`,
      );
    },
    async estimateFee(blocks: number): Promise<number> {
      const settled = await Promise.allSettled(providers.map((p) => p.estimateFee(blocks)));
      const nums = fulfilledValues(settled).filter((n): n is number => Number.isFinite(n));
      if (nums.length === 0) {
        throw new VerificationError(
          'E_QUORUM_DISAGREE',
          'no provider returned a fee estimate',
        );
      }
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = sorted[Math.floor(sorted.length / 2)];
      return mid ?? 0;
    },
  };
}

function fulfilledValues<T>(
  settled: ReadonlyArray<PromiseSettledResult<T>>,
): T[] {
  return settled
    .filter((s): s is PromiseFulfilledResult<T> => s.status === 'fulfilled')
    .map((s) => s.value);
}

function pickQuorumString(
  settled: ReadonlyArray<PromiseSettledResult<string>>,
  quorum: number,
  log: Logger,
  label: string,
): string {
  const counts = new Map<string, number>();
  for (const value of fulfilledValues(settled)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  for (const [value, count] of counts) {
    if (count >= quorum) return value;
  }
  log.warn({ label, fulfilled: counts.size }, 'quorum-string disagree');
  throw new VerificationError(
    'E_QUORUM_DISAGREE',
    `${label}: no value agreed to by ${String(quorum)} providers`,
  );
}

function pickQuorumNumber(
  settled: ReadonlyArray<PromiseSettledResult<number>>,
  quorum: number,
  log: Logger,
  label: string,
): number {
  const values = fulfilledValues(settled).filter((n): n is number => Number.isFinite(n));
  if (values.length < quorum) {
    log.warn({ label, fulfilled: values.length }, 'quorum-number too few responses');
    throw new VerificationError(
      'E_QUORUM_DISAGREE',
      `${label}: only ${String(values.length)} providers responded, need ${String(quorum)}`,
    );
  }
  // Accept the median if >=quorum values are within +/-1 of it; handles
  // normal block-height propagation lag.
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const agreeing = values.filter((v) => Math.abs(v - median) <= 1).length;
  if (agreeing >= quorum) return median;
  throw new VerificationError(
    'E_QUORUM_DISAGREE',
    `${label}: no median within ±1 agreed to by ${String(quorum)} providers`,
  );
}

function utxoKey(u: Utxo): string {
  return `${u.txid}:${String(u.vout)}:${String(u.value)}`;
}

function pickQuorumUtxos(
  settled: ReadonlyArray<PromiseSettledResult<readonly Utxo[]>>,
  quorum: number,
  log: Logger,
): readonly Utxo[] {
  const counts = new Map<string, { readonly utxo: Utxo; count: number }>();
  for (const list of fulfilledValues(settled)) {
    const seenInThisList = new Set<string>();
    for (const u of list) {
      const key = utxoKey(u);
      if (seenInThisList.has(key)) continue;
      seenInThisList.add(key);
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { utxo: u, count: 1 });
    }
  }
  const accepted: Utxo[] = [];
  for (const [, entry] of counts) {
    if (entry.count >= quorum) accepted.push(entry.utxo);
  }
  log.debug({ distinct: counts.size, accepted: accepted.length, quorum }, 'quorum utxo merge');
  return accepted;
}

function historyKey(h: ScriptHashHistoryEntry): string {
  return `${h.tx_hash}:${String(h.height)}`;
}

function pickQuorumHistory(
  settled: ReadonlyArray<PromiseSettledResult<readonly ScriptHashHistoryEntry[]>>,
  quorum: number,
  log: Logger,
): readonly ScriptHashHistoryEntry[] {
  const counts = new Map<string, { readonly entry: ScriptHashHistoryEntry; count: number }>();
  for (const list of fulfilledValues(settled)) {
    const seen = new Set<string>();
    for (const h of list) {
      const key = historyKey(h);
      if (seen.has(key)) continue;
      seen.add(key);
      const slot = counts.get(key);
      if (slot) slot.count += 1;
      else counts.set(key, { entry: h, count: 1 });
    }
  }
  const accepted: ScriptHashHistoryEntry[] = [];
  for (const [, slot] of counts) {
    if (slot.count >= quorum) accepted.push(slot.entry);
  }
  log.debug({ distinct: counts.size, accepted: accepted.length, quorum }, 'quorum history merge');
  return accepted;
}

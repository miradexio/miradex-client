// AV-D.4 / AV-H.12: rate-oracle quorum. Query two independent oracles
// (CoinGecko + CryptoCompare etc.) and require agreement within a band.
// E_ORACLE_SPREAD on wider disagreement, E_ORACLE_QUORUM on too few responses.

import type { Logger } from '../interfaces/logger.js';
import { noopLogger } from '../interfaces/logger.js';
import { VerificationError } from '../types/index.js';
import { VERIFY_FETCH_TIMEOUT_MS } from './constants.js';

export interface RateOracleConfig {
  readonly oracleUrls: ReadonlyArray<string>;
  readonly fetchFn: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly quorum: number;
  readonly logger?: Logger;
}

const DEFAULT_SPREAD_CAP = 0.02; // 2 %

// Returns the median rate across oracles that agree within 2%.
// Throws E_ORACLE_QUORUM if fewer than `quorum` responded,
// E_ORACLE_SPREAD if disagreement exceeds the cap.
export async function fetchConsensusRate(
  input: RateOracleConfig,
  extractRate: (url: string, body: unknown) => number,
): Promise<number> {
  const timeoutMs = input.timeoutMs ?? VERIFY_FETCH_TIMEOUT_MS;
  const log = input.logger ?? noopLogger;

  const attempts = input.oracleUrls.map(async (url) => {
    const res = await input.fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    const body = await res.json();
    return extractRate(url, body);
  });

  const settled = await Promise.allSettled(attempts);
  const rates = settled
    .filter((s): s is PromiseFulfilledResult<number> => s.status === 'fulfilled')
    .map((s) => s.value)
    .filter((r) => Number.isFinite(r) && r > 0);

  if (rates.length < input.quorum) {
    throw new VerificationError(
      'E_ORACLE_QUORUM',
      `only ${String(rates.length)} of ${String(input.oracleUrls.length)} oracles responded`,
    );
  }

  const sorted = [...rates].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const spread = (Math.max(...rates) - Math.min(...rates)) / median;
  if (spread > DEFAULT_SPREAD_CAP) {
    throw new VerificationError(
      'E_ORACLE_SPREAD',
      `oracles disagree by ${(spread * 100).toFixed(2)}% (cap ${(DEFAULT_SPREAD_CAP * 100).toFixed(2)}%)`,
    );
  }

  log.debug({ median, spread, samples: rates.length }, 'Oracle consensus reached');
  return median;
}

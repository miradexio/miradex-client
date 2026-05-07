import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SwapProvider } from './types/index.js';
import { VerificationError } from './types/index.js';

// AV-D.4: hash the accepted quote and re-check before funding so the server
// can't change expectedOutputAmount between accept and funding.

export interface AcceptedQuote {
  readonly provider: SwapProvider;
  readonly fromAsset: string;
  readonly toAsset: string;
  readonly amount: string;
  readonly destAddress: string;
  readonly refundAddress: string;
  readonly expectedOutputAmount: string;
  readonly rateBpsFromOracle: number;
  readonly acceptedAtEpochMs: number;
  readonly quoteHash: string;
}

export const QUOTE_MAX_AGE_MS = 5 * 60 * 1000;

// SHA-256 over the quote with sorted keys, so two equivalent quotes hash equal.
export function hashQuote(q: Omit<AcceptedQuote, 'quoteHash'>): string {
  const keys = Object.keys(q).sort();
  const canonical = JSON.stringify(q, keys);
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

// Throws E_QUOTE_TAMPERED on mismatch.
export function requireQuoteHashMatches(
  accepted: AcceptedQuote,
  current: Omit<AcceptedQuote, 'quoteHash'>,
): void {
  const currentHash = hashQuote(current);
  if (currentHash !== accepted.quoteHash) {
    throw new VerificationError(
      'E_QUOTE_TAMPERED',
      `quote hash mismatch: accepted=${accepted.quoteHash.slice(0, 16)}..., current=${currentHash.slice(0, 16)}...`,
    );
  }
}

// Throws E_QUOTE_STALE if accepted more than QUOTE_MAX_AGE_MS ago.
export function requireQuoteFresh(
  accepted: AcceptedQuote,
  nowEpochMs: number = Date.now(),
): void {
  const age = nowEpochMs - accepted.acceptedAtEpochMs;
  if (age > QUOTE_MAX_AGE_MS) {
    throw new VerificationError(
      'E_QUOTE_STALE',
      `quote age ${Math.round(age / 1000)}s exceeds max ${Math.round(QUOTE_MAX_AGE_MS / 1000)}s`,
    );
  }
}

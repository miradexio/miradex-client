import type { ErrorCode } from './errors.js';

export interface VerificationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface VerificationResult {
  readonly verified: boolean;
  readonly provider: string;
  readonly checks: readonly VerificationCheck[];
  readonly timestamp: number;
}

// Independent crypto / safety check failure. Always carries a stable
// ERROR_CODES code; consumers switch on it for UX. Category 'verification'
// so withRetry fails immediately (re-running won't fix a broken invariant).

import { MiradexError } from '../lib/errors.js';

export class VerificationError extends MiradexError {
  override readonly name = 'VerificationError';
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message, 'verification');
    this.code = code;
  }
}

export type SafeBigInt = bigint & { readonly __safeBigInt: unique symbol };

export interface BlockHeightSource {
  readonly getTipHeight: () => Promise<number>;
}

export interface FeePolicy {
  readonly minRelaySatsPerVbyte: bigint;
  readonly maxSatsPerVbyte: bigint;
}

export interface AmnestyPolicy {
  readonly maxRatioBps: number;
}

export interface DustPolicy {
  readonly p2wpkhDustSats: bigint;
  readonly p2wshDustSats: bigint;
}

export const DEFAULT_FEE_POLICY: FeePolicy = {
  minRelaySatsPerVbyte: 1n,
  maxSatsPerVbyte: 500n,
} as const;

// Mirrors Rust MAX_ANTI_SPAM_DEPOSIT_RATIO = 0.2 (20%) at
// xmr-atomic-swap/core/swap-env/src/config.rs:226. ASB makers may configure
// anti_spam_deposit_ratio anywhere in [0, 0.2]; a tighter SDK cap would
// reject swaps from makers running at the Rust-permitted max. 2_000 bps = 20%.
export const DEFAULT_AMNESTY_POLICY: AmnestyPolicy = { maxRatioBps: 2_000 } as const;

export const DEFAULT_DUST_POLICY: DustPolicy = {
  p2wpkhDustSats: 294n,
  p2wshDustSats: 330n,
} as const;

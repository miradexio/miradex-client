import type { VerificationCheck, VerificationResult } from '../types/index.js';

export interface VerifyParams {
  readonly destAddress: string;
  readonly refundAddress: string;
  readonly toToken: string;
  readonly amount: string;
  readonly fromChain?: string;
  readonly toChain?: string;
  readonly fromToken?: string;
}

export interface ProtocolContext {
  readonly psbt?: string;
  readonly lock_address?: string;
  readonly timelock_blocks?: number;
}

export function check(name: string, passed: boolean, detail: string): VerificationCheck {
  return { name, passed, detail };
}

export function resultOf(
  provider: string,
  checks: readonly VerificationCheck[],
): VerificationResult {
  return {
    verified: checks.length > 0 && checks.every((c) => c.passed),
    provider,
    checks,
    timestamp: Date.now(),
  };
}

export function failOf(
  provider: string,
  checks: readonly VerificationCheck[],
): VerificationResult {
  return { verified: false, provider, checks, timestamp: Date.now() };
}

export function errMsg(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return `${err.message} (${cause.message})`;
  if (cause !== undefined && cause !== null) return `${err.message} (${String(cause)})`;
  return err.message;
}

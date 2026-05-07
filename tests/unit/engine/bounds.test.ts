import { describe, it, expect } from 'vitest';
import { MiradexEngine } from '../../../src/engine/miradex-engine.js';
import { VerificationError } from '../../../src/types/index.js';

const minimalPlatform = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as never;

describe('MiradexEngine bounds (Fix 8.4.8)', () => {
  it('throws E_SLIPPAGE_OUT_OF_RANGE when slippage is too low', () => {
    let caught: VerificationError | undefined;
    try {
      new MiradexEngine({ apiUrl: 'http://x', slippageBps: 5 }, minimalPlatform);
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_SLIPPAGE_OUT_OF_RANGE');
  });

  it('throws E_SLIPPAGE_OUT_OF_RANGE when slippage is too high', () => {
    let caught: VerificationError | undefined;
    try {
      new MiradexEngine({ apiUrl: 'http://x', slippageBps: 1_000 }, minimalPlatform);
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_SLIPPAGE_OUT_OF_RANGE');
  });

  it('throws E_RETRIES_OUT_OF_RANGE when maxRetries is out of band', () => {
    let caught: VerificationError | undefined;
    try {
      new MiradexEngine({ apiUrl: 'http://x', apiMaxRetries: 50 }, minimalPlatform);
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_RETRIES_OUT_OF_RANGE');
  });

  it('accepts values inside the bounds', () => {
    expect(
      () => new MiradexEngine({ apiUrl: 'http://x', slippageBps: 100, apiMaxRetries: 3 }, minimalPlatform),
    ).not.toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import {
  hashQuote,
  requireQuoteHashMatches,
  requireQuoteFresh,
  QUOTE_MAX_AGE_MS,
  type AcceptedQuote,
} from '../../../src/quote-binding.js';
import { VerificationError } from '../../../src/types/index.js';

function baseQuote(): Omit<AcceptedQuote, 'quoteHash'> {
  return {
    provider: 'thorchain',
    fromAsset: 'BTC',
    toAsset: 'ETH',
    amount: '0.1',
    destAddress: '0xabc',
    refundAddress: 'bc1qxyz',
    expectedOutputAmount: '250000000000000000',
    rateBpsFromOracle: 100,
    acceptedAtEpochMs: Date.now(),
  };
}

describe('quote-binding', () => {
  it('hashQuote is deterministic across key order', () => {
    const base = baseQuote();
    const reordered = {
      amount: base.amount,
      destAddress: base.destAddress,
      expectedOutputAmount: base.expectedOutputAmount,
      fromAsset: base.fromAsset,
      provider: base.provider,
      rateBpsFromOracle: base.rateBpsFromOracle,
      refundAddress: base.refundAddress,
      toAsset: base.toAsset,
      acceptedAtEpochMs: base.acceptedAtEpochMs,
    };
    expect(hashQuote(base)).toBe(hashQuote(reordered));
  });

  it('requireQuoteHashMatches accepts unchanged quote', () => {
    const base = baseQuote();
    const accepted: AcceptedQuote = { ...base, quoteHash: hashQuote(base) };
    expect(() => requireQuoteHashMatches(accepted, base)).not.toThrow();
  });

  it('requireQuoteHashMatches throws E_QUOTE_TAMPERED on drift', () => {
    const base = baseQuote();
    const accepted: AcceptedQuote = { ...base, quoteHash: hashQuote(base) };
    const drifted = { ...base, expectedOutputAmount: '1' };
    let caught: VerificationError | undefined;
    try {
      requireQuoteHashMatches(accepted, drifted);
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_QUOTE_TAMPERED');
  });

  it('requireQuoteFresh throws E_QUOTE_STALE beyond max age', () => {
    const base = baseQuote();
    const accepted: AcceptedQuote = {
      ...base,
      acceptedAtEpochMs: Date.now() - QUOTE_MAX_AGE_MS - 1000,
      quoteHash: hashQuote(base),
    };
    let caught: VerificationError | undefined;
    try {
      requireQuoteFresh(accepted);
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_QUOTE_STALE');
  });
});

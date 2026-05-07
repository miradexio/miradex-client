import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hashQuote, type AcceptedQuote } from '../../src/quote-binding.js';

describe('hashQuote — property tests', () => {
  it('is deterministic under key-order permutation', () => {
    fc.assert(
      fc.property(
        fc.record({
          provider: fc.constantFrom('thorchain', 'chainflip', 'near_intents', 'atomicswap'),
          fromAsset: fc.string({ minLength: 1, maxLength: 10 }),
          toAsset: fc.string({ minLength: 1, maxLength: 10 }),
          amount: fc.string({ minLength: 1, maxLength: 10 }),
          destAddress: fc.string({ minLength: 1, maxLength: 30 }),
          refundAddress: fc.string({ minLength: 1, maxLength: 30 }),
          expectedOutputAmount: fc.string({ minLength: 1, maxLength: 20 }),
          rateBpsFromOracle: fc.integer({ min: 0, max: 10_000 }),
          acceptedAtEpochMs: fc.integer({ min: 1, max: 2_000_000_000_000 }),
        }),
        (q) => {
          const entries = Object.entries(q);
          const shuffled = [...entries].reverse();
          const reordered = Object.fromEntries(shuffled) as Omit<AcceptedQuote, 'quoteHash'>;
          expect(hashQuote(q as Omit<AcceptedQuote, 'quoteHash'>)).toBe(hashQuote(reordered));
        },
      ),
      { numRuns: 50 },
    );
  });

  it('different quotes hash differently', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (a, b) => {
          fc.pre(a !== b);
          const base = {
            provider: 'thorchain' as const,
            fromAsset: 'BTC',
            toAsset: 'ETH',
            amount: '0.1',
            destAddress: '0xabc',
            refundAddress: 'bc1qxyz',
            expectedOutputAmount: a,
            rateBpsFromOracle: 100,
            acceptedAtEpochMs: 0,
          };
          const changed = { ...base, expectedOutputAmount: b };
          expect(hashQuote(base)).not.toBe(hashQuote(changed));
        },
      ),
      { numRuns: 50 },
    );
  });
});

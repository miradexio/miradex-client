import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createQuorumProvider } from '../../src/blockchain/quorum-provider.js';
import type { BlockchainDataProvider } from '../../src/interfaces/blockchain.js';
import { VerificationError } from '../../src/types/index.js';

function stub(tx: string): BlockchainDataProvider {
  return {
    listUnspent: async () => [],
    getTransaction: async () => tx,
    getTransactionHeight: async () => 0,
    getHistory: async () => [],
    broadcastTransaction: async () => '',
    estimateFee: async () => 0,
  };
}

describe('createQuorumProvider — property tests', () => {
  it('accepts a string iff ≥ quorum providers return the same value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 3, maxLength: 7 }),
        fc.integer({ min: 2, max: 3 }),
        async (values, quorum) => {
          fc.pre(values.length >= quorum);
          const q = createQuorumProvider({
            providers: values.map((v) => stub(v)),
            quorum,
          });
          const counts = new Map<string, number>();
          for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
          const winner = [...counts.entries()].find(([, n]) => n >= quorum)?.[0];

          if (winner !== undefined) {
            const out = await q.getTransaction('x');
            expect(out).toBe(winner);
          } else {
            let caught: VerificationError | undefined;
            try {
              await q.getTransaction('x');
            } catch (err) {
              caught = err as VerificationError;
            }
            expect(caught?.code).toBe('E_QUORUM_DISAGREE');
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('always throws E_QUORUM_IMPOSSIBLE when providers.length < quorum', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 6, max: 10 }),
        (providerCount, quorum) => {
          const providers = Array.from({ length: providerCount }, () => stub('a'));
          let caught: VerificationError | undefined;
          try {
            createQuorumProvider({ providers, quorum });
          } catch (err) {
            caught = err as VerificationError;
          }
          expect(caught?.code).toBe('E_QUORUM_IMPOSSIBLE');
        },
      ),
      { numRuns: 25 },
    );
  });
});

import { describe, it, expect } from 'vitest';
import { fetchConsensusRate } from '../../../src/verification/rate-oracle.js';
import { VerificationError } from '../../../src/types/index.js';

function mockFetchPerUrl(rates: Record<string, number | 'fail'>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = Object.keys(rates).find((k) => url.includes(k));
    if (!key) throw new Error(`no route for ${url}`);
    const v = rates[key];
    if (v === 'fail') throw new Error('oracle down');
    return { ok: true, status: 200, json: async () => ({ rate: v }) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

const extractRate = (_url: string, body: unknown): number => (body as { rate: number }).rate;

describe('fetchConsensusRate', () => {
  it('returns the median when two oracles agree within 2 %', async () => {
    const fetchFn = mockFetchPerUrl({
      'oracle-a': 100.0,
      'oracle-b': 100.5,
    });
    const median = await fetchConsensusRate(
      { oracleUrls: ['http://oracle-a', 'http://oracle-b'], fetchFn, quorum: 2 },
      extractRate,
    );
    expect(median).toBeGreaterThan(99);
    expect(median).toBeLessThan(101);
  });

  it('throws E_ORACLE_QUORUM when too few oracles respond', async () => {
    const fetchFn = mockFetchPerUrl({ 'oracle-a': 'fail', 'oracle-b': 'fail' });
    let caught: VerificationError | undefined;
    try {
      await fetchConsensusRate(
        { oracleUrls: ['http://oracle-a', 'http://oracle-b'], fetchFn, quorum: 2 },
        extractRate,
      );
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_ORACLE_QUORUM');
  });

  it('throws E_ORACLE_SPREAD when oracles disagree beyond 2 %', async () => {
    const fetchFn = mockFetchPerUrl({
      'oracle-a': 100.0,
      'oracle-b': 110.0,
    });
    let caught: VerificationError | undefined;
    try {
      await fetchConsensusRate(
        { oracleUrls: ['http://oracle-a', 'http://oracle-b'], fetchFn, quorum: 2 },
        extractRate,
      );
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_ORACLE_SPREAD');
  });
});

import { describe, it, expect } from 'vitest';
import { createQuorumProvider } from '../../../src/blockchain/quorum-provider.js';
import type { BlockchainDataProvider, Utxo, ScriptHashHistoryEntry } from '../../../src/interfaces/blockchain.js';
import { VerificationError } from '../../../src/types/index.js';

function stubProvider(overrides: Partial<BlockchainDataProvider>): BlockchainDataProvider {
  return {
    listUnspent: async () => [],
    getTransaction: async () => '',
    getTransactionHeight: async () => 0,
    getHistory: async () => [],
    broadcastTransaction: async () => '',
    estimateFee: async () => 0,
    ...overrides,
  };
}

describe('createQuorumProvider', () => {
  it('throws E_QUORUM_IMPOSSIBLE when providers.length < quorum', () => {
    let caught: VerificationError | undefined;
    try {
      createQuorumProvider({
        providers: [stubProvider({})],
        quorum: 2,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_QUORUM_IMPOSSIBLE');
  });

  it('returns the agreed tx hex when at least quorum providers match', async () => {
    const q = createQuorumProvider({
      providers: [
        stubProvider({ getTransaction: async () => 'hex-a' }),
        stubProvider({ getTransaction: async () => 'hex-a' }),
        stubProvider({ getTransaction: async () => 'hex-b' }),
      ],
      quorum: 2,
    });
    expect(await q.getTransaction('x')).toBe('hex-a');
  });

  it('throws E_QUORUM_DISAGREE when no value agrees', async () => {
    const q = createQuorumProvider({
      providers: [
        stubProvider({ getTransaction: async () => 'a' }),
        stubProvider({ getTransaction: async () => 'b' }),
        stubProvider({ getTransaction: async () => 'c' }),
      ],
      quorum: 2,
    });
    let caught: VerificationError | undefined;
    try {
      await q.getTransaction('x');
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_QUORUM_DISAGREE');
  });

  it('returns the median height when values are within ±1', async () => {
    const q = createQuorumProvider({
      providers: [
        stubProvider({ getTransactionHeight: async () => 840_100 }),
        stubProvider({ getTransactionHeight: async () => 840_100 }),
        stubProvider({ getTransactionHeight: async () => 840_099 }),
      ],
      quorum: 2,
    });
    expect(await q.getTransactionHeight('x')).toBe(840_100);
  });

  it('rejects heights that diverge by more than 1', async () => {
    const q = createQuorumProvider({
      providers: [
        stubProvider({ getTransactionHeight: async () => 840_100 }),
        stubProvider({ getTransactionHeight: async () => 840_120 }),
        stubProvider({ getTransactionHeight: async () => 840_140 }),
      ],
      quorum: 2,
    });
    let caught: VerificationError | undefined;
    try {
      await q.getTransactionHeight('x');
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_QUORUM_DISAGREE');
  });

  it('drops UTXOs invented by a single provider, keeps agreed UTXOs', async () => {
    const honest: Utxo = { txid: 'aa'.repeat(32), vout: 0, value: 100_000, height: 840_000 };
    const invented: Utxo = { txid: 'bb'.repeat(32), vout: 0, value: 50_000, height: 840_000 };
    const q = createQuorumProvider({
      providers: [
        stubProvider({ listUnspent: async () => [honest, invented] }),
        stubProvider({ listUnspent: async () => [honest] }),
        stubProvider({ listUnspent: async () => [honest] }),
      ],
      quorum: 2,
    });
    const result = await q.listUnspent('hash');
    expect(result.length).toBe(1);
    expect(result[0]?.txid).toBe(honest.txid);
  });

  it('merges history entries by (tx_hash, height) with quorum', async () => {
    const e1: ScriptHashHistoryEntry = { tx_hash: 'cc'.repeat(32), height: 840_000 };
    const e2: ScriptHashHistoryEntry = { tx_hash: 'dd'.repeat(32), height: 840_001 };
    const q = createQuorumProvider({
      providers: [
        stubProvider({ getHistory: async () => [e1, e2] }),
        stubProvider({ getHistory: async () => [e1] }),
        stubProvider({ getHistory: async () => [e2] }),
      ],
      quorum: 2,
    });
    const result = await q.getHistory('hash');
    // e1 appears in 2 providers, e2 appears in 2 providers → both accepted
    expect(result.length).toBe(2);
  });
});

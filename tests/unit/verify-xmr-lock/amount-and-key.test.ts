import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FetchedTransaction, MoneroTxJson } from '../../../src/lib/monero/rpc.js';

// Minimal Monero-tx fixture for the matching loop.
function mockTx(overrides: {
  readonly outputKey?: string;
  readonly ecdhAmount?: string;
}): MoneroTxJson {
  return {
    extra: [0x01, ...new Array(32).fill(0x11)],
    unlock_time: 0,
    vout: [
      {
        amount: 0,
        target: { key: overrides.outputKey ?? 'ff'.repeat(32) },
      },
    ],
    rct_signatures: {
      type: 5,
      ecdhInfo: [{ amount: overrides.ecdhAmount ?? 'aa'.repeat(8) }],
      outPk: [],
    },
  };
}

function buildFetched(tx: MoneroTxJson): FetchedTransaction {
  return {
    txJson: tx,
    blockHeight: 100,
    confirmations: 100,
    inPool: false,
    outputIndices: [0],
    txHash: 'de'.repeat(32),
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('verifyXmrLocked — AV-A.3 / AV-A.4', () => {
  it('AV-A.3: returns verified:false when no output key matches the spend-pub', async () => {
    vi.doMock('../../../src/lib/monero/rpc.js', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('../../../src/lib/monero/rpc.js');
      return {
        ...actual,
        fetchTransaction: async () => buildFetched(mockTx({ outputKey: '01' + '00'.repeat(31) })),
      };
    });
    const { verifyXmrLocked } = await import('../../../src/lib/monero/verify-lock.js');

    // 5866666666... is the compressed ed25519 base point encoding of B=G*8
    const validSpendPub = '5866666666666666666666666666666666666666666666666666666666666666';
    const result = await verifyXmrLocked({
      lockTxHash: 'de'.repeat(32),
      viewKeyHex: '01' + '00'.repeat(31),
      spendPubHex: validSpendPub,
      expectedAmount: 1n,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/No output matched|matched the lock/i);
  });
});

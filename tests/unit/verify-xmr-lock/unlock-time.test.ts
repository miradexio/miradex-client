import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyXmrLocked } from '../../../src/lib/monero/verify-lock.js';

function mockTxJson(overrides: {
  readonly unlock_time?: number;
  readonly voutUnlockTime?: number;
}) {
  return {
    extra: [],
    unlock_time: overrides.unlock_time,
    vout: [
      {
        amount: 0,
        target: { key: 'aa'.repeat(32) },
        unlock_time: overrides.voutUnlockTime,
      },
    ],
    rct_signatures: { type: 5, ecdhInfo: [], outPk: [] },
  };
}

describe('verifyXmrLocked — AV-A.5 unlock_time rejection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejects tx-level unlock_time != 0 after enough confirmations', async () => {
    vi.doMock('../../../src/lib/monero/rpc.js', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('../../../src/lib/monero/rpc.js');
      return {
        ...actual,
        fetchTransaction: async () => ({
          txJson: mockTxJson({ unlock_time: 1_000_000 }),
          blockHeight: 1,
          confirmations: 100,
          inPool: false,
          outputIndices: [0],
          txHash: 'de'.repeat(32),
        }),
      };
    });
    const { verifyXmrLocked: verify } = await import('../../../src/lib/monero/verify-lock.js');

    const result = await verify({
      lockTxHash: 'de'.repeat(32),
      viewKeyHex: '01' + '00'.repeat(31),
      spendPubHex: '01' + '00'.repeat(31),
      expectedAmount: 1n,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('unlock_time');
    expect(result.retryable).toBeFalsy();
  });

  it('returns retryable:true when confirmations are short', async () => {
    vi.doMock('../../../src/lib/monero/rpc.js', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('../../../src/lib/monero/rpc.js');
      return {
        ...actual,
        fetchTransaction: async () => ({
          txJson: mockTxJson({ unlock_time: 0 }),
          blockHeight: 1,
          confirmations: 2,
          inPool: false,
          outputIndices: [0],
          txHash: 'de'.repeat(32),
        }),
      };
    });
    const { verifyXmrLocked: verify } = await import('../../../src/lib/monero/verify-lock.js');

    const result = await verify({
      lockTxHash: 'de'.repeat(32),
      viewKeyHex: '01' + '00'.repeat(31),
      spendPubHex: '01' + '00'.repeat(31),
      expectedAmount: 1n,
      minConfirmations: 10,
    });
    expect(result.verified).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.reason).toContain('confirmations');
  });
});

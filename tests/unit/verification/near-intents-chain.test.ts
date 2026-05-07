import { describe, it, expect } from 'vitest';
import { verifyNearIntentOnChain } from '../../../src/verification/near-intents.js';
import { VerificationError } from '../../../src/types/index.js';

function mockRpcFetch(onChainIntent: { destinationAddress: string; expectedOutputAmount: string }): typeof globalThis.fetch {
  return (async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(onChainIntent));
    const body = {
      jsonrpc: '2.0',
      id: 1,
      result: { result: Array.from(bytes) },
    };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe('verifyNearIntentOnChain', () => {
  it('passes when on-chain dest + amount match expected', async () => {
    await expect(
      verifyNearIntentOnChain({
        intentHash: 'abc',
        expected: { destinationAddress: 'alice.near', expectedOutputAmount: '1000000' },
        nearRpcUrl: 'http://rpc',
        fetchFn: mockRpcFetch({ destinationAddress: 'alice.near', expectedOutputAmount: '1000000' }),
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();
  });

  it('throws E_NEAR_INTENT_CHAIN_DEST on destination mismatch', async () => {
    let caught: VerificationError | undefined;
    try {
      await verifyNearIntentOnChain({
        intentHash: 'abc',
        expected: { destinationAddress: 'alice.near', expectedOutputAmount: '1000000' },
        nearRpcUrl: 'http://rpc',
        fetchFn: mockRpcFetch({ destinationAddress: 'attacker.near', expectedOutputAmount: '1000000' }),
        timeoutMs: 1_000,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_NEAR_INTENT_CHAIN_DEST');
  });

  it('throws E_NEAR_INTENT_CHAIN_AMOUNT on amount mismatch', async () => {
    let caught: VerificationError | undefined;
    try {
      await verifyNearIntentOnChain({
        intentHash: 'abc',
        expected: { destinationAddress: 'alice.near', expectedOutputAmount: '1000000' },
        nearRpcUrl: 'http://rpc',
        fetchFn: mockRpcFetch({ destinationAddress: 'alice.near', expectedOutputAmount: '1' }),
        timeoutMs: 1_000,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_NEAR_INTENT_CHAIN_AMOUNT');
  });
});

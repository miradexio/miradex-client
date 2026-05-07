import { describe, it, expect } from 'vitest';
import { verifyDepositAddress } from '../../../src/verification/index.js';
import { VerificationError } from '../../../src/types/index.js';

// AV-A.14 scope check — the verifyDepositAddress dispatcher rejects
// `timelock_blocks` on a non-atomicswap provider (clear sign of confused
// routing).

describe('verifyDepositAddress — AV-A.14 timelock scope', () => {
  it('throws E_UNEXPECTED_TIMELOCK when thorchain verification carries timelock_blocks', async () => {
    let caught: VerificationError | undefined;
    try {
      await verifyDepositAddress({
        depositAddress: 'bc1qxyz',
        verification: {
          provider: 'thorchain',
          inbound_addresses_url: 'http://example.com',
          thornode_url: 'http://example.com',
          registered_memo: null,
          reference_number: null,
          explorer_url: null,
        },
        destAddress: '0xdest',
        refundAddress: 'bc1qrefund',
        toToken: 'ETH',
        amount: '0.1',
        protocol: { timelock_blocks: 144 },
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_UNEXPECTED_TIMELOCK');
  });

  it('allows atomicswap verification with a timelock_blocks field', async () => {
    const vr = await verifyDepositAddress({
      depositAddress: 'bc1qxyz',
      verification: {
        provider: 'atomicswap',
        lock_address: 'bc1qabc',
        deposit_type: 'P2WSH',
        refund_address: 'bc1qrefund',
        timelock_blocks: 144,
        timelock_hours: 24,
      },
      destAddress: '4Aliceaddress',
      refundAddress: 'bc1qrefund',
      toToken: 'XMR',
      amount: '0.1',
      protocol: { timelock_blocks: 144 },
    });
    expect(vr.provider).toBe('atomicswap');
  });
});

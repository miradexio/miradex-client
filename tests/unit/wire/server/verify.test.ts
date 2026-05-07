import { describe, it, expect } from 'vitest';
import {
  verifyKeysBodySchema,
  verifyKeysResponseSchema,
} from '../../../../src/wire/server/verify.zod.js';

describe('verifyKeysBodySchema', () => {
  it('parses a full body', () => {
    const parsed = verifyKeysBodySchema.parse({
      s_b_bitcoin: 'btc-hex',
      s_b_monero: 'xmr-hex',
      dleq_proof: 'proof-hex',
      v_b: 'view-hex',
    });
    expect(parsed.s_b_bitcoin).toBe('btc-hex');
  });

  it('rejects missing dleq_proof', () => {
    expect(() =>
      verifyKeysBodySchema.parse({ s_b_bitcoin: 'a', s_b_monero: 'b', v_b: 'c' }),
    ).toThrow();
  });
});

describe('verifyKeysResponseSchema', () => {
  it('parses valid=true with reason', () => {
    const parsed = verifyKeysResponseSchema.parse({ valid: true, reason: 'proof ok' });
    expect(parsed.valid).toBe(true);
  });
});

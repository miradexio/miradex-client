import { describe, it, expect } from 'vitest';
import { powChallengeSchema, powPayloadSchema } from '../../../../src/wire/server/pow.zod.js';

describe('powChallengeSchema', () => {
  const golden = {
    algorithm: 'SHA-256' as const,
    challenge: 'a'.repeat(64),
    salt: 'salt-with-expiry',
    maxnumber: 1_000_000,
    signature: 'b'.repeat(64),
    expiresAt: '2026-04-18T12:00:00.000Z',
  };

  it('parses a golden challenge', () => {
    expect(powChallengeSchema.parse(golden)).toMatchObject(golden);
  });

  it('rejects wrong algorithm literal', () => {
    expect(() => powChallengeSchema.parse({ ...golden, algorithm: 'SHA-1' })).toThrow();
  });

  it('rejects wrong-length challenge', () => {
    expect(() => powChallengeSchema.parse({ ...golden, challenge: 'short' })).toThrow();
  });

  it('rejects non-positive maxnumber', () => {
    expect(() => powChallengeSchema.parse({ ...golden, maxnumber: 0 })).toThrow();
  });
});

describe('powPayloadSchema', () => {
  it('parses a solved payload', () => {
    const parsed = powPayloadSchema.parse({
      algorithm: 'SHA-256',
      challenge: 'a'.repeat(64),
      number: 42_000,
      salt: 'salt-x',
      signature: 'b'.repeat(64),
    });
    expect(parsed.number).toBe(42_000);
  });

  it('rejects negative number', () => {
    expect(() =>
      powPayloadSchema.parse({
        algorithm: 'SHA-256',
        challenge: 'a'.repeat(64),
        number: -1,
        salt: 'salt-x',
        signature: 'b'.repeat(64),
      }),
    ).toThrow();
  });
});

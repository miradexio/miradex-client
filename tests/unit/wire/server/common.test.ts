import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  apiEnvelopeSchema,
  tolerantEnum,
  DecimalAmountSchema,
  IsoTimestampSchema,
  SwapNumberSchema,
  SwapIdSchema,
  TxHashSchema,
} from '../../../../src/wire/server/common.zod.js';

describe('apiEnvelopeSchema', () => {
  const schema = apiEnvelopeSchema(z.object({ value: z.number() }));

  it('parses a success envelope and narrows to the data type', () => {
    const parsed = schema.parse({ success: true, data: { value: 42 } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.value).toBe(42);
  });

  it('parses an error envelope', () => {
    const parsed = schema.parse({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'too many requests' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.code).toBe('RATE_LIMITED');
      expect(parsed.error.message).toBe('too many requests');
    }
  });

  it('rejects an envelope missing success', () => {
    expect(() => schema.parse({ data: { value: 42 } })).toThrow();
  });

  it('rejects a success envelope with wrong data shape', () => {
    const result = schema.safeParse({ success: true, data: { value: 'not-a-number' } });
    expect(result.success).toBe(false);
  });
});

describe('tolerantEnum', () => {
  const statusSchema = tolerantEnum(['completed', 'failed', 'pending'] as const);

  it('accepts a known value as a literal', () => {
    expect(statusSchema.parse('completed')).toBe('completed');
  });

  it('maps an unknown string to an unknown-prefixed tag', () => {
    expect(statusSchema.parse('withheld')).toBe('unknown:withheld');
  });

  it('rejects non-strings', () => {
    expect(() => statusSchema.parse(42)).toThrow();
    expect(() => statusSchema.parse(null)).toThrow();
  });
});

describe('shared scalars', () => {
  it('DecimalAmountSchema accepts non-negative decimals', () => {
    expect(DecimalAmountSchema.parse('0')).toBe('0');
    expect(DecimalAmountSchema.parse('1.25')).toBe('1.25');
    expect(() => DecimalAmountSchema.parse('-1')).toThrow();
    expect(() => DecimalAmountSchema.parse('abc')).toThrow();
  });

  it('IsoTimestampSchema accepts ISO 8601', () => {
    expect(IsoTimestampSchema.parse('2026-04-18T12:00:00.000Z')).toBeDefined();
    expect(() => IsoTimestampSchema.parse('yesterday')).toThrow();
  });

  it('SwapNumberSchema enforces MIRA-XXXXXXXX format', () => {
    expect(SwapNumberSchema.parse('MIRA-ABCD1234')).toBe('MIRA-ABCD1234');
    expect(() => SwapNumberSchema.parse('swp-lowercase')).toThrow();
    expect(() => SwapNumberSchema.parse('MIRA-ABC')).toThrow();
  });

  it('SwapIdSchema enforces UUID', () => {
    expect(SwapIdSchema.parse('550e8400-e29b-41d4-a716-446655440000')).toBeDefined();
    expect(() => SwapIdSchema.parse('not-a-uuid')).toThrow();
  });

  it('TxHashSchema requires non-empty string', () => {
    expect(TxHashSchema.parse('abc123')).toBe('abc123');
    expect(() => TxHashSchema.parse('')).toThrow();
  });
});

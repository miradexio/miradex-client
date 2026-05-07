import { describe, it, expect } from 'vitest';
import { constantTimeEqualHex, wipe } from '../../../src/lib/crypto/bytes.js';

describe('constantTimeEqualHex', () => {
  it('returns true for identical hex', () => {
    expect(constantTimeEqualHex('deadbeef', 'deadbeef')).toBe(true);
  });

  it('returns false for different hex of equal length', () => {
    expect(constantTimeEqualHex('deadbeef', 'deadbeee')).toBe(false);
  });

  it('returns false for different-length hex', () => {
    expect(constantTimeEqualHex('deadbeef', 'deadbe')).toBe(false);
  });

  it('is case-sensitive (hex should already be normalised lowercase)', () => {
    expect(constantTimeEqualHex('deadbeef', 'DEADBEEF')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(constantTimeEqualHex('', '')).toBe(true);
  });
});

describe('wipe', () => {
  it('fills a buffer with zeros', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]);
    wipe(buf);
    expect(Array.from(buf)).toEqual([0, 0, 0, 0, 0]);
  });

  it('is a no-op on empty buffer', () => {
    const buf = new Uint8Array(0);
    wipe(buf);
    expect(buf.length).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { compactToDer, derToCompact } from '../../../../src/atomic-swap/refund.js';

function buildCompact(rHex: string, sHex: string): Buffer {
  const r = Buffer.from(rHex, 'hex');
  const s = Buffer.from(sHex, 'hex');
  if (r.length !== 32 || s.length !== 32) throw new Error('32 bytes each');
  return Buffer.concat([r, s]);
}

describe('compactToDer / derToCompact', () => {
  it('encodes a simple compact signature as strict DER', () => {
    const compact = buildCompact(
      '1122334455667788112233445566778811223344556677881122334455667788',
      '99aabbccddeeff0099aabbccddeeff0099aabbccddeeff0099aabbccddeeff01',
    );
    const der = compactToDer(compact);
    expect(der[0]).toBe(0x30);
    expect(der[2]).toBe(0x02); // r INTEGER tag
    const rLen = der[3]!;
    expect(der[4 + rLen]).toBe(0x02); // s INTEGER tag
  });

  it('round-trips: der → compact → der', () => {
    const compact = buildCompact(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    );
    const der = compactToDer(compact);
    const back = derToCompact(der);
    expect(back.equals(compact)).toBe(true);
  });

  it('prepends 0x00 when the high bit of r is set', () => {
    const compact = buildCompact(
      'ff11223344556677889900aabbccddeeff11223344556677889900aabbccddee',
      '11223344556677889900aabbccddee11223344556677889900aabbccddee1122',
    );
    const der = compactToDer(compact);
    const rLen = der[3]!;
    // r encoded: 0x02, 0x21 (33 bytes), 0x00, then 32 bytes
    expect(rLen).toBe(33);
    expect(der[4]).toBe(0x00);
  });

  it('trims leading zero from r when it does not need to be preserved', () => {
    const compact = buildCompact(
      '0000112233445566778811223344556677881122334455667788112233445566',
      '11223344556677889900aabbccddee11223344556677889900aabbccddee1122',
    );
    const der = compactToDer(compact);
    const rLen = der[3]!;
    // Two leading zeros are trimmed; no high-bit prefix needed (next byte is 0x11).
    expect(rLen).toBe(30);
  });

  it('keeps a single leading zero when trimming would flip the high bit', () => {
    const compact = buildCompact(
      '0081223344556677881122334455667788112233445566778811223344556677', // 0x81 has high bit set
      '11223344556677889900aabbccddee11223344556677889900aabbccddee1122',
    );
    const der = compactToDer(compact);
    const rLen = der[3]!;
    // leading 0x00 kept (value would otherwise be negative DER integer)
    expect(rLen).toBe(32);
    expect(der[4]).toBe(0x00);
    expect(der[5]).toBe(0x81);
  });

  it('rejects non-64-byte inputs', () => {
    expect(() => compactToDer(Buffer.alloc(63))).toThrow(/64-byte/);
    expect(() => compactToDer(Buffer.alloc(65))).toThrow(/64-byte/);
  });
});

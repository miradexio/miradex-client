// Monero scalars are little-endian; Bitcoin sighash is big-endian. Each
// function names its endianness explicitly.

// 2^252 + 27_742_317_777_372_353_535_851_937_790_883_648_493.
export const ED25519_GROUP_ORDER =
  2n ** 252n + 27_742_317_777_372_353_535_851_937_790_883_648_493n;

// Monero / ed25519: byte[0] is least-significant.
export function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    const b = bytes[i];
    if (b === undefined) continue;
    result = (result << 8n) | BigInt(b);
  }
  return result;
}

// Bitcoin sighash: byte[0] is most-significant.
export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) {
    result = (result << 8n) | BigInt(b);
  }
  return result;
}

// Back-compat alias. New call sites: prefer bytesToBigIntLE.
export function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytesToBigIntLE(bytes);
}

// 32B LE, reduced mod L.
export function bigIntToBytes(num: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let n = ((num % ED25519_GROUP_ORDER) + ED25519_GROUP_ORDER) % ED25519_GROUP_ORDER;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

// Decode hex LE scalar, reduce mod L.
export function hexToScalarLE(hex: string): bigint {
  const bytes = hexToBytesLocal(hex);
  const raw = bytesToBigIntLE(bytes);
  return ((raw % ED25519_GROUP_ORDER) + ED25519_GROUP_ORDER) % ED25519_GROUP_ORDER;
}

// Sum two 32B LE scalars mod L; returns 32B LE.
export function addScalars(a: Uint8Array, b: Uint8Array): Uint8Array {
  return bigIntToBytes((bytesToBigIntLE(a) + bytesToBigIntLE(b)) % ED25519_GROUP_ORDER);
}

function hexToBytesLocal(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('hexToScalarLE: odd-length hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('hexToScalarLE: invalid hex');
    out[i] = byte;
  }
  return out;
}

// Back-compat hex/byte helpers for older call sites.
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  return hexToBytesLocal(hex);
}

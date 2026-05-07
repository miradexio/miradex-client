import { bytesToHex as toHex, hexToBytes as fromHex } from '@noble/hashes/utils.js';

export { toHex as bytesToHex, fromHex as hexToBytes };

/** Byte-wise equality for two `Uint8Array`s of any length. */
export function uint8ArrayEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// One CT comparator for digest / pubkey / txid checks. Hex isn't itself
// secret today, but keeping one comparator avoids footguns when a future
// caller compares a secret-dependent hex value.
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return acc === 0;
}

// AV-G.2: zero-fill a secret buffer. Best-effort — V8 may copy internally,
// so this is defence in depth alongside minimising secret lifetime.
export function wipe(buf: Uint8Array): void {
  buf.fill(0);
}

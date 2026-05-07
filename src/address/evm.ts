import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '../lib/crypto/scalars.js';

export function validateEvmAddress(address: string): { valid: boolean; reason?: string } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { valid: false, reason: 'Must be 0x followed by 40 hex characters' };
  }

  // All-lower or all-upper = valid but unchecksummed; skip the EIP-55 check.
  const hex = address.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) {
    return { valid: true };
  }

  const hashHex = bytesToHex(keccak_256(new TextEncoder().encode(hex.toLowerCase())));

  for (let i = 0; i < 40; i++) {
    const c = hex.charAt(i);
    const h = parseInt(hashHex.charAt(i), 16);

    if (/[a-fA-F]/.test(c)) {
      const shouldBeUpper = h >= 8;
      const isUpper = c === c.toUpperCase();
      if (shouldBeUpper !== isUpper) {
        return { valid: false, reason: 'Invalid EIP-55 checksum' };
      }
    }
  }

  return { valid: true };
}

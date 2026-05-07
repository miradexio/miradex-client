import { base58 } from '@scure/base';
import { blake2b } from '@noble/hashes/blake2.js';

const SS58_PREFIX = new TextEncoder().encode('SS58PRE');

// SS58: base58(prefix + pubkey + checksum). Network 0 = Polkadot mainnet.
export function validatePolkadotAddress(address: string): { valid: boolean; reason?: string } {
  if (address.length < 46 || address.length > 48) {
    return { valid: false, reason: `Expected 46-48 characters, got ${address.length}` };
  }

  try {
    const decoded = base58.decode(address);
    if (decoded.length < 35) {
      return { valid: false, reason: 'Decoded data too short' };
    }

    const prefixLen = decoded[0]! < 64 ? 1 : 2;
    const pubkey = decoded.slice(prefixLen, prefixLen + 32);
    const checksum = decoded.slice(prefixLen + 32, prefixLen + 34);

    // checksum = blake2b(SS58PRE || prefix || pubkey)[0:2]
    const input = new Uint8Array(SS58_PREFIX.length + prefixLen + 32);
    input.set(SS58_PREFIX);
    input.set(decoded.slice(0, prefixLen), SS58_PREFIX.length);
    input.set(pubkey, SS58_PREFIX.length + prefixLen);

    const hash = blake2b(input, { dkLen: 64 });
    if (hash[0] !== checksum[0] || hash[1] !== checksum[1]) {
      return { valid: false, reason: 'Invalid SS58 checksum' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid SS58 encoding' };
  }
}

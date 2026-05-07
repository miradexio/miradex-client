import { base58check as b58c } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

const bs58check = b58c(sha256);

export function validateBase58Check(
  address: string,
  expectedVersions: readonly number[],
): { valid: boolean; reason?: string } {
  try {
    const decoded = bs58check.decode(address);
    if (decoded.length < 2) return { valid: false, reason: 'Too short' };

    const version = decoded[0]!;
    if (!expectedVersions.includes(version)) {
      return { valid: false, reason: `Invalid version byte: 0x${version.toString(16)}` };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid base58check encoding' };
  }
}

// XRP uses a different base58 alphabet.
const XRP_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

export function validateXrpAddress(address: string): { valid: boolean; reason?: string } {
  if (!address.startsWith('r') || address.length < 25 || address.length > 35) {
    return { valid: false, reason: 'XRP address must start with r and be 25-35 chars' };
  }

  for (const c of address) {
    if (!XRP_ALPHABET.includes(c)) {
      return { valid: false, reason: `Invalid character '${c}' in XRP address` };
    }
  }

  return { valid: true };
}

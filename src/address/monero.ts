// Standard:    95 chars, starts with 4 (mainnet) / 5 (testnet)
// Subaddress:  95 chars, starts with 8 (mainnet) / 7 (testnet)
// Integrated: 106 chars, starts with 4 (mainnet)
// Monero base58 encodes 8-byte blocks; format + length only (no base58check).

const MONERO_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function validateMoneroAddress(address: string): { valid: boolean; reason?: string } {
  if (address.length !== 95 && address.length !== 106) {
    return {
      valid: false,
      reason: `Monero address must be 95 or 106 characters, got ${address.length}`,
    };
  }

  const first = address[0];
  if (first !== '4' && first !== '8' && first !== '5' && first !== '7') {
    return { valid: false, reason: `Must start with 4, 5, 7, or 8, got '${first}'` };
  }

  for (const c of address) {
    if (!MONERO_ALPHABET.includes(c)) {
      return { valid: false, reason: `Invalid character '${c}'` };
    }
  }

  return { valid: true };
}

import { base58 } from '@scure/base';

export function validateSolanaAddress(address: string): { valid: boolean; reason?: string } {
  if (address.length < 32 || address.length > 44) {
    return { valid: false, reason: 'Solana address must be 32-44 characters' };
  }

  try {
    const decoded = base58.decode(address);
    if (decoded.length !== 32) {
      return { valid: false, reason: `Decoded length ${decoded.length}, expected 32 bytes` };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid base58 encoding' };
  }
}

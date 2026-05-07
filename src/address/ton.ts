// Bounceable:     EQ + 46 base64url
// Non-bounceable: UQ + 46 base64url
// Raw:            0: + 64 hex (rare in user-facing flows)

export function validateTonAddress(address: string): { valid: boolean; reason?: string } {
  if (/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(address)) {
    try {
      const b64 = address.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(b64, 'base64');
      if (decoded.length !== 34) {
        return { valid: false, reason: `Decoded length ${decoded.length}, expected 34` };
      }
      return { valid: true };
    } catch {
      return { valid: false, reason: 'Invalid base64url encoding' };
    }
  }

  if (/^0:[0-9a-fA-F]{64}$/.test(address)) {
    return { valid: true };
  }

  return { valid: false, reason: 'TON address must start with EQ/UQ (48 chars) or 0: (66 chars)' };
}

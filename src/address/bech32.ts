import { bech32, bech32m } from '@scure/base';

// Segwit (BTC bc1, LTC ltc1, etc.): first word is the witness version, skip
// it before fromWords. Non-segwit (Cosmos, THORChain): all words are data.
export function validateBech32(
  address: string,
  expectedHrp: string,
  minDataLen = 20,
  maxDataLen = 40,
): { valid: boolean; reason?: string } {
  try {
    let decoded: { prefix: string; words: number[] };
    try {
      decoded = bech32m.decode(address as `${string}1${string}`);
    } catch {
      decoded = bech32.decode(address as `${string}1${string}`);
    }

    if (decoded.prefix !== expectedHrp) {
      return { valid: false, reason: `Expected HRP '${expectedHrp}', got '${decoded.prefix}'` };
    }

    // Segwit (bc, ltc, ...) carries the witness version as the first word.
    const isSegwit =
      expectedHrp === 'bc' ||
      expectedHrp === 'ltc' ||
      expectedHrp === 'tb' ||
      expectedHrp === 'tltc';
    const words = isSegwit ? decoded.words.slice(1) : decoded.words;

    const data = bech32.fromWords(words);
    if (data.length < minDataLen || data.length > maxDataLen) {
      return {
        valid: false,
        reason: `Data length ${data.length} out of range [${minDataLen}, ${maxDataLen}]`,
      };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid bech32 encoding' };
  }
}

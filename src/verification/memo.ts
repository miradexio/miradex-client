// AV-A.14 / AV-K.6: strict THORChain memo parser.
// memo.includes(destAddress) was vulnerable: a memo like
// SWAP:ETH.ETH:0xATTACKER:0:affid_<USER_ADDR>:10 passes a substring check.
// The parser here matches the memo ABI and compares the destination field only.

import { VerificationError } from '../types/index.js';

const THORCHAIN_MEMO_RE =
  /^(?:SWAP|=|s):([A-Z0-9./-]+):([A-Za-z0-9_./]+)(?::(\d+)(?:\/(\d+)\/(\d+))?)?(?::([A-Za-z0-9]+))?(?::(\d+))?$/;

export interface ParsedThorchainMemo {
  readonly asset: string;
  readonly destAddress: string;
  readonly minOut?: bigint;
  readonly streamingInterval?: number;
  readonly streamingQuantity?: number;
  readonly affiliate?: string;
  readonly affiliateFeeBps?: number;
}

// Accepts SWAP:, =:, and s: prefixes plus asset, destination, optional
// min-out (integer or streaming LIMIT/INTERVAL/QUANTITY), optional
// affiliate, optional affiliate fee bps. Throws E_MEMO_MALFORMED on a
// memo that doesn't match the canonical ABI.
export function parseThorchainMemo(memo: string): ParsedThorchainMemo {
  const match = memo.trim().match(THORCHAIN_MEMO_RE);
  if (!match) {
    throw new VerificationError('E_MEMO_MALFORMED', `memo does not parse: ${memo}`);
  }
  const [, asset = '', destAddress = '', minOut, streamingInterval, streamingQuantity, affiliate, feeBps] = match;
  return {
    asset,
    destAddress,
    minOut: minOut !== undefined ? BigInt(minOut) : undefined,
    streamingInterval: streamingInterval !== undefined ? Number(streamingInterval) : undefined,
    streamingQuantity: streamingQuantity !== undefined ? Number(streamingQuantity) : undefined,
    affiliate,
    affiliateFeeBps: feeBps !== undefined ? Number(feeBps) : undefined,
  };
}

// Throws E_MEMO_DEST_MISMATCH on mismatch, E_MEMO_MALFORMED if memo doesn't parse.
export function requireMemoBindsDestination(memo: string, expectedDestAddress: string): void {
  const parsed = parseThorchainMemo(memo);
  if (parsed.destAddress !== expectedDestAddress) {
    throw new VerificationError(
      'E_MEMO_DEST_MISMATCH',
      `memo destination ${parsed.destAddress} differs from expected ${expectedDestAddress}`,
    );
  }
}

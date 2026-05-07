// Retry classifier for sweepMonero. Two classes count as retryable:
//   1. transient transport (fetch/timeout/5xx/multi-node exhaustion)
//   2. monerod invalid_input / failed (locked ring member, torsion, key-image
//      quorum) - a fresh ring typically resolves these
// Commitment / schema / verification errors stay non-retryable.
const RETRYABLE_PATTERNS: readonly string[] = [
  'fetch failed',
  'terminated',
  'econnrefused',
  'econnreset',
  'etimedout',
  'socket hang up',
  'network',
  'timeout',
  'all 2 nodes failed',
  'all 3 nodes failed',
  'all 4 nodes failed',
  'http 5',
  'invalid_input',
  'invalid_output',
  'low_mixin',
  'failed',
];

export function isRetryableSweepError(message: string): boolean {
  const lower = message.toLowerCase();
  return RETRYABLE_PATTERNS.some((p) => lower.includes(p));
}

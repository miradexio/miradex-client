// Server issues a SHA-256 preimage challenge: given salt + target hash,
// find n in [0, maxnumber] such that sha256(salt + String(n)) === target.
// Solution is sent as a base64 JSON header on the swap-create request.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { PowChallenge, PowPayload } from '../types/index.js';

const BATCH_SIZE = 10_000;

export async function solveChallenge(
  challenge: PowChallenge,
  onProgress?: (current: number, total: number) => void,
): Promise<PowPayload> {
  const { salt, challenge: target, maxnumber } = challenge;

  for (let start = 0; start <= maxnumber; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, maxnumber + 1);

    for (let n = start; n < end; n++) {
      const hash = bytesToHex(sha256(new TextEncoder().encode(salt + String(n))));
      if (hash === target) {
        return {
          algorithm: challenge.algorithm,
          challenge: target,
          number: n,
          salt,
          signature: challenge.signature,
        };
      }
    }

    onProgress?.(end, maxnumber);

    // Yield to the event loop between batches so the TUI stays responsive
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  throw new Error('PoW solution not found within search space');
}

export function encodePowHeader(payload: PowPayload): string {
  return btoa(JSON.stringify(payload));
}

// CLSAG ring-member validation:
//   1. output pubkey decompresses to a valid non-identity ed25519 point
//   2. Pedersen commitment decompresses to a valid ed25519 point
//   3. output is unlocked (coinbase past CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW
//      = 60, RingCT past DEFAULT_TX_SPENDABLE_AGE)
// Picking a locked member is the most common monerod [flags: invalid_input]
// rejection; wallet2 catches it via get_outs.unlocked, we mirror that and
// re-roll on any invalid slot.

import { Point } from '@noble/ed25519';
import type { Logger } from '../../interfaces/logger.js';
import type { OutputKeyInfo } from '../../lib/monero/rpc.js';

export interface InvalidRingMember {
  readonly ringIndex: number;
  readonly reason: string;
}

const IDENTITY_HEX = '01' + '00'.repeat(31);

// Returns the indices that must be replaced before signing.
export function validateRingMembers(
  members: readonly OutputKeyInfo[],
  log: Logger,
): InvalidRingMember[] {
  const invalid: InvalidRingMember[] = [];

  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (!member) continue;

    try {
      Point.fromHex(member.key);
      if (member.key === IDENTITY_HEX) {
        invalid.push({ ringIndex: i, reason: 'identity key' });
        continue;
      }
    } catch {
      invalid.push({ ringIndex: i, reason: 'invalid key point' });
      continue;
    }

    try {
      Point.fromHex(member.mask);
    } catch {
      invalid.push({ ringIndex: i, reason: 'invalid commitment point' });
      continue;
    }

    if (member.unlocked === false) {
      invalid.push({
        ringIndex: i,
        reason: `output not yet unlocked (height=${String(member.height)})`,
      });
      continue;
    }
  }

  if (invalid.length > 0) {
    log.warn(
      { invalidCount: invalid.length, details: invalid },
      'Ring contains invalid members',
    );
  }

  return invalid;
}

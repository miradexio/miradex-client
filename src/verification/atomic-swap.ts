import type {
  AtomicSwapVerification,
  VerificationCheck,
  VerificationResult,
} from '../types/index.js';
import {
  ATOMICSWAP_TIMELOCK_MAX_BLOCKS,
  ATOMICSWAP_TIMELOCK_MIN_BLOCKS,
} from './constants.js';
import { check, resultOf, type ProtocolContext, type VerifyParams } from './shared.js';

/**
 * Verify an atomic-swap deposit address — script type, refund address
 * binding, timelock range, and (if supplied) sidecar-claimed lock address
 * consistency.
 */
export function verifyAtomicSwap(
  v: AtomicSwapVerification,
  params: VerifyParams,
  protocol?: ProtocolContext,
): VerificationResult {
  const checks: VerificationCheck[] = [];

  checks.push(
    check('P2WSH deposit type', v.deposit_type === 'P2WSH', `Type: ${v.deposit_type}`),
  );

  const refundOk = v.refund_address === params.refundAddress;
  checks.push(
    check(
      'Refund address in script',
      refundOk,
      refundOk ? 'Refund address matches' : 'Refund address mismatch',
    ),
  );

  const timelockOk =
    v.timelock_blocks >= ATOMICSWAP_TIMELOCK_MIN_BLOCKS &&
    v.timelock_blocks <= ATOMICSWAP_TIMELOCK_MAX_BLOCKS;
  checks.push(
    check('Timelock range', timelockOk, `${v.timelock_blocks} blocks (~${v.timelock_hours}h)`),
  );

  if (protocol?.lock_address) {
    const lockOk = v.lock_address === protocol.lock_address;
    checks.push(check('Lock address match', lockOk, lockOk ? 'Consistent' : 'Mismatch'));
  }

  return resultOf('atomicswap', checks);
}

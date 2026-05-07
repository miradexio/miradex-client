// Pre-sign sanity check for sweep construction data:
//   1. destination matches the expected receive address
//   2. amount is positive
//   3. fee is positive and <= 10% of amount
//   4. inputs exist and ring sizes match the rct_type
// Lives in TS (not WASM) so business rules can change without rebuilding Rust.

import type { Logger } from '../../interfaces/logger.js';
import { noopLogger } from '../../interfaces/logger.js';

const CLSAG_RING_SIZE = 16;
const PRE_CLSAG_RING_SIZE = 11;

export interface SweepConstructionData {
  readonly inputs: readonly SweepInputData[];
  readonly destination: { readonly address: string; readonly amount: string | number };
  readonly fee: string | number;
  readonly tx_extra: string;
  readonly rct_type: number;
}

interface SweepInputData {
  readonly ring_members: readonly { readonly public_key: string; readonly commitment: string }[];
  readonly real_output_index: number;
  readonly real_output?: {
    readonly one_time_public_key: string;
    readonly tx_public_key: string;
    readonly output_index: number;
    readonly global_output_index: number;
    readonly amount: number;
    readonly rct_mask: string;
    readonly additional_tx_keys: readonly string[];
    readonly subaddr_major: number;
    readonly subaddr_minor: number;
  };
  readonly key_offsets: readonly number[];
}

export interface SweepVerificationResult {
  readonly valid: boolean;
  readonly amount: string;
  readonly fee: string;
  readonly reason?: string;
}

export function verifySweepTx(
  constructionData: SweepConstructionData,
  expectedAddress: string,
  logger: Logger = noopLogger,
): SweepVerificationResult {
  const amount = String(constructionData.destination.amount);
  const fee = String(constructionData.fee);

  if (constructionData.destination.address !== expectedAddress) {
    const reason = `Destination mismatch: expected ${expectedAddress}, got ${constructionData.destination.address}`;
    logger.error({ expectedAddress, got: constructionData.destination.address }, reason);
    return { valid: false, amount, fee, reason };
  }

  const amountNum = BigInt(amount);
  if (amountNum <= 0n) {
    const reason = `Sweep amount must be positive, got ${amount}`;
    logger.error({ amount }, reason);
    return { valid: false, amount, fee, reason };
  }

  const feeNum = BigInt(fee);
  if (feeNum <= 0n) {
    const reason = `Fee must be positive, got ${fee}`;
    logger.error({ fee }, reason);
    return { valid: false, amount, fee, reason };
  }

  const maxFee = amountNum / 10n;
  if (feeNum > maxFee) {
    const reason = `Fee ${fee} exceeds 10% of amount ${amount}`;
    logger.warn({ fee, amount, maxFee: maxFee.toString() }, reason);
    return { valid: false, amount, fee, reason };
  }

  if (constructionData.inputs.length === 0) {
    const reason = 'No inputs in construction data';
    logger.error({}, reason);
    return { valid: false, amount, fee, reason };
  }

  // rct_type 6 = CLSAG+BP+; otherwise CLSAG+BP.
  const expectedRingSize = constructionData.rct_type === 6 ? CLSAG_RING_SIZE : PRE_CLSAG_RING_SIZE;
  for (let i = 0; i < constructionData.inputs.length; i++) {
    const input = constructionData.inputs[i];
    if (!input) {
      const reason = `Input ${i} is undefined`;
      logger.error({ inputIndex: i }, reason);
      return { valid: false, amount, fee, reason };
    }

    if (input.ring_members.length !== expectedRingSize) {
      const reason = `Input ${i} has ${input.ring_members.length} ring members, expected ${expectedRingSize}`;
      logger.error({ inputIndex: i, ringSize: input.ring_members.length }, reason);
      return { valid: false, amount, fee, reason };
    }

    if (input.real_output_index >= input.ring_members.length) {
      const reason = `Input ${i} real_output_index ${input.real_output_index} out of range`;
      logger.error({ inputIndex: i, realIndex: input.real_output_index }, reason);
      return { valid: false, amount, fee, reason };
    }
  }

  logger.info(
    { amount, fee, inputs: constructionData.inputs.length },
    'Sweep tx verified',
  );
  return { valid: true, amount, fee };
}

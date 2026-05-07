// Client-side types that aren't server-response shapes.
//   ProtocolData / isAtomicProtocolData - engine's view of swap protocol data,
//                                         sourced from swapDetailProtocolDataSchema
//                                         so shape drift surfaces as SCHEMA_MISMATCH
//   HistoryEntry                        - client-side history-store row (vs. recents)

import type { SwapStatus, SwapDetailProtocolData } from '../wire/server/index.js';

export type ProtocolData = SwapDetailProtocolData;

// psbt + lock_address + timelock_blocks present.
export function isAtomicProtocolData(
  pd: unknown,
): pd is SwapDetailProtocolData & {
  psbt: string;
  lock_address: string;
  timelock_blocks: number;
} {
  if (!pd || typeof pd !== 'object') return false;
  const obj = pd as Record<string, unknown>;
  return (
    typeof obj.psbt === 'string' &&
    typeof obj.lock_address === 'string' &&
    typeof obj.timelock_blocks === 'number'
  );
}

export interface HistoryEntry {
  readonly id: number;
  readonly swapNumber: string;
  readonly fromToken: string;
  readonly toToken: string;
  readonly amountIn: string;
  readonly expectedAmountOut: string;
  readonly actualAmountOut: string | null;
  readonly provider: string;
  readonly status: SwapStatus;
  readonly depositAddress: string;
  readonly destAddress: string;
  readonly refundAddress: string;
  readonly depositTxHash: string | null;
  readonly outputTxHash: string | null;
  readonly verified: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

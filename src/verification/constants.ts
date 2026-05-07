export const VERIFY_MAX_ATTEMPTS = 12;
export const VERIFY_RETRY_DELAY_MS = 5_000;
export const VERIFY_FETCH_TIMEOUT_MS = 10_000;

// Chainflip's broker REST /v2/swaps/<composite> lags channel creation by
// ~30-60s (the on-chain channel exists immediately, the REST indexer
// catches up on its own cadence). First-attempt 404 is normal.
// Backoff starts tight so the common case clears in seconds, then
// lengthens so we don't hammer the gateway during real outages.
export const CHAINFLIP_REST_RETRY_TOTAL_MS = 120_000;
export const CHAINFLIP_REST_RETRY_BACKOFF_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
];
export const ATOMICSWAP_TIMELOCK_MIN_BLOCKS = 5;
export const ATOMICSWAP_TIMELOCK_MAX_BLOCKS = 288;

// V-1: BIP68 bounds for TxPunish (relative timelock Alice waits after
// TxCancel confirms). Floor is 5 — the smallest positive integer that
// rejects the degenerate 0 case while still admitting regtest fixtures
// that use 50. Real production bounds (>=72 mainnet) are enforced in the
// Rust core via env config.
export const ATOMICSWAP_PUNISH_TIMELOCK_MIN_BLOCKS = 5;
export const ATOMICSWAP_PUNISH_TIMELOCK_MAX_BLOCKS = 288;

// V-1 amnesty variant: BIP68 bounds for TxReclaim. Min is 1 — only the
// degenerate 0 is unsafe. Matches the Rust default
// bitcoin_remaining_refund_timelock = 2 (xmr-atomic-swap/core/swap-env/
// src/env.rs:65,88).
export const ATOMICSWAP_REMAINING_REFUND_TIMELOCK_MIN_BLOCKS = 1;
export const ATOMICSWAP_REMAINING_REFUND_TIMELOCK_MAX_BLOCKS = 288;

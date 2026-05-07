use rand::rngs::OsRng;
use rand::RngCore;
use rand_distr::{Distribution, Gamma};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// Match wallet2.cpp / monero-oxide.
const GAMMA_SHAPE: f64 = 19.28;
const GAMMA_SCALE: f64 = 1.0 / 1.61;
const BLOCK_TIME: usize = 120;

/// Minimum block age for a non-coinbase RingCT output to be spendable
/// (wallet2 DEFAULT_LOCK_WINDOW). Coinbase needs 60
/// (CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW); coinbase-heavy chains (regtest)
/// should pass a higher value to stay inside the unlocked region.
pub const DEFAULT_LOCK_WINDOW: usize = 10;

const RECENT_WINDOW: u64 = 15;
const BLOCKS_PER_YEAR: usize = (365 * 24 * 60 * 60) / BLOCK_TIME;
const MAX_ITERATIONS: usize = 1000;

#[derive(Debug, Deserialize)]
pub struct DecoySelectionInput {
    /// Cumulative RCT outputs per block (monerod get_output_distribution).
    pub distribution: Vec<u64>,
    /// Defaults to DEFAULT_LOCK_WINDOW (10). Coinbase-heavy chains pass 60.
    #[serde(default)]
    pub unlock_window_blocks: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct DecoySelectionResult {
    /// Sorted global output indices (includes the real output).
    pub indices: Vec<u64>,
    /// Position of the real output within `indices`.
    pub real_index_in_ring: u8,
}

/// wallet2 gamma_picker::pick() / monero-oxide select_n() reimplementation.
/// `distribution` comes from monerod get_output_distribution.
/// `unlock_window_blocks`: 10 matches wallet2 (RingCT) but can occasionally
/// pick still-locked coinbase outputs; pass 60 on coinbase-heavy chains.
pub fn select_decoys_inner(
    real_output_index: u64,
    distribution: &[u64],
    ring_size: u16,
    unlock_window_blocks: usize,
) -> Result<DecoySelectionResult, String> {
    if unlock_window_blocks == 0 {
        return Err("unlock_window_blocks must be >= 1".to_string());
    }
    if distribution.len() <= unlock_window_blocks {
        return Err(format!(
            "Distribution has {} blocks, need more than unlock_window_blocks={unlock_window_blocks}",
            distribution.len(),
        ));
    }
    if ring_size < 2 {
        return Err("Ring size must be at least 2".to_string());
    }

    let decoy_count = (ring_size - 1) as usize;

    // Highest spendable output index (excludes the locked-tail blocks).
    let highest_output_exclusive_bound = distribution[distribution.len() - unlock_window_blocks];
    if highest_output_exclusive_bound < ring_size as u64 {
        return Err("Not enough spendable outputs for decoy selection".to_string());
    }

    // wallet2 shifts ages by the unlock window so the effective "tip" is the
    // spendable tip, not the chain tip.
    let tip_application = (unlock_window_blocks * BLOCK_TIME) as f64;

    // Avg outputs per second over the last year (or all blocks if younger).
    let per_second = {
        let blocks = distribution.len().min(BLOCKS_PER_YEAR);
        let initial = distribution[distribution.len().saturating_sub(blocks + 1)];
        let outputs = distribution[distribution.len() - 1].saturating_sub(initial);
        (outputs as f64) / ((blocks * BLOCK_TIME) as f64)
    };

    if per_second <= 0.0 {
        return Err("Output distribution has zero outputs per second".to_string());
    }

    let gamma = Gamma::<f64>::new(GAMMA_SHAPE, GAMMA_SCALE)
        .map_err(|e| format!("Failed to create gamma distribution: {e}"))?;

    let mut rng = OsRng;
    let mut do_not_select = HashSet::new();
    do_not_select.insert(real_output_index);

    let mut candidates = Vec::with_capacity(decoy_count);
    let mut iterations = 0;

    while candidates.len() < decoy_count {
        iterations += 1;
        if iterations > MAX_ITERATIONS {
            return Err(format!(
                "Decoy selection exceeded {MAX_ITERATIONS} iterations (got {}/{})",
                candidates.len(),
                decoy_count,
            ));
        }

        // wallet2: gamma sample, exponentiate, offset by unlock time.
        let mut age: f64 = gamma.sample(&mut rng).exp();
        if age > tip_application {
            age -= tip_application;
        } else {
            // Very recent: uniform sample from the recent-window.
            age = (rng.next_u64()
                % (RECENT_WINDOW * u64::try_from(BLOCK_TIME).unwrap_or(120)))
                as f64;
        }

        let o = (age * per_second) as u64;
        if o >= highest_output_exclusive_bound {
            continue;
        }

        // Map to a global output index via the cumulative distribution.
        let target = highest_output_exclusive_bound - 1 - o;
        let block_idx = distribution.partition_point(|s| *s < target);
        let prev_block_outputs = if block_idx == 0 { 0 } else { distribution[block_idx - 1] };
        let block_outputs = distribution
            .get(block_idx)
            .copied()
            .unwrap_or(0)
            .saturating_sub(prev_block_outputs);

        if block_outputs == 0 {
            continue;
        }

        let selected = prev_block_outputs + (rng.next_u64() % block_outputs);
        if do_not_select.contains(&selected) {
            continue;
        }

        candidates.push(selected);
        do_not_select.insert(selected);
    }

    candidates.push(real_output_index);
    candidates.sort_unstable();

    let real_index_in_ring = candidates
        .binary_search(&real_output_index)
        .map_err(|_| "Real output not found in sorted ring".to_string())?;

    Ok(DecoySelectionResult {
        indices: candidates,
        real_index_in_ring: real_index_in_ring as u8,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a realistic-looking cumulative distribution for testing.
    /// 1000 blocks, ~2 outputs per block on average.
    fn test_distribution() -> Vec<u64> {
        let mut dist = Vec::with_capacity(1000);
        let mut cumulative = 0u64;
        for i in 0..1000 {
            // Variable outputs per block (1-4)
            cumulative += 1 + ((i * 7 + 3) % 4);
            dist.push(cumulative);
        }
        dist
    }

    #[test]
    fn test_correct_ring_size() {
        let dist = test_distribution();
        let real_idx = dist[500]; // an output roughly in the middle
        let result = select_decoys_inner(real_idx, &dist, 16, DEFAULT_LOCK_WINDOW).unwrap();
        assert_eq!(result.indices.len(), 16);
    }

    #[test]
    fn test_no_duplicates() {
        let dist = test_distribution();
        let real_idx = dist[500];
        let result = select_decoys_inner(real_idx, &dist, 16, DEFAULT_LOCK_WINDOW).unwrap();
        let unique: HashSet<u64> = result.indices.iter().copied().collect();
        assert_eq!(unique.len(), result.indices.len());
    }

    #[test]
    fn test_real_output_included() {
        let dist = test_distribution();
        let real_idx = dist[500];
        let result = select_decoys_inner(real_idx, &dist, 16, DEFAULT_LOCK_WINDOW).unwrap();
        assert!(result.indices.contains(&real_idx));
    }

    #[test]
    fn test_real_index_correct() {
        let dist = test_distribution();
        let real_idx = dist[500];
        let result = select_decoys_inner(real_idx, &dist, 16, DEFAULT_LOCK_WINDOW).unwrap();
        assert_eq!(
            result.indices[result.real_index_in_ring as usize],
            real_idx
        );
    }

    #[test]
    fn test_indices_sorted() {
        let dist = test_distribution();
        let real_idx = dist[500];
        let result = select_decoys_inner(real_idx, &dist, 16, DEFAULT_LOCK_WINDOW).unwrap();
        for i in 1..result.indices.len() {
            assert!(result.indices[i] > result.indices[i - 1]);
        }
    }

    #[test]
    fn test_distribution_too_small() {
        let dist = vec![1, 2, 3, 4, 5]; // only 5 blocks, less than DEFAULT_LOCK_WINDOW
        let result = select_decoys_inner(3, &dist, 16, DEFAULT_LOCK_WINDOW);
        assert!(result.is_err());
    }

    #[test]
    fn test_ring_size_two() {
        let dist = test_distribution();
        let real_idx = dist[500];
        let result = select_decoys_inner(real_idx, &dist, 2, DEFAULT_LOCK_WINDOW).unwrap();
        assert_eq!(result.indices.len(), 2);
        assert!(result.indices.contains(&real_idx));
    }

    #[test]
    fn test_recent_output() {
        let dist = test_distribution();
        // Use an output near the tip (but before lock window)
        let real_idx = dist[dist.len() - DEFAULT_LOCK_WINDOW - 1];
        let result = select_decoys_inner(real_idx, &dist, 16, DEFAULT_LOCK_WINDOW).unwrap();
        assert_eq!(result.indices.len(), 16);
        assert!(result.indices.contains(&real_idx));
    }

    /// With `unlock_window_blocks = 60` (coinbase lock window) the picker
    /// must never pick an output from the most recent 60 blocks. This is the
    /// regtest-safe configuration: a chain dominated by coinbases needs the
    /// full coinbase lock to keep all selections inside the unlocked region.
    #[test]
    fn test_unlock_window_excludes_locked_tail() {
        let dist = test_distribution();
        let unlock_window = 60usize;
        let real_idx = dist[200]; // pick a real output well into the unlocked region
        // Highest spendable output index — anything >= this is locked.
        let highest_unlocked = dist[dist.len() - unlock_window];
        for _ in 0..50 {
            let result =
                select_decoys_inner(real_idx, &dist, 16, unlock_window).unwrap();
            for idx in &result.indices {
                if *idx == real_idx {
                    continue;
                }
                assert!(
                    *idx < highest_unlocked,
                    "decoy {idx} fell inside locked tail (>= {highest_unlocked})",
                );
            }
        }
    }

    #[test]
    fn test_unlock_window_zero_is_rejected() {
        let dist = test_distribution();
        let real_idx = dist[500];
        let result = select_decoys_inner(real_idx, &dist, 16, 0);
        assert!(result.is_err());
    }
}

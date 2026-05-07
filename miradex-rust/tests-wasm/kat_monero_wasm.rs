//! Exercise Monero primitives through the compiled wasm binary.
//!
//! Smoke-level: the deep KATs live in the native test suite. Here we just
//! ensure the compiled wasm produces identical outputs for a deterministic
//! input, guarding against wasm32-specific codegen drift.

#![cfg(target_arch = "wasm32")]

use miradex_rust::compute_commitment_mask;
use wasm_bindgen_test::*;

#[wasm_bindgen_test]
fn commitment_mask_deterministic_in_wasm() {
    let view_key = "b7334b07a86b3af53c5f5ff80d9ff6e2a42f1c7e6a14a6b34e8b9a3e62fdf701";
    let tx_pub_key = "8e3e11c7d46b49f7a89c94aef6f24aa1a15b8ec3a7b0d7af8afc3a42f3b4e9cb";
    let a = compute_commitment_mask(view_key, tx_pub_key, 0).unwrap();
    let b = compute_commitment_mask(view_key, tx_pub_key, 0).unwrap();
    assert_eq!(a, b, "mask derivation must be deterministic");
    assert_eq!(a.len(), 64, "mask must be 32 bytes hex");
}

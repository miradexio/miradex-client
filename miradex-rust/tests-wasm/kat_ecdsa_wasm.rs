//! Exercise ECDSA signing through the compiled wasm binary.

#![cfg(target_arch = "wasm32")]

use miradex_rust::{generate_client_keys, sign_digest};
use wasm_bindgen_test::*;

#[wasm_bindgen_test]
fn sign_produces_64_byte_sig() {
    let json = generate_client_keys().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let b = parsed["b"].as_str().unwrap();
    let digest = "aa".repeat(32);
    let sig = sign_digest(b, &digest).unwrap();
    assert_eq!(sig.len(), 128);
}

#[wasm_bindgen_test]
fn sign_is_deterministic_in_wasm() {
    let json = generate_client_keys().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let b = parsed["b"].as_str().unwrap();
    let digest = "bb".repeat(32);
    let a = sign_digest(b, &digest).unwrap();
    let b2 = sign_digest(b, &digest).unwrap();
    assert_eq!(a, b2);
}

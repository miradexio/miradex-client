//! Exercise keygen through the compiled wasm binary.

#![cfg(target_arch = "wasm32")]

use miradex_rust::{generate_client_keys, verify_dleq_proof};
use wasm_bindgen_test::*;

#[wasm_bindgen_test]
fn dleq_roundtrip_in_wasm() {
    let json = generate_client_keys().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let valid = verify_dleq_proof(
        parsed["s_b_bitcoin"].as_str().unwrap(),
        parsed["s_b_monero"].as_str().unwrap(),
        parsed["dleq_proof"].as_str().unwrap(),
    )
    .unwrap();
    assert!(valid);
}

#[wasm_bindgen_test]
fn generate_has_all_fields_in_wasm() {
    let json = generate_client_keys().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    for field in [
        "s_b_bitcoin",
        "s_b_monero",
        "dleq_proof",
        "v_b",
        "b",
        "B",
        "s_b",
    ] {
        assert!(parsed[field].is_string(), "missing field: {field}");
    }
}

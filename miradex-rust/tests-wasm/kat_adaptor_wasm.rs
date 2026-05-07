//! Exercise adaptor signatures through the compiled wasm binary.

#![cfg(target_arch = "wasm32")]

use miradex_rust::{
    decrypt_signature, encsign_digest, generate_client_keys, recover_adaptor_scalar,
    verify_encsig,
};
use wasm_bindgen_test::*;

#[wasm_bindgen_test]
fn adaptor_full_roundtrip_in_wasm() {
    let alice = generate_client_keys().unwrap();
    let alice_parsed: serde_json::Value = serde_json::from_str(&alice).unwrap();
    let a_secret = alice_parsed["b"].as_str().unwrap();
    let a_public = alice_parsed["B"].as_str().unwrap();

    let bob = generate_client_keys().unwrap();
    let bob_parsed: serde_json::Value = serde_json::from_str(&bob).unwrap();
    let s_b_bitcoin = bob_parsed["s_b_bitcoin"].as_str().unwrap();
    let s_b = bob_parsed["s_b"].as_str().unwrap();

    let digest = "cc".repeat(32);
    let encsig = encsign_digest(a_secret, s_b_bitcoin, &digest).unwrap();

    assert!(verify_encsig(a_public, s_b_bitcoin, &digest, &encsig).unwrap());

    let mut s_b_bytes = hex::decode(s_b).unwrap();
    s_b_bytes.reverse();
    let s_b_secp = hex::encode(&s_b_bytes);
    let sig = decrypt_signature(&s_b_secp, &encsig).unwrap();
    let recovered = recover_adaptor_scalar(&sig, &encsig, s_b_bitcoin).unwrap();
    assert_eq!(recovered, s_b_secp);
}

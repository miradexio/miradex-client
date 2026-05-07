use miradex_rust::ecdsa::{decrypt, encsign, recover, verify};
use miradex_rust::keygen::generate;

#[test]
fn encsign_verify_decrypt_roundtrip() {
    let alice = generate::generate_client_keys().unwrap();
    let alice_parsed: serde_json::Value = serde_json::from_str(&alice).unwrap();
    let a_secret = alice_parsed["b"].as_str().unwrap();
    let a_public = alice_parsed["B"].as_str().unwrap();

    let bob = generate::generate_client_keys().unwrap();
    let bob_parsed: serde_json::Value = serde_json::from_str(&bob).unwrap();
    let s_b_bitcoin = bob_parsed["s_b_bitcoin"].as_str().unwrap();
    let s_b = bob_parsed["s_b"].as_str().unwrap();

    let digest = "cc".repeat(32);

    let encsig = encsign::encsign_digest(a_secret, s_b_bitcoin, &digest).unwrap();
    assert!(!encsig.is_empty());

    assert!(verify::verify_encsig(a_public, s_b_bitcoin, &digest, &encsig).unwrap());

    // s_b is ed25519 LE in the JSON; decrypt_signature wants secp BE — reverse.
    let mut s_b_bytes = hex::decode(s_b).unwrap();
    s_b_bytes.reverse();
    let s_b_secp = hex::encode(&s_b_bytes);

    let sig_hex = decrypt::decrypt_signature(&s_b_secp, &encsig).unwrap();
    assert_eq!(sig_hex.len(), 128);
}

#[test]
fn recover_roundtrip() {
    let alice = generate::generate_client_keys().unwrap();
    let alice_parsed: serde_json::Value = serde_json::from_str(&alice).unwrap();
    let a_secret = alice_parsed["b"].as_str().unwrap();

    let bob = generate::generate_client_keys().unwrap();
    let bob_parsed: serde_json::Value = serde_json::from_str(&bob).unwrap();
    let s_b_bitcoin = bob_parsed["s_b_bitcoin"].as_str().unwrap();
    let s_b = bob_parsed["s_b"].as_str().unwrap();

    let digest = "dd".repeat(32);
    let encsig = encsign::encsign_digest(a_secret, s_b_bitcoin, &digest).unwrap();
    let mut s_b_bytes = hex::decode(s_b).unwrap();
    s_b_bytes.reverse();
    let s_b_secp = hex::encode(&s_b_bytes);
    let sig_hex = decrypt::decrypt_signature(&s_b_secp, &encsig).unwrap();

    let recovered = recover::recover_adaptor_scalar(&sig_hex, &encsig, s_b_bitcoin).unwrap();
    assert_eq!(recovered, s_b_secp, "recovered scalar must equal decryption scalar");
}

#[test]
fn verify_encsig_rejects_tampered() {
    let alice = generate::generate_client_keys().unwrap();
    let alice_parsed: serde_json::Value = serde_json::from_str(&alice).unwrap();
    let a_secret = alice_parsed["b"].as_str().unwrap();
    let a_public = alice_parsed["B"].as_str().unwrap();

    let bob = generate::generate_client_keys().unwrap();
    let bob_parsed: serde_json::Value = serde_json::from_str(&bob).unwrap();
    let s_b_bitcoin = bob_parsed["s_b_bitcoin"].as_str().unwrap();

    let digest = "ee".repeat(32);
    let encsig = encsign::encsign_digest(a_secret, s_b_bitcoin, &digest).unwrap();
    let mut tampered_bytes = hex::decode(&encsig).unwrap();
    tampered_bytes[10] ^= 0xff;
    let tampered = hex::encode(&tampered_bytes);

    let result = verify::verify_encsig(a_public, s_b_bitcoin, &digest, &tampered);
    match result {
        Ok(valid) => assert!(!valid),
        Err(_) => {} // deserialisation error acceptable
    }
}

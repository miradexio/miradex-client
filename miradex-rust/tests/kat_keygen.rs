use miradex_rust::keygen::{dleq, generate};

#[test]
fn verify_dleq_roundtrip() {
    let json = generate::generate_client_keys().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    let valid = dleq::verify(
        parsed["s_b_bitcoin"].as_str().unwrap(),
        parsed["s_b_monero"].as_str().unwrap(),
        parsed["dleq_proof"].as_str().unwrap(),
    )
    .unwrap();
    assert!(valid, "DLEQ proof for own keys must verify");
}

#[test]
fn verify_dleq_bad_proof() {
    let json = generate::generate_client_keys().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let mut proof_bytes = hex::decode(parsed["dleq_proof"].as_str().unwrap()).unwrap();
    let mid = proof_bytes.len() / 2;
    proof_bytes[mid] ^= 0xff;
    let tampered_proof = hex::encode(&proof_bytes);

    let result = dleq::verify(
        parsed["s_b_bitcoin"].as_str().unwrap(),
        parsed["s_b_monero"].as_str().unwrap(),
        &tampered_proof,
    );
    match result {
        Ok(valid) => assert!(!valid, "Tampered proof must not verify"),
        Err(_) => {} // deserialisation error acceptable
    }
}

#[test]
fn verify_dleq_mismatched_keys() {
    let json1 = generate::generate_client_keys().unwrap();
    let parsed1: serde_json::Value = serde_json::from_str(&json1).unwrap();
    let json2 = generate::generate_client_keys().unwrap();
    let parsed2: serde_json::Value = serde_json::from_str(&json2).unwrap();

    let valid = dleq::verify(
        parsed1["s_b_bitcoin"].as_str().unwrap(),
        parsed1["s_b_monero"].as_str().unwrap(),
        parsed2["dleq_proof"].as_str().unwrap(),
    )
    .unwrap();
    assert!(!valid, "Proof from different keypair must not verify");
}

#[test]
fn generate_client_keys_has_all_fields() {
    let json = generate::generate_client_keys().unwrap();
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

#[test]
fn generate_from_seed_deterministic() {
    let s_b = "0a0b0c0d0e0f10111213141516171819000000000000000000000000000000ab";
    let v_b = "1a1b1c1d1e1f20212223242526272829000000000000000000000000000000cd";
    let b = "0000000000000000000000000000000000000000000000000000000000000042";

    let json = generate::from_seed(s_b, v_b, b).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    let json2 = generate::from_seed(s_b, v_b, b).unwrap();
    let parsed2: serde_json::Value = serde_json::from_str(&json2).unwrap();
    assert_eq!(parsed["B"], parsed2["B"]);
    assert_eq!(parsed["s_b"], parsed2["s_b"]);
}

#[test]
fn generate_from_seed_rejects_short_input() {
    let err = generate::from_seed("ab", "ab", "ab").unwrap_err();
    assert_eq!(err.code(), "E_LENGTH");
}

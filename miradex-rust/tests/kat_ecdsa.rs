use miradex_rust::ecdsa::sign;
use miradex_rust::keygen::generate;

#[test]
fn sign_digest_produces_64_byte_sig() {
    let json = generate::generate_client_keys().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let b = parsed["b"].as_str().unwrap();
    let digest = "aa".repeat(32);

    let sig_hex = sign::sign_digest(b, &digest).unwrap();
    assert_eq!(sig_hex.len(), 128, "64 bytes = 128 hex chars");
}

#[test]
fn sign_digest_deterministic() {
    let json = generate::generate_client_keys().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let b = parsed["b"].as_str().unwrap();
    let digest = "bb".repeat(32);
    let sig_a = sign::sign_digest(b, &digest).unwrap();
    let sig_b = sign::sign_digest(b, &digest).unwrap();
    assert_eq!(sig_a, sig_b, "RFC6979 deterministic ECDSA must be deterministic");
}

#[test]
fn sign_rejects_bad_key_length() {
    let digest = "aa".repeat(32);
    let err = sign::sign_digest("ab", &digest).unwrap_err();
    assert_eq!(err.code(), "E_LENGTH");
}

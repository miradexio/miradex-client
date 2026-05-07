//! Adaptor verification — ported from keygen-wasm.

use ecdsa_fun::adaptor::Adaptor;
use ecdsa_fun::nonce::Deterministic;
use sha2::Sha256;
use sigma_fun::HashTranscript;

use crate::util::decode::{decode_encsig, decode_hex_exact, decode_secp_point};
use crate::util::errors::Result;

pub fn verify_encsig(
    verification_key_hex: &str,
    encryption_key_hex: &str,
    digest_hex: &str,
    encsig_hex: &str,
) -> Result<bool> {
    let verification_key = decode_secp_point(verification_key_hex, "verification_key")?;
    let encryption_key = decode_secp_point(encryption_key_hex, "encryption_key")?;
    let digest = decode_hex_exact::<32>(digest_hex, "digest")?;
    let encsig = decode_encsig(encsig_hex)?;
    let adaptor = Adaptor::<
        HashTranscript<Sha256, rand_chacha::ChaCha20Rng>,
        Deterministic<Sha256>,
    >::default();
    Ok(adaptor.verify_encrypted_signature(&verification_key, &encryption_key, &digest, &encsig))
}

//! Adaptor-encrypted signing — ported from keygen-wasm.

use ecdsa_fun::adaptor::Adaptor;
use ecdsa_fun::nonce::Deterministic;
use sha2::Sha256;
use sigma_fun::HashTranscript;

use crate::util::decode::{decode_hex_exact, decode_secp_point, decode_secp_scalar_nonzero};
use crate::util::errors::{MiradexWasmError, Result};

pub fn encsign_digest(
    b_hex: &str,
    encryption_key_hex: &str,
    digest_hex: &str,
) -> Result<String> {
    let b = decode_secp_scalar_nonzero(b_hex, "b")?;
    let encryption_key = decode_secp_point(encryption_key_hex, "encryption_key")?;
    let digest_arr = decode_hex_exact::<32>(digest_hex, "digest")?;

    let adaptor = Adaptor::<
        HashTranscript<Sha256, rand_chacha::ChaCha20Rng>,
        Deterministic<Sha256>,
    >::default();
    let encsig = adaptor.encrypted_sign(&b, &encryption_key, &digest_arr);
    let bytes = bincode::serialize(&encsig)
        .map_err(|e| MiradexWasmError::Serialize(format!("encsig: {e}")))?;
    Ok(hex::encode(bytes))
}

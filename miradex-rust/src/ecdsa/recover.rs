//! Recover the adaptor scalar (s_a) from a decrypted signature + encsig.
//!
//! Mirrors swap-wasm-rust::recover_scalar but uses the argument order that
//! miradex-client expects: `(sig, encsig, encryption_key)`.

use ecdsa_fun::adaptor::Adaptor;
use ecdsa_fun::nonce::Deterministic;
use ecdsa_fun::Signature;
use sha2::Sha256;
use sigma_fun::HashTranscript;

use crate::util::decode::{decode_encsig, decode_hex_exact, decode_secp_point};
use crate::util::errors::{MiradexWasmError, Result};

pub fn recover_adaptor_scalar(
    sig_hex: &str,
    encsig_hex: &str,
    encryption_key_hex: &str,
) -> Result<String> {
    let sig_arr = decode_hex_exact::<64>(sig_hex, "sig")?;
    let sig = Signature::from_bytes(sig_arr)
        .ok_or(MiradexWasmError::NotReduced { field: "sig" })?;
    let encsig = decode_encsig(encsig_hex)?;
    let encryption_key = decode_secp_point(encryption_key_hex, "encryption_key")?;

    let adaptor = Adaptor::<
        HashTranscript<Sha256, rand_chacha::ChaCha20Rng>,
        Deterministic<Sha256>,
    >::default();
    let scalar = adaptor
        .recover_decryption_key(&encryption_key, &sig, &encsig)
        .ok_or(MiradexWasmError::EncsigInvalid)?;
    Ok(hex::encode(scalar.to_bytes()))
}

//! Adaptor decryption — ported from keygen-wasm.

use ecdsa_fun::adaptor::Adaptor;
use ecdsa_fun::nonce::Deterministic;
use sha2::Sha256;
use sigma_fun::HashTranscript;

use crate::util::decode::{decode_encsig, decode_secp_scalar_nonzero};
use crate::util::errors::Result;

pub fn decrypt_signature(scalar_hex: &str, encsig_hex: &str) -> Result<String> {
    let scalar = decode_secp_scalar_nonzero(scalar_hex, "scalar")?;
    let encsig = decode_encsig(encsig_hex)?;
    let adaptor = Adaptor::<
        HashTranscript<Sha256, rand_chacha::ChaCha20Rng>,
        Deterministic<Sha256>,
    >::default();
    let sig = adaptor.decrypt_signature(&scalar, encsig);
    Ok(hex::encode(sig.to_bytes()))
}

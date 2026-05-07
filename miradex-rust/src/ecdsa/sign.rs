//! ECDSA signing — ported from keygen-wasm.

use ecdsa_fun::nonce::Deterministic;
use ecdsa_fun::ECDSA;
use sha2::Sha256;

use crate::util::decode::{decode_hex_exact, decode_secp_scalar_nonzero};
use crate::util::errors::Result;

pub fn sign_digest(b_hex: &str, digest_hex: &str) -> Result<String> {
    let b = decode_secp_scalar_nonzero(b_hex, "b")?;
    let digest_arr = decode_hex_exact::<32>(digest_hex, "digest")?;
    let ecdsa = ECDSA::<Deterministic<Sha256>>::default();
    let sig = ecdsa.sign(&b, &digest_arr);
    Ok(hex::encode(sig.to_bytes()))
}

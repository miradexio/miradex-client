//! DLEQ proof verification (ported from keygen-wasm).

use curve25519_dalek_ng::constants::ED25519_BASEPOINT_POINT;
use ecdsa_fun::fun;
use sha2::Sha256;
use sigma_fun::ext::dl_secp256k1_ed25519_eq::CrossCurveDLEQ;
use sigma_fun::HashTranscript;

use crate::util::decode::{decode_ed25519_point, decode_hex, decode_secp_point};
use crate::util::errors::{MiradexWasmError, Result};

pub fn verify(s_bitcoin_hex: &str, s_monero_hex: &str, proof_hex: &str) -> Result<bool> {
    let s_bitcoin = decode_secp_point(s_bitcoin_hex, "s_bitcoin")?;
    let s_monero = decode_ed25519_point(s_monero_hex, "s_monero")?;

    let proof_bytes = decode_hex(proof_hex, "proof")?;
    let proof = bincode::deserialize(&proof_bytes)
        .map_err(|e| MiradexWasmError::Serialize(format!("dleq deserialize: {e}")))?;

    let proof_system = CrossCurveDLEQ::<HashTranscript<Sha256, rand_chacha::ChaCha20Rng>>::new(
        (*fun::G).normalize(),
        ED25519_BASEPOINT_POINT,
    );
    Ok(proof_system.verify(&proof, (s_bitcoin, s_monero)))
}

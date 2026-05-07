//! BTC/XMR key bundle + DLEQ proof. Ported from
//! rust-sidecar/eigenwallet/core/keygen-wasm; panic sites rewritten to
//! return MiradexWasmError.

use curve25519_dalek_ng::constants::ED25519_BASEPOINT_POINT;
use curve25519_dalek_ng::scalar::Scalar;
use ecdsa_fun::fun::{
    self,
    marker::{NonZero, Secret},
};
use rand::rngs::OsRng;
use sha2::Sha256;
use sigma_fun::ext::dl_secp256k1_ed25519_eq::CrossCurveDLEQ;
use sigma_fun::HashTranscript;

use super::schema::ClientKeysJson;
use crate::util::decode::decode_hex_exact;
use crate::util::errors::{MiradexWasmError, Result};

type ProofSystem = CrossCurveDLEQ<HashTranscript<Sha256, rand_chacha::ChaCha20Rng>>;

fn build_proof_system() -> ProofSystem {
    CrossCurveDLEQ::<HashTranscript<Sha256, rand_chacha::ChaCha20Rng>>::new(
        (*fun::G).normalize(),
        ED25519_BASEPOINT_POINT,
    )
}

fn build_keys_json(
    s_b: &Scalar,
    v_b: &Scalar,
    b: &fun::Scalar<Secret, NonZero>,
    proof_system: &ProofSystem,
) -> Result<String> {
    let (dleq_proof, (s_b_bitcoin, s_b_monero)) = proof_system.prove(s_b, &mut OsRng);
    let s_b_bitcoin_bytes: [u8; 33] = s_b_bitcoin.to_bytes();
    let s_b_monero_bytes = s_b_monero.compress().to_bytes();
    let dleq_bytes = bincode::serialize(&dleq_proof)
        .map_err(|e| MiradexWasmError::Serialize(format!("dleq proof: {e}")))?;

    let ecdsa = ecdsa_fun::ECDSA::<()>::default();
    let b_public = ecdsa.verification_key_for(b);
    let b_public_bytes: [u8; 33] = b_public.to_bytes();

    let out = ClientKeysJson {
        s_b_bitcoin: hex::encode(s_b_bitcoin_bytes),
        s_b_monero: hex::encode(s_b_monero_bytes),
        s_b: hex::encode(s_b.to_bytes()),
        dleq_proof: hex::encode(dleq_bytes),
        v_b: hex::encode(v_b.to_bytes()),
        b: hex::encode(b.to_bytes()),
        B: hex::encode(b_public_bytes),
    };
    serde_json::to_string(&out).map_err(|e| MiradexWasmError::Serialize(format!("client keys: {e}")))
}

pub fn generate_client_keys() -> Result<String> {
    let proof_system = build_proof_system();
    let s_b = Scalar::random(&mut OsRng);
    let v_b = Scalar::random(&mut OsRng);
    let b: fun::Scalar<Secret, NonZero> = fun::Scalar::random(&mut OsRng);
    build_keys_json(&s_b, &v_b, &b, &proof_system)
}

pub fn from_seed(s_b_hex: &str, v_b_hex: &str, b_hex: &str) -> Result<String> {
    let proof_system = build_proof_system();

    let s_b_arr = decode_hex_exact::<32>(s_b_hex, "s_b")?;
    let s_b = Scalar::from_bytes_mod_order(s_b_arr);

    let v_b_arr = decode_hex_exact::<32>(v_b_hex, "v_b")?;
    let v_b = Scalar::from_bytes_mod_order(v_b_arr);

    let b_arr = decode_hex_exact::<32>(b_hex, "b")?;
    let b = fun::Scalar::from_bytes(b_arr)
        .ok_or(MiradexWasmError::NotReduced { field: "b" })?
        .non_zero()
        .ok_or(MiradexWasmError::NotReduced { field: "b" })?;

    build_keys_json(&s_b, &v_b, &b, &proof_system)
}

//! Hex / point / scalar / encsig decoders shared across modules.

use curve25519_dalek_ng::edwards::{CompressedEdwardsY, EdwardsPoint};
use curve25519_dalek_ng::scalar::Scalar as ScalarNg;
use ecdsa_fun::adaptor::EncryptedSignature;
use ecdsa_fun::fun;
use ecdsa_fun::fun::marker::{NonZero, Secret};

use super::errors::{MiradexWasmError, Result};

pub fn decode_hex(hex_str: &str, field: &'static str) -> Result<Vec<u8>> {
    hex::decode(hex_str).map_err(|e| MiradexWasmError::HexDecode {
        field,
        message: e.to_string(),
    })
}

pub fn decode_hex_exact<const N: usize>(hex_str: &str, field: &'static str) -> Result<[u8; N]> {
    let bytes = decode_hex(hex_str, field)?;
    let got = bytes.len();
    bytes
        .try_into()
        .map_err(|_: Vec<u8>| MiradexWasmError::Length {
            field,
            expected: N,
            got,
        })
}

pub fn decode_secp_point(hex_str: &str, field: &'static str) -> Result<fun::Point> {
    let arr = decode_hex_exact::<33>(hex_str, field)?;
    fun::Point::from_bytes(arr).ok_or(MiradexWasmError::NotOnCurve { field })
}

pub fn decode_secp_scalar_nonzero(
    hex_str: &str,
    field: &'static str,
) -> Result<fun::Scalar<Secret, NonZero>> {
    let arr = decode_hex_exact::<32>(hex_str, field)?;
    fun::Scalar::from_bytes(arr)
        .ok_or(MiradexWasmError::NotReduced { field })?
        .non_zero()
        .ok_or(MiradexWasmError::NotReduced { field })
}

pub fn decode_encsig(hex_str: &str) -> Result<EncryptedSignature> {
    let bytes = decode_hex(hex_str, "encsig")?;
    bincode::deserialize(&bytes).map_err(|e| MiradexWasmError::EncsigDeserialize(e.to_string()))
}

pub fn decode_ed25519_scalar(hex_str: &str, field: &'static str) -> Result<ScalarNg> {
    let arr = decode_hex_exact::<32>(hex_str, field)?;
    Ok(ScalarNg::from_bytes_mod_order(arr))
}

pub fn decode_ed25519_point(hex_str: &str, field: &'static str) -> Result<EdwardsPoint> {
    let arr = decode_hex_exact::<32>(hex_str, field)?;
    CompressedEdwardsY(arr)
        .decompress()
        .ok_or(MiradexWasmError::NotOnCurve { field })
}

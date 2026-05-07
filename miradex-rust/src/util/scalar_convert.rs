//! secp256k1 ↔ ed25519 scalar conversion helpers.
//!
//! secp256k1 stores 32-byte scalars big-endian; ed25519 little-endian.
//! A key share produced on one curve is reinterpreted on the other by
//! reversing the byte order, then reducing modulo the target group order.

use curve25519_dalek_ng::scalar::Scalar as ScalarNg;

use super::decode::decode_hex_exact;
use super::errors::Result;

pub fn secp_to_ed(secp_hex: &str) -> Result<String> {
    let mut bytes = decode_hex_exact::<32>(secp_hex, "secp_scalar")?;
    bytes.reverse();
    let scalar = ScalarNg::from_bytes_mod_order(bytes);
    Ok(hex::encode(scalar.to_bytes()))
}

pub fn ed_add(a_hex: &str, b_hex: &str) -> Result<String> {
    let a = decode_hex_exact::<32>(a_hex, "scalar_a")?;
    let b = decode_hex_exact::<32>(b_hex, "scalar_b")?;
    let sum = ScalarNg::from_bytes_mod_order(a) + ScalarNg::from_bytes_mod_order(b);
    Ok(hex::encode(sum.to_bytes()))
}

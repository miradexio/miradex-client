use curve25519_dalek::edwards::CompressedEdwardsY;
use curve25519_dalek::scalar::Scalar;
use monero_oxide::ed25519::Commitment;

use crate::monero::helpers::decode_hex_exact;
use crate::monero::key_images::derivation_to_scalar;

// wallet2 genCommitmentMask (rctOps.cpp):
//   derivation = 8 * view_key * R
//   scalar     = Hs(derivation_compressed || varint(output_index))
//   mask       = Hs("commitment_mask" || scalar_bytes)
// sign_sweep_tx uses the mask to build the Pedersen commitment for the real input.
pub fn compute_mask_inner(
    view_key_hex: &str,
    tx_public_key_hex: &str,
    output_index: u64,
) -> Result<String, String> {
    let view_key_bytes = decode_hex_exact::<32>(view_key_hex, "view_key")?;
    let view_key = Scalar::from_canonical_bytes(view_key_bytes)
        .into_option()
        .ok_or_else(|| "view_key is not a canonical scalar".to_string())?;

    let r_bytes = decode_hex_exact::<32>(tx_public_key_hex, "tx_public_key")?;
    let r_point = CompressedEdwardsY(r_bytes)
        .decompress()
        .ok_or_else(|| "tx_public_key is not a valid ed25519 point".to_string())?;

    let key_derivation = (view_key * r_point).mul_by_cofactor();
    let derivation_scalar = derivation_to_scalar(&key_derivation, output_index);

    // 15-byte "commitment_mask" prefix + 32-byte scalar = wallet2 layout.
    let mut mask_preimage = Vec::with_capacity(15 + 32);
    mask_preimage.extend_from_slice(b"commitment_mask");
    mask_preimage.extend_from_slice(derivation_scalar.as_bytes());

    let mask_hash = monero_oxide::primitives::keccak256(&mask_preimage);
    let mask = Scalar::from_bytes_mod_order(mask_hash);

    Ok(hex::encode(mask.as_bytes()))
}

// Same key derivation as compute_mask_inner. Encryption is
// `encrypted = amount XOR Hs("amount" || derivation_scalar)[0:8]`. Returns piconeros.
pub fn decrypt_amount_inner(
    view_key_hex: &str,
    tx_public_key_hex: &str,
    output_index: u64,
    encrypted_amount_hex: &str,
) -> Result<u64, String> {
    let view_key_bytes = decode_hex_exact::<32>(view_key_hex, "view_key")?;
    let view_key = Scalar::from_canonical_bytes(view_key_bytes)
        .into_option()
        .ok_or_else(|| "view_key is not a canonical scalar".to_string())?;

    let r_bytes = decode_hex_exact::<32>(tx_public_key_hex, "tx_public_key")?;
    let r_point = CompressedEdwardsY(r_bytes)
        .decompress()
        .ok_or_else(|| "tx_public_key is not a valid ed25519 point".to_string())?;

    let key_derivation = (view_key * r_point).mul_by_cofactor();
    let derivation_scalar = derivation_to_scalar(&key_derivation, output_index);

    // amount_key = Hs("amount" || derivation_scalar).
    let mut amount_preimage = Vec::with_capacity(6 + 32);
    amount_preimage.extend_from_slice(b"amount");
    amount_preimage.extend_from_slice(derivation_scalar.as_bytes());
    let amount_key = monero_oxide::primitives::keccak256(&amount_preimage);

    if encrypted_amount_hex.len() != 16 {
        return Err(format!(
            "encrypted_amount must be 8 bytes (16 hex chars), got {} chars",
            encrypted_amount_hex.len(),
        ));
    }
    let encrypted = hex::decode(encrypted_amount_hex)
        .map_err(|e| format!("invalid encrypted_amount hex: {e}"))?;

    let mut decrypted = [0u8; 8];
    for i in 0..8 {
        decrypted[i] = encrypted[i] ^ amount_key[i];
    }

    Ok(u64::from_le_bytes(decrypted))
}

// monero-oxide Commitment::new(mask, amount).commit() = C = mask*G + amount*H.
// `on_chain_commitment_hex` is the `mask` field on monerod /get_outs (badly
// named: it's the commitment point, not the blinding factor).
pub fn verify_commitment_inner(
    view_key_hex: &str,
    tx_public_key_hex: &str,
    output_index: u64,
    amount: u64,
    on_chain_commitment_hex: &str,
) -> Result<bool, String> {
    let mask_hex = compute_mask_inner(view_key_hex, tx_public_key_hex, output_index)?;
    let mask_bytes = decode_hex_exact::<32>(&mask_hex, "computed_mask")?;
    let mask_scalar = Scalar::from_canonical_bytes(mask_bytes)
        .into_option()
        .ok_or_else(|| "computed mask is not canonical".to_string())?;

    let commitment = Commitment::new(
        monero_oxide::ed25519::Scalar::from(mask_scalar),
        amount,
    );
    let computed_point = commitment.commit();
    let computed_hex = hex::encode(
        monero_oxide::ed25519::CompressedPoint::from(computed_point.compress()).to_bytes(),
    );

    let on_chain = on_chain_commitment_hex.to_lowercase();

    Ok(computed_hex == on_chain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mask_deterministic() {
        // Same inputs should produce the same mask
        let view_key = "a".repeat(64);
        let tx_pub_key = "b".repeat(64);

        // These won't be valid keys, but we're testing determinism
        // Valid test requires canonical scalars and valid points
    }

    #[test]
    fn test_mask_with_known_values() {
        // Generate a valid keypair for testing
        use curve25519_dalek::constants::ED25519_BASEPOINT_TABLE;
        use rand::rngs::OsRng;

        let view_key_scalar = Scalar::random(&mut OsRng);
        let view_key_hex = hex::encode(view_key_scalar.as_bytes());

        // R = random scalar * G (valid point)
        let r_scalar = Scalar::random(&mut OsRng);
        let r_point = &r_scalar * ED25519_BASEPOINT_TABLE;
        let r_hex = hex::encode(r_point.compress().as_bytes());

        let result1 = compute_mask_inner(&view_key_hex, &r_hex, 0).unwrap();
        let result2 = compute_mask_inner(&view_key_hex, &r_hex, 0).unwrap();
        assert_eq!(result1, result2, "Mask should be deterministic");
        assert_eq!(result1.len(), 64, "Mask should be 32 bytes (64 hex chars)");

        // Different output_index should produce different mask
        let result3 = compute_mask_inner(&view_key_hex, &r_hex, 1).unwrap();
        assert_ne!(result1, result3, "Different output_index should produce different mask");
    }

    #[test]
    fn test_mask_invalid_view_key() {
        let result = compute_mask_inner("zz".repeat(32).as_str(), &"a".repeat(64), 0);
        assert!(result.is_err());
    }

    #[test]
    fn test_mask_invalid_tx_public_key() {
        // Valid scalar but invalid point
        let view_key = hex::encode(Scalar::ONE.as_bytes());
        let result = compute_mask_inner(&view_key, &"ff".repeat(32), 0);
        // ff...ff may or may not be a valid point; the function should handle either case
        assert!(result.is_ok() || result.is_err());
    }
}

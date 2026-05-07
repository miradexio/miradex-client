use curve25519_dalek::constants::ED25519_BASEPOINT_TABLE;
use zeroize::Zeroizing;

use crate::monero::helpers::decode_hex_exact;
use crate::monero::types::{KeyImageResult, StructuredOutput};

// Per output:
//   D = 8 * view_key * R
//   s = Hs(D || n)
//   x = s + spend_key
//   I = x * Hp(P)
// Also returns a signature proving correct derivation.
pub fn derive_key_images_inner(
    outputs: &[StructuredOutput],
    view_key_bytes: &[u8; 32],
    spend_key_bytes: &[u8; 32],
) -> Result<Vec<KeyImageResult>, String> {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    use curve25519_dalek::scalar::Scalar;

    let view_key = Scalar::from_canonical_bytes(*view_key_bytes)
        .into_option()
        .ok_or_else(|| "view_key is not a canonical ed25519 scalar".to_string())?;
    let spend_key = Scalar::from_canonical_bytes(*spend_key_bytes)
        .into_option()
        .ok_or_else(|| "spend_key is not a canonical ed25519 scalar".to_string())?;

    let mut results = Vec::with_capacity(outputs.len());

    for output in outputs {
        let p_bytes = decode_hex_exact::<32>(&output.one_time_public_key, "one_time_public_key")?;
        let p_compressed = CompressedEdwardsY(p_bytes);
        let p_point = p_compressed
            .decompress()
            .ok_or_else(|| "one_time_public_key is not a valid ed25519 point".to_string())?;

        let r_bytes = decode_hex_exact::<32>(&output.tx_public_key, "tx_public_key")?;
        let r_compressed = CompressedEdwardsY(r_bytes);
        let r_point = r_compressed
            .decompress()
            .ok_or_else(|| "tx_public_key is not a valid ed25519 point".to_string())?;

        let key_derivation = (view_key * r_point).mul_by_cofactor();
        let derivation_scalar = derivation_to_scalar(&key_derivation, output.output_index);
        let one_time_private_key = Zeroizing::new(derivation_scalar + spend_key);

        // x*G must equal P; otherwise tx_public_key / output_index / keys are wrong.
        let derived_pub: curve25519_dalek::edwards::EdwardsPoint =
            &*one_time_private_key * ED25519_BASEPOINT_TABLE;
        if derived_pub.compress() != p_compressed {
            return Err(format!(
                "Key derivation mismatch: x*G != P. \
                 This means tx_public_key or output_index is wrong. \
                 derived_pub={}, expected_P={}, output_index={}, \
                 tx_public_key={}",
                hex::encode(derived_pub.compress().as_bytes()),
                hex::encode(p_compressed.as_bytes()),
                output.output_index,
                &output.tx_public_key,
            ));
        }

        let hp = hash_to_point(&p_point);
        let key_image = *one_time_private_key * hp;

        let (sig_c, sig_r) =
            generate_key_image_signature(&key_image, &p_point, &one_time_private_key);

        results.push(KeyImageResult {
            key_image: hex::encode(key_image.compress().to_bytes()),
            signature: hex::encode([sig_c.to_bytes(), sig_r.to_bytes()].concat()),
        });
    }

    Ok(results)
}

// Hs(D || varint(n)) — scalar derived from a key derivation + output index.
pub fn derivation_to_scalar(
    derivation: &curve25519_dalek::edwards::EdwardsPoint,
    output_index: u64,
) -> curve25519_dalek::scalar::Scalar {
    let mut data = Vec::with_capacity(32 + 10);
    data.extend_from_slice(derivation.compress().as_bytes());

    let mut varint_buf = [0u8; 10];
    let varint_len = encode_varint(output_index, &mut varint_buf);
    data.extend_from_slice(&varint_buf[..varint_len]);

    let hash = monero_oxide::primitives::keccak256(&data);
    curve25519_dalek::scalar::Scalar::from_bytes_mod_order(hash)
}

// Hp(P): keccak256(P) -> Elligator 2 -> *cofactor. biased_hash takes the
// raw compressed bytes and does the keccak internally — do NOT pre-hash.
fn hash_to_point(
    point: &curve25519_dalek::edwards::EdwardsPoint,
) -> curve25519_dalek::edwards::EdwardsPoint {
    let compressed_bytes: [u8; 32] = point.compress().to_bytes();
    monero_oxide::ed25519::Point::biased_hash(compressed_bytes).into()
}

// wallet2 generate_ring_signature with prefix_hash = key_image (used in
// export_key_images). Preimage = key_image || k*G || k*Hp(P) (96 bytes).
//   k = random nonce
//   c = Hs(preimage)
//   r = k - c*x
fn generate_key_image_signature(
    key_image: &curve25519_dalek::edwards::EdwardsPoint,
    public_key: &curve25519_dalek::edwards::EdwardsPoint,
    private_key: &curve25519_dalek::scalar::Scalar,
) -> (curve25519_dalek::scalar::Scalar, curve25519_dalek::scalar::Scalar) {
    use curve25519_dalek::constants::ED25519_BASEPOINT_TABLE;
    use rand::rngs::OsRng;

    let k = curve25519_dalek::scalar::Scalar::random(&mut OsRng);
    let hp = hash_to_point(public_key);

    let k_g: curve25519_dalek::edwards::EdwardsPoint = &k * ED25519_BASEPOINT_TABLE;
    let k_hp = k * hp;

    let mut data = Vec::with_capacity(96);
    data.extend_from_slice(key_image.compress().as_bytes());
    data.extend_from_slice(k_g.compress().as_bytes());
    data.extend_from_slice(k_hp.compress().as_bytes());

    let c_hash = monero_oxide::primitives::keccak256(&data);
    let c = curve25519_dalek::scalar::Scalar::from_bytes_mod_order(c_hash);

    // wallet2 sc_mulsub(&sig.r, &sig.c, &sec, &k).
    let r = k - c * private_key;

    (c, r)
}

// Monero varint = unsigned LEB128 (7 bits per byte, MSB = continuation).
fn encode_varint(mut value: u64, buf: &mut [u8; 10]) -> usize {
    let mut i = 0;
    loop {
        if value < 0x80 {
            buf[i] = value as u8;
            return i + 1;
        }
        buf[i] = (value as u8 & 0x7f) | 0x80;
        value >>= 7;
        i += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_varint_zero() {
        let mut buf = [0u8; 10];
        let len = encode_varint(0, &mut buf);
        assert_eq!(len, 1);
        assert_eq!(buf[0], 0);
    }

    #[test]
    fn test_encode_varint_small() {
        let mut buf = [0u8; 10];
        let len = encode_varint(42, &mut buf);
        assert_eq!(len, 1);
        assert_eq!(buf[0], 42);
    }

    #[test]
    fn test_encode_varint_large() {
        let mut buf = [0u8; 10];
        let len = encode_varint(300, &mut buf);
        assert_eq!(len, 2);
        assert_eq!(buf[0], 0xac); // 300 & 0x7f | 0x80 = 0x2c | 0x80
        assert_eq!(buf[1], 0x02); // 300 >> 7 = 2
    }

    #[test]
    fn test_key_image_derivation_consistency() {
        use curve25519_dalek::constants::ED25519_BASEPOINT_TABLE;
        use curve25519_dalek::scalar::Scalar;

        // Generate a random keypair
        let spend_key = Scalar::random(&mut rand::rngs::OsRng);
        let view_key = Scalar::random(&mut rand::rngs::OsRng);
        let spend_pub = &spend_key * ED25519_BASEPOINT_TABLE;
        let view_pub = &view_key * ED25519_BASEPOINT_TABLE;

        // Generate a fake "transaction" — random tx key r, output at index 0
        let tx_secret = Scalar::random(&mut rand::rngs::OsRng);
        let tx_public = &tx_secret * ED25519_BASEPOINT_TABLE;

        // Compute the expected one-time public key: P = Hs(8*r*view_pub || 0)*G + spend_pub
        let key_derivation = (tx_secret * view_pub).mul_by_cofactor();
        let derivation_scalar = derivation_to_scalar(&key_derivation, 0);
        let one_time_pub = &derivation_scalar * ED25519_BASEPOINT_TABLE + spend_pub;

        let output = StructuredOutput {
            one_time_public_key: hex::encode(one_time_pub.compress().to_bytes()),
            tx_public_key: hex::encode(tx_public.compress().to_bytes()),
            output_index: 0,
            global_output_index: 0,
            amount: 1_000_000_000_000,
            rct_mask: hex::encode([0u8; 32]),
            additional_tx_keys: vec![],
            subaddr_major: 0,
            subaddr_minor: 0,
        };

        let results = derive_key_images_inner(
            &[output],
            &view_key.to_bytes(),
            &spend_key.to_bytes(),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].key_image.len(), 64); // 32 bytes = 64 hex chars

        // Key image should be deterministic: same inputs → same key image
        let results2 = derive_key_images_inner(
            &[StructuredOutput {
                one_time_public_key: hex::encode(one_time_pub.compress().to_bytes()),
                tx_public_key: hex::encode(tx_public.compress().to_bytes()),
                output_index: 0,
                global_output_index: 0,
                amount: 1_000_000_000_000,
                rct_mask: hex::encode([0u8; 32]),
                additional_tx_keys: vec![],
                subaddr_major: 0,
                subaddr_minor: 0,
            }],
            &view_key.to_bytes(),
            &spend_key.to_bytes(),
        )
        .unwrap();

        assert_eq!(results[0].key_image, results2[0].key_image);
        // Signatures differ (random nonce) but key images must match
    }
}

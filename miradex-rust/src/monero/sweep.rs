use std::io::Cursor;

use zeroize::Zeroizing;

use crate::monero::helpers::{decode_hex, decode_hex_exact};
use crate::monero::types::{SweepConstructionData, SweepInput};

// monero-oxide intermittently produces invalid CLSAGs for certain random
// outgoing_view_key / nonce combinations. Local verify catches it pre-broadcast;
// re-sign with fresh randomness fixes it.
const MAX_SIGN_ATTEMPTS: usize = 10;

/// Sign a sweep tx via monero-oxide-wallet's SignableTransaction. Local CLSAG
/// verify with re-sign on invalid (no network calls).
pub fn sign_sweep_tx_inner(
    construction_data: &SweepConstructionData,
    spend_key_bytes: &[u8; 32],
    view_key_bytes: &[u8; 32],
) -> Result<Vec<u8>, String> {
    use monero_oxide::ed25519::{Scalar as OxideScalar, CompressedPoint};
    use monero_oxide::ringct::RctType;
    use monero_oxide_wallet::send::{Change, SignableTransaction};
    use monero_oxide_wallet::interface::FeeRate;
    use rand::rngs::OsRng;

    if construction_data.inputs.is_empty() {
        return Err("no inputs in construction data".to_string());
    }

    // curve25519-dalek Scalar -> monero-oxide Scalar.
    let dalek_spend = curve25519_dalek::scalar::Scalar::from_canonical_bytes(*spend_key_bytes)
        .into_option()
        .ok_or_else(|| "spend_key is not a canonical ed25519 scalar".to_string())?;
    let spend_key = Zeroizing::new(OxideScalar::from(dalek_spend));

    let rct_type = match construction_data.rct_type {
        5 => RctType::ClsagBulletproof,
        6 => RctType::ClsagBulletproofPlus,
        other => return Err(format!("unsupported rct_type: {other} (expected 5 or 6)")),
    };

    let mut inputs = Vec::with_capacity(construction_data.inputs.len());
    for (i, sweep_input) in construction_data.inputs.iter().enumerate() {
        let owd = build_output_with_decoys(sweep_input, view_key_bytes, i)?;
        inputs.push(owd);
    }

    let dest_address =
        monero_address::MoneroAddress::from_str_with_unchecked_network(
            &construction_data.destination.address,
        )
        .map_err(|e| format!("invalid destination address: {e}"))?;

    // Monero requires >=2 outputs; set change to the destination so the
    // sweep produces a 2-output tx with the leftover going to the same place.
    let change = Change::fingerprintable(Some(dest_address));

    let fee_per_weight = std::cmp::max(construction_data.fee / 2000, 1);
    let fee_rate = FeeRate::new(fee_per_weight, 1)
        .ok_or_else(|| "failed to create FeeRate".to_string())?;

    let data = if construction_data.tx_extra.is_empty() {
        vec![]
    } else {
        let extra_bytes = decode_hex(&construction_data.tx_extra, "tx_extra")?;
        vec![extra_bytes]
    };

    // Ring for local CLSAG verify, extracted from decoys: [key, commitment] each.
    let verification_rings: Vec<Vec<[CompressedPoint; 2]>> = inputs
        .iter()
        .map(|owd| {
            owd.decoys()
                .ring()
                .iter()
                .map(|[key, commitment]| [key.compress(), commitment.compress()])
                .collect()
        })
        .collect();

    // Local verify + retry on invalid: dodges the monero-oxide bug where
    // some random values produce invalid proofs.
    for attempt in 0..MAX_SIGN_ATTEMPTS {
        let mut outgoing_view_key = Zeroizing::new([0u8; 32]);
        rand::RngCore::fill_bytes(&mut OsRng, outgoing_view_key.as_mut());

        let signable_tx = SignableTransaction::new(
            rct_type,
            outgoing_view_key,
            inputs.clone(),
            vec![(dest_address, construction_data.destination.amount)],
            change.clone(),
            data.clone(),
            fee_rate,
        )
        .map_err(|e| format!("SignableTransaction::new failed: {e}"))?;

        let signed_tx = signable_tx
            .sign(&mut OsRng, &spend_key)
            .map_err(|e| format!("signing failed: {e}"))?;

        match verify_signed_tx(&signed_tx, &verification_rings) {
            Ok(()) => return Ok(signed_tx.serialize()),
            Err(reason) => {
                if attempt == MAX_SIGN_ATTEMPTS - 1 {
                    return Err(format!(
                        "signed transaction failed local verification after {MAX_SIGN_ATTEMPTS} attempts: {reason}"
                    ));
                }
            }
        }
    }

    Err("unreachable: sign loop exhausted".to_string())
}

// Local CLSAG verify: turns an intermittent broadcast failure into a fast
// local retry.
fn verify_signed_tx(
    tx: &monero_oxide::transaction::Transaction,
    rings: &[Vec<[monero_oxide::ed25519::CompressedPoint; 2]>],
) -> Result<(), String> {
    use monero_oxide::ringct::RctPrunable;
    use monero_oxide::transaction::{Transaction, Input};

    let msg_hash = tx.signature_hash()
        .ok_or_else(|| "no signature hash on signed tx".to_string())?;

    let key_images: Vec<_> = match tx {
        Transaction::V2 { prefix, .. } => prefix.inputs.iter().map(|input| {
            match input {
                Input::ToKey { key_image, .. } => Ok(*key_image),
                Input::Gen(_) => Err("coinbase input in sweep tx".to_string()),
            }
        }).collect::<Result<Vec<_>, _>>()?,
        _ => return Err("not a v2 transaction".to_string()),
    };

    let (clsags, pseudo_outs) = match tx {
        Transaction::V2 { proofs: Some(proofs), .. } => match &proofs.prunable {
            RctPrunable::Clsag { clsags, pseudo_outs, .. } => (clsags, pseudo_outs),
            _ => return Err("not a CLSAG transaction".to_string()),
        },
        _ => return Err("no RCT proofs".to_string()),
    };

    if clsags.len() != rings.len() || clsags.len() != key_images.len() || clsags.len() != pseudo_outs.len() {
        return Err(format!(
            "length mismatch: clsags={}, rings={}, key_images={}, pseudo_outs={}",
            clsags.len(), rings.len(), key_images.len(), pseudo_outs.len(),
        ));
    }

    for (i, clsag) in clsags.iter().enumerate() {
        clsag.verify(
            rings[i].clone(),
            &key_images[i],
            &pseudo_outs[i],
            &msg_hash,
        ).map_err(|e| format!("CLSAG verification failed for input {i}: {e}"))?;
    }

    Ok(())
}

// OutputWithDecoys wraps OutputData (pub(crate)) + Decoys; we can't construct
// OutputData from outside the crate, so write its binary form and feed it to
// OutputWithDecoys::read().
//
// Binary layout:
//   OutputData
//     key        32B CompressedPoint
//     key_offset 32B Scalar (LE canonical)
//     commitment 32B mask Scalar + 8B amount u64 LE
//   Decoys
//     offsets    varint-prefixed Vec<u64> (each varint)
//     signer_index u8
//     ring       raw vec (no length prefix; Decoys::read uses offsets.len())
//                each element: 32B key + 32B commitment (CompressedPoints)
fn build_output_with_decoys(
    input: &SweepInput,
    view_key_bytes: &[u8; 32],
    input_index: usize,
) -> Result<monero_oxide_wallet::OutputWithDecoys, String> {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    use curve25519_dalek::scalar::Scalar;

    let label = |field: &str| format!("inputs[{input_index}].{field}");

    // OutputData.key
    let p_bytes =
        decode_hex_exact::<32>(&input.real_output.one_time_public_key, &label("one_time_public_key"))?;

    // tx public key R (needed to derive key_offset).
    let r_bytes =
        decode_hex_exact::<32>(&input.real_output.tx_public_key, &label("tx_public_key"))?;
    let r_compressed = CompressedEdwardsY(r_bytes);
    let r_point = r_compressed
        .decompress()
        .ok_or_else(|| format!("{}: not a valid ed25519 point", label("tx_public_key")))?;

    // key_offset = Hs(8 * view_key * R || output_index); satisfies
    // (spend_key + key_offset) * G = P.
    let view_key = Scalar::from_canonical_bytes(*view_key_bytes)
        .into_option()
        .ok_or_else(|| "view_key is not a canonical ed25519 scalar".to_string())?;
    let key_derivation = (view_key * r_point).mul_by_cofactor();
    let key_offset = crate::monero::key_images::derivation_to_scalar(&key_derivation, input.real_output.output_index);

    let mask_bytes =
        decode_hex_exact::<32>(&input.real_output.rct_mask, &label("rct_mask"))?;

    if input.ring_members.is_empty() {
        return Err(format!("{}: ring_members is empty", label("ring_members")));
    }

    let mut ring_keys: Vec<([u8; 32], [u8; 32])> = Vec::with_capacity(input.ring_members.len());
    for (j, member) in input.ring_members.iter().enumerate() {
        let pk = decode_hex_exact::<32>(
            &member.public_key,
            &format!("inputs[{input_index}].ring_members[{j}].public_key"),
        )?;
        let comm = decode_hex_exact::<32>(
            &member.commitment,
            &format!("inputs[{input_index}].ring_members[{j}].commitment"),
        )?;
        ring_keys.push((pk, comm));
    }

    let relative_offsets = absolute_to_relative_offsets(&input.key_offsets)?;

    if input.real_output_index >= input.ring_members.len() {
        return Err(format!(
            "{}: real_output_index {} out of range (ring has {} members)",
            label("real_output_index"),
            input.real_output_index,
            input.ring_members.len(),
        ));
    }

    // Serialise OutputData + Decoys (layout in the fn doc), then deserialise.
    let mut buf = Vec::with_capacity(2048);

    buf.extend_from_slice(&p_bytes);
    buf.extend_from_slice(&key_offset.to_bytes());
    buf.extend_from_slice(&mask_bytes);
    buf.extend_from_slice(&input.real_output.amount.to_le_bytes());

    write_varint(&mut buf, relative_offsets.len() as u64);
    for offset in &relative_offsets {
        write_varint(&mut buf, *offset);
    }

    buf.push(input.real_output_index as u8);

    for (pk, comm) in &ring_keys {
        buf.extend_from_slice(pk);
        buf.extend_from_slice(comm);
    }

    let mut cursor = Cursor::new(&buf);
    monero_oxide_wallet::OutputWithDecoys::read(&mut cursor)
        .map_err(|e| format!("inputs[{input_index}] OutputWithDecoys deserialization failed: {e}"))
}

// Monero ring positions: [abs_0, abs_1 - abs_0, abs_2 - abs_1, ...].
// `absolute` is sorted internally before differencing.
fn absolute_to_relative_offsets(absolute: &[u64]) -> Result<Vec<u64>, String> {
    if absolute.is_empty() {
        return Err("key_offsets is empty".to_string());
    }

    let mut sorted = absolute.to_vec();
    sorted.sort_unstable();

    let mut relative = Vec::with_capacity(sorted.len());
    relative.push(sorted[0]);
    for i in 1..sorted.len() {
        let diff = sorted[i].checked_sub(sorted[i - 1]).ok_or_else(|| {
            format!("key_offsets are not strictly increasing at index {i}")
        })?;
        if diff == 0 {
            return Err(format!("duplicate key_offset at index {i}"));
        }
        relative.push(diff);
    }

    Ok(relative)
}

// Monero varint = unsigned LEB128.
fn write_varint(buf: &mut Vec<u8>, mut value: u64) {
    loop {
        if value < 0x80 {
            buf.push(value as u8);
            return;
        }
        buf.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monero::types::{
        RingMember, StructuredOutput, SweepConstructionData, SweepDestination, SweepInput,
    };

    #[test]
    fn test_absolute_to_relative_offsets() {
        let abs = vec![100, 200, 350, 500];
        let rel = absolute_to_relative_offsets(&abs).unwrap();
        assert_eq!(rel, vec![100, 100, 150, 150]);
    }

    #[test]
    fn test_absolute_to_relative_offsets_unsorted() {
        // Should sort internally
        let abs = vec![500, 100, 350, 200];
        let rel = absolute_to_relative_offsets(&abs).unwrap();
        assert_eq!(rel, vec![100, 100, 150, 150]);
    }

    #[test]
    fn test_absolute_to_relative_offsets_empty() {
        let result = absolute_to_relative_offsets(&[]);
        assert!(result.is_err());
    }

    #[test]
    fn test_absolute_to_relative_offsets_duplicates() {
        let abs = vec![100, 100, 200];
        let result = absolute_to_relative_offsets(&abs);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("duplicate"));
    }

    #[test]
    fn test_write_varint_small() {
        let mut buf = Vec::new();
        write_varint(&mut buf, 42);
        assert_eq!(buf, vec![42]);
    }

    #[test]
    fn test_write_varint_large() {
        let mut buf = Vec::new();
        write_varint(&mut buf, 300);
        assert_eq!(buf, vec![0xac, 0x02]);
    }

    #[test]
    fn test_sign_empty_inputs_returns_error() {
        let data = SweepConstructionData {
            inputs: vec![],
            destination: SweepDestination {
                address: "5fake".to_string(),
                amount: 0,
            },
            fee: 0,
            tx_extra: String::new(),
            rct_type: 6,
        };
        let result = sign_sweep_tx_inner(&data, &[0u8; 32], &[0u8; 32]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no inputs"));
    }

    #[test]
    fn test_build_output_with_decoys_roundtrip() {
        // Generate a valid keypair to construct a realistic-looking input
        use curve25519_dalek::constants::ED25519_BASEPOINT_TABLE;
        use curve25519_dalek::scalar::Scalar;

        let spend_key = Scalar::random(&mut rand::rngs::OsRng);
        let view_key = Scalar::random(&mut rand::rngs::OsRng);

        // Simulate a transaction output
        let tx_secret = Scalar::random(&mut rand::rngs::OsRng);
        let tx_public = &tx_secret * ED25519_BASEPOINT_TABLE;
        let spend_pub = &spend_key * ED25519_BASEPOINT_TABLE;
        let view_pub = &view_key * ED25519_BASEPOINT_TABLE;

        // Compute one-time public key: P = Hs(8*r*V || 0)*G + B
        let key_deriv = (tx_secret * view_pub).mul_by_cofactor();
        let offset = crate::monero::key_images::derivation_to_scalar(&key_deriv, 0);
        let one_time_pub = &offset * ED25519_BASEPOINT_TABLE + spend_pub;

        // Create a fake ring with 16 members (the real output at index 5)
        let real_index = 5usize;
        let mut ring_members = Vec::new();
        let mut key_offsets = Vec::new();
        for i in 0..16 {
            if i == real_index {
                ring_members.push(RingMember {
                    public_key: hex::encode(one_time_pub.compress().to_bytes()),
                    commitment: hex::encode(one_time_pub.compress().to_bytes()), // fake commitment
                });
                key_offsets.push(1000 + (i as u64) * 100);
            } else {
                // Random decoy
                let random_point = &Scalar::random(&mut rand::rngs::OsRng) * ED25519_BASEPOINT_TABLE;
                ring_members.push(RingMember {
                    public_key: hex::encode(random_point.compress().to_bytes()),
                    commitment: hex::encode(random_point.compress().to_bytes()),
                });
                key_offsets.push(1000 + (i as u64) * 100);
            }
        }

        // Create a random mask (not a real commitment mask, just for testing serialization)
        let mask = Scalar::random(&mut rand::rngs::OsRng);

        let sweep_input = SweepInput {
            ring_members,
            real_output_index: real_index,
            real_output: StructuredOutput {
                one_time_public_key: hex::encode(one_time_pub.compress().to_bytes()),
                tx_public_key: hex::encode(tx_public.compress().to_bytes()),
                output_index: 0,
                global_output_index: key_offsets[real_index],
                amount: 1_000_000_000_000,
                rct_mask: hex::encode(mask.to_bytes()),
                additional_tx_keys: vec![],
                subaddr_major: 0,
                subaddr_minor: 0,
            },
            key_offsets,
        };

        // This should successfully deserialize into an OutputWithDecoys
        let result = build_output_with_decoys(&sweep_input, &view_key.to_bytes(), 0);
        assert!(result.is_ok(), "build_output_with_decoys failed: {:?}", result.err());

        let owd = result.unwrap();
        // Verify the key matches our one-time public key
        let owd_key_bytes = owd.key().compress().to_bytes();
        assert_eq!(
            hex::encode(owd_key_bytes),
            hex::encode(one_time_pub.compress().to_bytes()),
        );
    }
}

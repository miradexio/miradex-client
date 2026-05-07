//! BTC/XMR atomic-swap crypto primitives consumed by @miradexio/client:
//! keygen + DLEQ, ECDSA + adaptor sigs, Monero scanning + CLSAG signing.
//! Public symbols all go through `#[wasm_bindgen]`.

#![deny(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used)]

use wasm_bindgen::prelude::*;

pub mod util;
pub mod keygen;
pub mod ecdsa;
pub mod monero;

#[cfg(all(feature = "console-errors", not(test)))]
#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

/// Used by consumers to detect pin drift.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

/// Generate a fresh BTC/XMR swap key bundle with DLEQ proof.
#[wasm_bindgen]
pub fn generate_client_keys() -> core::result::Result<String, JsValue> {
    keygen::generate::generate_client_keys().map_err(Into::into)
}

/// Derive a BTC/XMR key bundle from caller-supplied seed material.
#[wasm_bindgen]
pub fn generate_client_keys_from_seed(
    s_b_hex: &str,
    v_b_hex: &str,
    b_hex: &str,
) -> core::result::Result<String, JsValue> {
    keygen::generate::from_seed(s_b_hex, v_b_hex, b_hex).map_err(Into::into)
}

/// Verify a DLEQ proof binding a secp256k1 key to an ed25519 key.
#[wasm_bindgen]
pub fn verify_dleq_proof(
    s_bitcoin_hex: &str,
    s_monero_hex: &str,
    proof_hex: &str,
) -> core::result::Result<bool, JsValue> {
    keygen::dleq::verify(s_bitcoin_hex, s_monero_hex, proof_hex).map_err(Into::into)
}

/// Sign a 32-byte digest with a secp256k1 secret key. Returns 64-byte compact.
#[wasm_bindgen]
pub fn sign_digest(b_hex: &str, digest_hex: &str) -> core::result::Result<String, JsValue> {
    ecdsa::sign::sign_digest(b_hex, digest_hex).map_err(Into::into)
}

/// Produce an adaptor-encrypted signature under the given encryption point.
#[wasm_bindgen]
pub fn encsign_digest(
    b_hex: &str,
    encryption_key_hex: &str,
    digest_hex: &str,
) -> core::result::Result<String, JsValue> {
    ecdsa::encsign::encsign_digest(b_hex, encryption_key_hex, digest_hex).map_err(Into::into)
}

/// Decrypt an adaptor-encrypted signature with the decryption scalar.
#[wasm_bindgen]
pub fn decrypt_signature(
    scalar_hex: &str,
    encsig_hex: &str,
) -> core::result::Result<String, JsValue> {
    ecdsa::decrypt::decrypt_signature(scalar_hex, encsig_hex).map_err(Into::into)
}

/// Verify an adaptor-encrypted signature is valid for the triple.
#[wasm_bindgen]
pub fn verify_encsig(
    verification_key_hex: &str,
    encryption_key_hex: &str,
    digest_hex: &str,
    encsig_hex: &str,
) -> core::result::Result<bool, JsValue> {
    ecdsa::verify::verify_encsig(verification_key_hex, encryption_key_hex, digest_hex, encsig_hex)
        .map_err(Into::into)
}

/// Recover the adaptor scalar given the decrypted signature and the encsig.
#[wasm_bindgen]
pub fn recover_adaptor_scalar(
    sig_hex: &str,
    encsig_hex: &str,
    encryption_key_hex: &str,
) -> core::result::Result<String, JsValue> {
    ecdsa::recover::recover_adaptor_scalar(sig_hex, encsig_hex, encryption_key_hex)
        .map_err(Into::into)
}

/// Derive key images for a set of outputs using the combined spend key.
#[wasm_bindgen]
pub fn derive_key_images(
    outputs_json: &str,
    view_key_hex: &str,
    spend_key_hex: &str,
) -> core::result::Result<String, JsValue> {
    use util::decode::decode_hex_exact;
    use util::errors::MiradexWasmError;

    let outputs: Vec<monero::types::StructuredOutput> = serde_json::from_str(outputs_json)
        .map_err(|e| MiradexWasmError::MoneroScan(format!("outputs JSON parse: {e}")))?;

    let view_key_bytes = decode_hex_exact::<32>(view_key_hex, "view_key")?;
    let spend_key_bytes = decode_hex_exact::<32>(spend_key_hex, "spend_key")?;

    let results =
        monero::key_images::derive_key_images_inner(&outputs, &view_key_bytes, &spend_key_bytes)
            .map_err(MiradexWasmError::MoneroScan)?;

    serde_json::to_string(&results)
        .map_err(|e| MiradexWasmError::Serialize(format!("key images: {e}")))
        .map_err(Into::into)
}

/// CLSAG ring decoys via wallet2's gamma distribution. JSON input may
/// override `unlock_window_blocks` (default DEFAULT_LOCK_WINDOW=10);
/// use 60 (coinbase lock) on coinbase-only chains (regtest, conservative).
#[wasm_bindgen]
pub fn select_decoys(
    real_output_index: u64,
    cumulative_distribution_json: &str,
    ring_size: u16,
) -> core::result::Result<String, JsValue> {
    use util::errors::MiradexWasmError;

    let input: monero::decoys::DecoySelectionInput =
        serde_json::from_str(cumulative_distribution_json)
            .map_err(|e| MiradexWasmError::MoneroScan(format!("distribution JSON parse: {e}")))?;

    let unlock_window = input
        .unlock_window_blocks
        .unwrap_or(monero::decoys::DEFAULT_LOCK_WINDOW);

    let result = monero::decoys::select_decoys_inner(
        real_output_index,
        &input.distribution,
        ring_size,
        unlock_window,
    )
    .map_err(MiradexWasmError::MoneroScan)?;

    serde_json::to_string(&result)
        .map_err(|e| MiradexWasmError::Serialize(format!("decoys: {e}")))
        .map_err(Into::into)
}

/// Sign a Monero sweep transaction.
#[wasm_bindgen]
pub fn sign_sweep_tx(
    construction_data_json: &str,
    spend_key_hex: &str,
    view_key_hex: &str,
) -> core::result::Result<String, JsValue> {
    use util::decode::decode_hex_exact;
    use util::errors::MiradexWasmError;

    let construction_data: monero::types::SweepConstructionData =
        serde_json::from_str(construction_data_json)
            .map_err(|e| MiradexWasmError::ClsagSign(format!("construction_data JSON: {e}")))?;

    let spend_key_bytes = decode_hex_exact::<32>(spend_key_hex, "spend_key")?;
    let view_key_bytes = decode_hex_exact::<32>(view_key_hex, "view_key")?;

    let tx_bytes = monero::sweep::sign_sweep_tx_inner(
        &construction_data,
        &spend_key_bytes,
        &view_key_bytes,
    )
    .map_err(MiradexWasmError::ClsagSign)?;

    Ok(hex::encode(tx_bytes))
}

/// Compute the commitment mask for an output.
#[wasm_bindgen]
pub fn compute_commitment_mask(
    view_key_hex: &str,
    tx_public_key_hex: &str,
    output_index: u64,
) -> core::result::Result<String, JsValue> {
    use util::errors::MiradexWasmError;
    monero::commitment::compute_mask_inner(view_key_hex, tx_public_key_hex, output_index)
        .map_err(MiradexWasmError::MoneroScan)
        .map_err(Into::into)
}

/// Verify a commitment matches expected mask + amount.
#[wasm_bindgen]
pub fn verify_commitment(
    view_key_hex: &str,
    tx_public_key_hex: &str,
    output_index: u64,
    amount: u64,
    on_chain_commitment_hex: &str,
) -> core::result::Result<bool, JsValue> {
    use util::errors::MiradexWasmError;
    monero::commitment::verify_commitment_inner(
        view_key_hex,
        tx_public_key_hex,
        output_index,
        amount,
        on_chain_commitment_hex,
    )
    .map_err(MiradexWasmError::MoneroScan)
    .map_err(Into::into)
}

/// Decrypt a RingCT amount for an output.
#[wasm_bindgen]
pub fn decrypt_amount(
    view_key_hex: &str,
    tx_public_key_hex: &str,
    output_index: u64,
    encrypted_amount_hex: &str,
) -> core::result::Result<u64, JsValue> {
    use util::errors::MiradexWasmError;
    monero::commitment::decrypt_amount_inner(
        view_key_hex,
        tx_public_key_hex,
        output_index,
        encrypted_amount_hex,
    )
    .map_err(MiradexWasmError::AmountDecrypt)
    .map_err(Into::into)
}

/// Convert a secp256k1 scalar (big-endian) to an ed25519 scalar (little-endian).
#[wasm_bindgen]
pub fn secp256k1_scalar_to_ed25519(
    secp_scalar_hex: &str,
) -> core::result::Result<String, JsValue> {
    util::scalar_convert::secp_to_ed(secp_scalar_hex).map_err(Into::into)
}

/// Add two ed25519 scalars modulo the group order.
#[wasm_bindgen]
pub fn ed25519_scalar_add(
    scalar_a_hex: &str,
    scalar_b_hex: &str,
) -> core::result::Result<String, JsValue> {
    util::scalar_convert::ed_add(scalar_a_hex, scalar_b_hex).map_err(Into::into)
}

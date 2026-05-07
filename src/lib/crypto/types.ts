// Compiled miradex-rust module after init(). Mirrors the
// #[wasm_bindgen] exports in ../../../miradex-rust/src/lib.rs.
export interface WasmModule {
  // Keygen
  readonly generate_client_keys: () => string;
  readonly generate_client_keys_from_seed: (
    s_b_hex: string,
    v_b_hex: string,
    b_hex: string,
  ) => string;
  readonly verify_dleq_proof: (
    s_bitcoin_hex: string,
    s_monero_hex: string,
    proof_hex: string,
  ) => boolean;

  // ECDSA + adaptor
  readonly sign_digest: (b_hex: string, digest_hex: string) => string;
  readonly encsign_digest: (
    b_hex: string,
    encryption_key_hex: string,
    digest_hex: string,
  ) => string;
  readonly decrypt_signature: (scalar_hex: string, encsig_hex: string) => string;
  readonly verify_encsig: (
    verification_key_hex: string,
    encryption_key_hex: string,
    digest_hex: string,
    encsig_hex: string,
  ) => boolean;
  readonly recover_adaptor_scalar: (
    sig_hex: string,
    encsig_hex: string,
    encryption_key_hex: string,
  ) => string;

  // Monero
  readonly derive_key_images: (
    outputs_json: string,
    view_key_hex: string,
    spend_key_hex: string,
  ) => string;
  readonly select_decoys: (
    real_output_index: bigint,
    cumulative_distribution_json: string,
    ring_size: number,
  ) => string;
  readonly sign_sweep_tx: (
    construction_data_json: string,
    spend_key_hex: string,
    view_key_hex: string,
  ) => string;
  readonly compute_commitment_mask: (
    view_key_hex: string,
    tx_public_key_hex: string,
    output_index: bigint,
  ) => string;
  readonly verify_commitment: (
    view_key_hex: string,
    tx_public_key_hex: string,
    output_index: bigint,
    amount: bigint,
    on_chain_commitment_hex: string,
  ) => boolean;
  readonly decrypt_amount: (
    view_key_hex: string,
    tx_public_key_hex: string,
    output_index: bigint,
    encrypted_amount_hex: string,
  ) => bigint;

  // Scalar utilities
  readonly secp256k1_scalar_to_ed25519: (secp_scalar_hex: string) => string;
  readonly ed25519_scalar_add: (scalar_a_hex: string, scalar_b_hex: string) => string;

  // Version helper
  readonly version: () => string;
}

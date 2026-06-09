/* tslint:disable */
/* eslint-disable */

/**
 * Compute the commitment mask for an output.
 */
export function compute_commitment_mask(view_key_hex: string, tx_public_key_hex: string, output_index: bigint): string;

/**
 * Decrypt a RingCT amount for an output.
 */
export function decrypt_amount(view_key_hex: string, tx_public_key_hex: string, output_index: bigint, encrypted_amount_hex: string): bigint;

/**
 * Decrypt an adaptor-encrypted signature with the decryption scalar.
 */
export function decrypt_signature(scalar_hex: string, encsig_hex: string): string;

/**
 * Derive key images for a set of outputs using the combined spend key.
 */
export function derive_key_images(outputs_json: string, view_key_hex: string, spend_key_hex: string): string;

/**
 * Add two ed25519 scalars modulo the group order.
 */
export function ed25519_scalar_add(scalar_a_hex: string, scalar_b_hex: string): string;

/**
 * Produce an adaptor-encrypted signature under the given encryption point.
 */
export function encsign_digest(b_hex: string, encryption_key_hex: string, digest_hex: string): string;

/**
 * Generate a fresh BTC/XMR swap key bundle with DLEQ proof.
 */
export function generate_client_keys(): string;

/**
 * Derive a BTC/XMR key bundle from caller-supplied seed material.
 */
export function generate_client_keys_from_seed(s_b_hex: string, v_b_hex: string, b_hex: string): string;

export function init_panic_hook(): void;

/**
 * Recover the adaptor scalar given the decrypted signature and the encsig.
 */
export function recover_adaptor_scalar(sig_hex: string, encsig_hex: string, encryption_key_hex: string): string;

/**
 * Convert a secp256k1 scalar (big-endian) to an ed25519 scalar (little-endian).
 */
export function secp256k1_scalar_to_ed25519(secp_scalar_hex: string): string;

/**
 * CLSAG ring decoys via wallet2's gamma distribution. JSON input may
 * override `unlock_window_blocks` (default DEFAULT_LOCK_WINDOW=10);
 * use 60 (coinbase lock) on coinbase-only chains (regtest, conservative).
 */
export function select_decoys(real_output_index: bigint, cumulative_distribution_json: string, ring_size: number): string;

/**
 * Sign a 32-byte digest with a secp256k1 secret key. Returns 64-byte compact.
 */
export function sign_digest(b_hex: string, digest_hex: string): string;

/**
 * Sign a Monero sweep transaction.
 */
export function sign_sweep_tx(construction_data_json: string, spend_key_hex: string, view_key_hex: string): string;

/**
 * Verify a commitment matches expected mask + amount.
 */
export function verify_commitment(view_key_hex: string, tx_public_key_hex: string, output_index: bigint, amount: bigint, on_chain_commitment_hex: string): boolean;

/**
 * Verify a DLEQ proof binding a secp256k1 key to an ed25519 key.
 */
export function verify_dleq_proof(s_bitcoin_hex: string, s_monero_hex: string, proof_hex: string): boolean;

/**
 * Verify an adaptor-encrypted signature is valid for the triple.
 */
export function verify_encsig(verification_key_hex: string, encryption_key_hex: string, digest_hex: string, encsig_hex: string): boolean;

/**
 * Used by consumers to detect pin drift.
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly compute_commitment_mask: (a: number, b: number, c: number, d: number, e: number, f: bigint) => void;
    readonly decrypt_amount: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: number) => void;
    readonly decrypt_signature: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly derive_key_images: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly ed25519_scalar_add: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly encsign_digest: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly generate_client_keys: (a: number) => void;
    readonly generate_client_keys_from_seed: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly init_panic_hook: () => void;
    readonly recover_adaptor_scalar: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly secp256k1_scalar_to_ed25519: (a: number, b: number, c: number) => void;
    readonly select_decoys: (a: number, b: bigint, c: number, d: number, e: number) => void;
    readonly sign_digest: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sign_sweep_tx: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly verify_commitment: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: bigint, h: number, i: number) => void;
    readonly verify_dleq_proof: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly verify_encsig: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly version: (a: number) => void;
    readonly rustsecp256k1_v0_9_2_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_9_2_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_9_2_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_9_2_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export3: (a: number, b: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

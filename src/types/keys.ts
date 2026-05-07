// Lowercase matches the keygen WASM output convention.
export interface ClientKeys {
  readonly s_b_bitcoin: string;
  readonly s_b_monero: string;
  readonly s_b: string;
  readonly dleq_proof: string;
  readonly v_b: string;
  readonly b: string;
  readonly B: string;
}

// API uses uppercase S_b_*. Public key B is sent; private key b stays client-side.
export interface ClientKeysApi {
  readonly S_b_bitcoin: string;
  readonly S_b_monero: string;
  readonly dleq_proof: string;
  readonly v_b: string;
  readonly B: string;
  // 32B hex master seed for the per-swap libp2p identity. Forwarded to the
  // sidecar so a recovery binary can re-derive the same peer-id. Optional.
  readonly libp2p_seed_hex?: string;
}

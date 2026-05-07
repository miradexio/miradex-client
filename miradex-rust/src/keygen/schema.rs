//! Serde struct for the JSON returned by generate_client_keys[_from_seed].

use serde::Serialize;

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
pub struct ClientKeysJson {
    pub s_b_bitcoin: String,
    pub s_b_monero: String,
    pub s_b: String,
    pub dleq_proof: String,
    pub v_b: String,
    pub b: String,
    pub B: String,
}

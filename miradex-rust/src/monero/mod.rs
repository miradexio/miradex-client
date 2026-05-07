pub mod commitment;
pub mod decoys;
pub mod helpers;
pub mod key_images;
pub mod sweep;
pub mod types;

// Amount decryption is part of commitment.rs (decrypt_amount_inner); the
// module-level alias keeps the public API simple.
pub mod amounts {
    pub use super::commitment::decrypt_amount_inner as decrypt;
}

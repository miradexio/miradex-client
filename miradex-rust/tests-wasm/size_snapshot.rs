//! Non-asserting size probe. Actual size is produced by wasm-pack.

#![cfg(target_arch = "wasm32")]

use wasm_bindgen_test::*;

#[wasm_bindgen_test]
fn version_string_nonempty() {
    assert!(!miradex_rust::version().is_empty());
}

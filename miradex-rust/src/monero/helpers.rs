use wasm_bindgen::prelude::*;

pub fn to_js(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

pub fn decode_hex(hex_str: &str, label: &str) -> Result<Vec<u8>, String> {
    hex::decode(hex_str).map_err(|e| format!("{label} hex: {e}"))
}

pub fn decode_hex_exact<const N: usize>(hex_str: &str, label: &str) -> Result<[u8; N], String> {
    let bytes = decode_hex(hex_str, label)?;
    bytes
        .try_into()
        .map_err(|_| format!("{label} must be {N} bytes"))
}

// String -> JsValue wrappers for WASM exports.
pub fn decode_hex_js(hex_str: &str, label: &str) -> Result<Vec<u8>, JsValue> {
    decode_hex(hex_str, label).map_err(to_js)
}

pub fn decode_hex_exact_js<const N: usize>(hex_str: &str, label: &str) -> Result<[u8; N], JsValue> {
    decode_hex_exact(hex_str, label).map_err(to_js)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_hex_valid() {
        let result = decode_hex("deadbeef", "test").unwrap();
        assert_eq!(result, vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn test_decode_hex_invalid() {
        let result = decode_hex("zzzz", "test");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("test hex:"));
    }

    #[test]
    fn test_decode_hex_exact_valid() {
        let result: [u8; 4] = decode_hex_exact("deadbeef", "test").unwrap();
        assert_eq!(result, [0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn test_decode_hex_exact_wrong_length() {
        let result: Result<[u8; 4], _> = decode_hex_exact("dead", "test");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("must be 4 bytes"));
    }

    #[test]
    fn test_decode_hex_empty() {
        let result = decode_hex("", "test").unwrap();
        assert!(result.is_empty());
    }
}

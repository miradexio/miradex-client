//! Unified error type. TypeScript catches the JsValue and switches on its
//! `.name` which is the stable `.code()` string.

use wasm_bindgen::JsValue;

#[derive(Debug, thiserror::Error)]
pub enum MiradexWasmError {
    #[error("hex decode failed for {field}: {message}")]
    HexDecode { field: &'static str, message: String },
    #[error("{field} length: expected {expected}, got {got}")]
    Length { field: &'static str, expected: usize, got: usize },
    #[error("{field} is not on curve")]
    NotOnCurve { field: &'static str },
    #[error("{field} is not canonically reduced")]
    NotReduced { field: &'static str },
    #[error("encsig deserialize: {0}")]
    EncsigDeserialize(String),
    #[error("DLEQ proof invalid")]
    DleqInvalid,
    #[error("encsig invalid")]
    EncsigInvalid,
    #[error("monero scan: {0}")]
    MoneroScan(String),
    #[error("CLSAG sign: {0}")]
    ClsagSign(String),
    #[error("amount decrypt: {0}")]
    AmountDecrypt(String),
    #[error("commitment mismatch")]
    CommitmentMismatch,
    #[error("serialize: {0}")]
    Serialize(String),
    #[error("{0}")]
    Unknown(String),
}

impl MiradexWasmError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::HexDecode { .. } => "E_HEX_DECODE",
            Self::Length { .. } => "E_LENGTH",
            Self::NotOnCurve { .. } => "E_NOT_ON_CURVE",
            Self::NotReduced { .. } => "E_NOT_REDUCED",
            Self::EncsigDeserialize(_) => "E_ENCSIG_DESERIALIZE",
            Self::DleqInvalid => "E_DLEQ_INVALID",
            Self::EncsigInvalid => "E_ENCSIG_INVALID",
            Self::MoneroScan(_) => "E_MONERO_SCAN",
            Self::ClsagSign(_) => "E_CLSAG_SIGN",
            Self::AmountDecrypt(_) => "E_AMOUNT_DECRYPT",
            Self::CommitmentMismatch => "E_COMMITMENT_MISMATCH",
            Self::Serialize(_) => "E_SERIALIZE",
            Self::Unknown(_) => "E_UNKNOWN",
        }
    }
}

impl From<MiradexWasmError> for JsValue {
    fn from(err: MiradexWasmError) -> Self {
        let obj = js_sys::Error::new(&err.to_string());
        obj.set_name(err.code());
        JsValue::from(obj)
    }
}

pub type Result<T> = core::result::Result<T, MiradexWasmError>;

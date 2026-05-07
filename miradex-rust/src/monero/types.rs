use serde::{Deserialize, Serialize};

// Server scans with its view key, finds owned outputs, and extracts the
// fields key-image derivation and signing need.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredOutput {
    /// One-time public key P (32 bytes hex). The output's stealth address.
    pub one_time_public_key: String,
    /// Transaction public key R (32 bytes hex). From the tx extra field.
    pub tx_public_key: String,
    /// Index of this output within its transaction.
    pub output_index: u64,
    /// Global output index on the blockchain (used for ring member selection).
    pub global_output_index: u64,
    /// Decrypted amount in piconeros.
    pub amount: u64,
    /// RingCT commitment blinding factor / mask (32 bytes hex).
    pub rct_mask: String,
    /// Additional tx keys for subaddress outputs (each 32 bytes hex).
    #[serde(default)]
    pub additional_tx_keys: Vec<String>,
    /// Subaddress major index (account).
    #[serde(default)]
    pub subaddr_major: u32,
    /// Subaddress minor index (address within account).
    #[serde(default)]
    pub subaddr_minor: u32,
}

/// A ring member — either the real output being spent or a decoy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RingMember {
    /// One-time public key (32 bytes hex).
    pub public_key: String,
    /// Pedersen commitment to the output amount (32 bytes hex).
    pub commitment: String,
}

/// One input to the sweep transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SweepInput {
    /// Ring members: 16 total (1 real + 15 decoys), ordered by global index.
    pub ring_members: Vec<RingMember>,
    /// Index within `ring_members` that is the real output being spent.
    pub real_output_index: usize,
    /// The real output's full data (needed for key derivation during signing).
    pub real_output: StructuredOutput,
    /// Global output indices for each ring member (absolute, not offsets).
    pub key_offsets: Vec<u64>,
}

/// Destination for the sweep transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SweepDestination {
    /// Monero address (standard base58-encoded).
    pub address: String,
    /// Amount in piconeros.
    pub amount: u64,
}

// Everything build + sign need: inputs with rings (decoys pre-selected),
// destination, fee, tx metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SweepConstructionData {
    /// Transaction inputs, each with their ring of 16 members.
    pub inputs: Vec<SweepInput>,
    /// Where to send the swept funds.
    pub destination: SweepDestination,
    /// Network fee in piconeros.
    pub fee: u64,
    /// Transaction extra field (hex-encoded).
    pub tx_extra: String,
    /// RingCT type: 6 = CLSAG + Bulletproofs+.
    pub rct_type: u8,
}

/// Result of key image derivation for a single output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyImageResult {
    /// The key image I = x * Hp(P) (32 bytes hex).
    pub key_image: String,
    /// Schnorr signature proving correct derivation (64 bytes hex).
    pub signature: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_structured_output_roundtrip() {
        let output = StructuredOutput {
            one_time_public_key: "aa".repeat(32),
            tx_public_key: "bb".repeat(32),
            output_index: 0,
            global_output_index: 12345,
            amount: 1_000_000_000_000,
            rct_mask: "cc".repeat(32),
            additional_tx_keys: vec![],
            subaddr_major: 0,
            subaddr_minor: 0,
        };
        let json = serde_json::to_string(&output).unwrap();
        let parsed: StructuredOutput = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.amount, 1_000_000_000_000);
        assert_eq!(parsed.global_output_index, 12345);
    }

    #[test]
    fn test_sweep_construction_data_roundtrip() {
        let data = SweepConstructionData {
            inputs: vec![SweepInput {
                ring_members: vec![RingMember {
                    public_key: "aa".repeat(32),
                    commitment: "bb".repeat(32),
                }],
                real_output_index: 0,
                real_output: StructuredOutput {
                    one_time_public_key: "aa".repeat(32),
                    tx_public_key: "bb".repeat(32),
                    output_index: 0,
                    global_output_index: 100,
                    amount: 500_000_000_000,
                    rct_mask: "cc".repeat(32),
                    additional_tx_keys: vec![],
                    subaddr_major: 0,
                    subaddr_minor: 0,
                },
                key_offsets: vec![100],
            }],
            destination: SweepDestination {
                address: "5...fake_address".to_string(),
                amount: 499_000_000_000,
            },
            fee: 1_000_000_000,
            tx_extra: "dd".repeat(33),
            rct_type: 6,
        };
        let json = serde_json::to_string(&data).unwrap();
        let parsed: SweepConstructionData = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.fee, 1_000_000_000);
        assert_eq!(parsed.inputs.len(), 1);
        assert_eq!(parsed.destination.amount, 499_000_000_000);
    }

    #[test]
    fn test_key_image_result_roundtrip() {
        let result = KeyImageResult {
            key_image: "ee".repeat(32),
            signature: "ff".repeat(64),
        };
        let json = serde_json::to_string(&result).unwrap();
        let parsed: KeyImageResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.key_image, "ee".repeat(32));
    }
}

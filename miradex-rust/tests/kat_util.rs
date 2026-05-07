use miradex_rust::util::decode::decode_hex_exact;
use miradex_rust::util::scalar_convert::{ed_add, secp_to_ed};

#[test]
fn secp_to_ed_reverses_byte_order() {
    // 0x...01 in big-endian secp → 0x01... in little-endian ed (value = 1).
    let secp = "0000000000000000000000000000000000000000000000000000000000000001";
    let ed = secp_to_ed(secp).unwrap();
    assert_eq!(
        ed,
        "0100000000000000000000000000000000000000000000000000000000000000"
    );
}

#[test]
fn ed_add_identity() {
    let a = "0100000000000000000000000000000000000000000000000000000000000000";
    let zero = "0000000000000000000000000000000000000000000000000000000000000000";
    assert_eq!(ed_add(a, zero).unwrap(), a);
}

#[test]
fn ed_add_one_plus_one() {
    let one = "0100000000000000000000000000000000000000000000000000000000000000";
    assert_eq!(
        ed_add(one, one).unwrap(),
        "0200000000000000000000000000000000000000000000000000000000000000"
    );
}

#[test]
fn decode_rejects_wrong_length() {
    let short = "ab";
    let err = decode_hex_exact::<32>(short, "field").unwrap_err();
    assert_eq!(err.code(), "E_LENGTH");
}

#[test]
fn decode_rejects_non_hex() {
    let not_hex = "zz".repeat(32);
    let err = decode_hex_exact::<32>(&not_hex, "field").unwrap_err();
    assert_eq!(err.code(), "E_HEX_DECODE");
}

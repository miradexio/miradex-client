// Byte-for-byte match with eigenwallet swap/src/seed.rs::derive_libp2p_identity:
//   network_seed = SHA256(master_seed || "NETWORK")
//   libp2p_seed  = SHA256(network_seed || "LIBP2P_IDENTITY")
//   keypair      = Ed25519::from_bytes(libp2p_seed)
//   peer_id      = base58btc(identity_multihash(protobuf(pubkey)))
// Plain concat-SHA-256, NOT HMAC. Matching the Rust derivation gives us the
// same peer-id, which is what enables cross-binary recovery without patching.

import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { getPublicKey, hashes as edHashes } from '@noble/ed25519';
import { base58 } from '@scure/base';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

// @noble/ed25519's async API uses WebCrypto SHA-512, which browsers gate to
// secure contexts. Self-hosted miradex-web runs over plain HTTP from a LAN
// IP / .local / onion — none qualify — so getPublicKeyAsync throws. Wire the
// pure-JS @noble/hashes sha512 into ed25519's sync hash slot to keep the
// sync API working everywhere. Same crypto, no secure-context requirement.
edHashes.sha512 = sha512;

const NETWORK_DOMAIN = new TextEncoder().encode('NETWORK');
const LIBP2P_IDENTITY_DOMAIN = new TextEncoder().encode('LIBP2P_IDENTITY');

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function deriveScope(seed: Uint8Array, scope: Uint8Array): Uint8Array {
  return sha256(concatBytes(seed, scope));
}

export interface DerivedLibp2pIdentity {
  /** 32-byte Ed25519 secret seed (hex). What eigenwallet writes to seed.pem. */
  readonly libp2pSeedHex: string;
  /** base58btc PeerId string (e.g. "12D3KooW..."). */
  readonly libp2pPeerId: string;
  /** libp2p PublicKey protobuf bytes (hex), useful for diagnostics. */
  readonly libp2pPublicKeyProtoHex: string;
}

const ED25519_PUBKEY_BYTES = 32;
const PROTOBUF_PUBKEY_LEN = 36;
const IDENTITY_MULTIHASH_CODE = 0x00;
const PROTOBUF_KEYTYPE_TAG = 0x08;
const PROTOBUF_KEYTYPE_ED25519 = 0x01;
const PROTOBUF_DATA_TAG = 0x12;

export async function deriveLibp2pIdentity(
  masterSeedHex: string,
): Promise<DerivedLibp2pIdentity> {
  const masterSeed = hexToBytes(masterSeedHex);
  if (masterSeed.length !== 32) {
    throw new Error(`master_seed must be 32 bytes, got ${String(masterSeed.length)}`);
  }

  const networkSeed = deriveScope(masterSeed, NETWORK_DOMAIN);
  const libp2pSeed = deriveScope(networkSeed, LIBP2P_IDENTITY_DOMAIN);

  const publicKey = getPublicKey(libp2pSeed);
  if (publicKey.length !== ED25519_PUBKEY_BYTES) {
    throw new Error(
      `Ed25519 pubkey must be 32 bytes, got ${String(publicKey.length)}`,
    );
  }

  // libp2p PublicKey protobuf:
  //   field 1 KeyType=Ed25519: tag 0x08, value 0x01
  //   field 2 Data 32B:        tag 0x12, length 0x20, <32 bytes>
  const pubkeyProto = new Uint8Array(PROTOBUF_PUBKEY_LEN);
  pubkeyProto[0] = PROTOBUF_KEYTYPE_TAG;
  pubkeyProto[1] = PROTOBUF_KEYTYPE_ED25519;
  pubkeyProto[2] = PROTOBUF_DATA_TAG;
  pubkeyProto[3] = ED25519_PUBKEY_BYTES;
  pubkeyProto.set(publicKey, 4);

  // Identity multihash (code 0x00) for keys <= 42B; libp2p uses this for
  // Ed25519 PeerIds.
  const multihash = new Uint8Array(2 + pubkeyProto.length);
  multihash[0] = IDENTITY_MULTIHASH_CODE;
  multihash[1] = pubkeyProto.length;
  multihash.set(pubkeyProto, 2);

  const peerId = base58.encode(multihash);

  return {
    libp2pSeedHex: bytesToHex(libp2pSeed),
    libp2pPeerId: peerId,
    libp2pPublicKeyProtoHex: bytesToHex(pubkeyProto),
  };
}

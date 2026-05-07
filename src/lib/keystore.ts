// Records how keys were derived so future code changes never break recovery.
export interface KeystoreDerivation {
  /** Scheme identifier (e.g. "miradex-v0") */
  readonly scheme: string;
  /** BIP32 derivation path used for the BTC key */
  readonly btcPath: string;
  /** HMAC domain string used to derive s_b from the BIP32 seed */
  readonly scalarDomain: string;
  /** HMAC domain string used to derive v_b from the BIP32 seed */
  readonly viewKeyDomain: string;
}

// v3 added eigenwallet_master_seed + libp2p_peer_id so a recovery binary
// (eigenwallet swap CLI) can reproduce the libp2p identity Bob used.
// Naming: lowercase s = secret scalar, uppercase S = curve point.
export interface SwapKeystore {
  readonly version: 3;
  readonly createdAt: string;
  readonly warning: string;
  /** BIP39 24-word mnemonic — THE master recovery key. Optional for pre-mnemonic keystores. */
  readonly mnemonic?: string;
  /** Derivation parameters used to produce all keys from the mnemonic. */
  readonly derivation?: KeystoreDerivation;
  readonly btc: {
    readonly wif: string;
    readonly address: string;
    readonly network: 'mainnet' | 'testnet' | 'regtest';
  };
  readonly keys: {
    readonly s_b: string; // ed25519 private scalar (32 bytes hex) — THE secret
    readonly v_b: string; // ed25519 private view key (32 bytes hex)
    readonly S_b_bitcoin: string; // secp256k1 public key (33 bytes hex)
    readonly S_b_monero: string; // ed25519 public key (32 bytes hex)
    readonly dleq_proof: string; // bincode-serialized DLEQ proof (hex)
    readonly b: string; // secp256k1 private key (32 bytes hex) — Bitcoin multisig key
    readonly B: string; // secp256k1 compressed public key (33 bytes hex)
    /** 32-byte hex master seed — feeds the libp2p identity HMAC chain. */
    readonly eigenwallet_master_seed: string;
    /** base58btc PeerId derived from `eigenwallet_master_seed`. Cached for logs. */
    readonly libp2p_peer_id: string;
  };
  readonly swap: {
    readonly receiveAddress: string;
    readonly refundAddress: string;
  };
}

export function createKeystore(params: {
  readonly wif: string;
  readonly btcAddress: string;
  readonly network: 'mainnet' | 'testnet' | 'regtest';
  readonly s_b: string; // hex from WASM
  readonly v_b: string; // hex from WASM
  readonly S_b_bitcoin: string; // hex from WASM
  readonly S_b_monero: string; // hex from WASM
  readonly dleq_proof: string; // hex from WASM
  readonly b: string; // hex from WASM — secp256k1 Bitcoin multisig key
  readonly B: string; // hex from WASM — compressed public key
  readonly eigenwallet_master_seed: string; // 32-byte hex
  readonly libp2p_peer_id: string; // base58btc
  readonly receiveAddress: string;
  readonly refundAddress: string;
  readonly mnemonic?: string;
  readonly derivation?: KeystoreDerivation;
}): SwapKeystore {
  const hasMnemonic = params.mnemonic !== undefined && params.mnemonic.length > 0;
  return {
    version: 3,
    createdAt: new Date().toISOString(),
    warning: hasMnemonic
      ? 'DO NOT SHARE. Contains private keys and recovery mnemonic for your atomic swap.'
      : 'DO NOT SHARE. Contains private keys for your atomic swap.',
    ...(params.mnemonic ? { mnemonic: params.mnemonic } : {}),
    ...(params.derivation ? { derivation: params.derivation } : {}),
    btc: {
      wif: params.wif,
      address: params.btcAddress,
      network: params.network,
    },
    keys: {
      s_b: params.s_b,
      v_b: params.v_b,
      S_b_bitcoin: params.S_b_bitcoin,
      S_b_monero: params.S_b_monero,
      dleq_proof: params.dleq_proof,
      b: params.b,
      B: params.B,
      eigenwallet_master_seed: params.eigenwallet_master_seed,
      libp2p_peer_id: params.libp2p_peer_id,
    },
    swap: {
      receiveAddress: params.receiveAddress,
      refundAddress: params.refundAddress,
    },
  };
}

// Handles v1, v2 (migrated), v3. V2->V3: empty libp2p fields, so recovery
// is keystore-only (mnemonic works) but eigenwallet can't reproduce the
// original peer-id. Fresh V3 keystores have the field populated.
export function parseKeystore(rawJson: string): SwapKeystore {
  const raw: unknown = JSON.parse(rawJson);

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid keystore format');
  }

  const obj = raw as Record<string, unknown>;
  const version = obj['version'];

  if (version === 3) {
    return raw as SwapKeystore;
  }

  if (version === 2) {
    return migrateV2toV3(obj);
  }

  if (version === 1) {
    return migrateV2toV3(migrateV1toV2(obj) as unknown as Record<string, unknown>);
  }

  throw new Error(`Unsupported keystore version: ${String(version)}`);
}

interface V2Keystore {
  readonly version: 2;
  readonly createdAt: string;
  readonly warning: string;
  readonly mnemonic?: string;
  readonly derivation?: KeystoreDerivation;
  readonly btc: {
    readonly wif: string;
    readonly address: string;
    readonly network: 'mainnet' | 'testnet' | 'regtest';
  };
  readonly keys: {
    readonly s_b: string;
    readonly v_b: string;
    readonly S_b_bitcoin: string;
    readonly S_b_monero: string;
    readonly dleq_proof: string;
    readonly b: string;
    readonly B: string;
  };
  readonly swap: {
    readonly receiveAddress: string;
    readonly refundAddress: string;
  };
}

function migrateV2toV3(raw: Record<string, unknown>): SwapKeystore {
  const v2 = raw as unknown as V2Keystore;
  return {
    version: 3,
    createdAt: v2.createdAt,
    warning: v2.warning,
    ...(v2.mnemonic ? { mnemonic: v2.mnemonic } : {}),
    ...(v2.derivation ? { derivation: v2.derivation } : {}),
    btc: v2.btc,
    keys: {
      ...v2.keys,
      eigenwallet_master_seed: '',
      libp2p_peer_id: '',
    },
    swap: v2.swap,
  };
}

// V1 keystores had wrong field names and missing s_b. Migrate what we can;
// missing s_b leaves keys.s_b empty (no refund/sweep, but still loadable).
interface V1Keystore {
  readonly btc: { readonly wif: string; readonly address: string; readonly network: string };
  readonly monero?: {
    readonly privateSpendKey?: string;
    readonly privateViewKey?: string;
    readonly publicSpendKey?: string;
  };
  readonly dleq?: {
    readonly sBitcoin?: string;
    readonly sMonero?: string;
    readonly sB?: string;
    readonly proof?: string;
  };
  readonly swap?: { readonly receiveAddress?: string; readonly refundAddress?: string };
}

function migrateV1toV2(raw: Record<string, unknown>): V2Keystore {
  const v1 = raw as unknown as V1Keystore;

  return {
    version: 2,
    createdAt: (raw['createdAt'] as string) ?? new Date().toISOString(),
    warning: 'DO NOT SHARE. Contains private keys for your atomic swap.',
    btc: {
      wif: v1.btc.wif,
      address: v1.btc.address,
      network: (v1.btc.network || 'mainnet') as 'mainnet' | 'testnet' | 'regtest',
    },
    keys: {
      // s_b: v1 keystores may have dleq.sB (if created after partial fix) or nothing
      s_b: v1.dleq?.sB ?? '',
      v_b: v1.monero?.privateViewKey ?? '',
      S_b_bitcoin: v1.dleq?.sBitcoin ?? '',
      S_b_monero: v1.dleq?.sMonero ?? v1.monero?.publicSpendKey ?? '',
      dleq_proof: v1.dleq?.proof ?? '',
      b: '',
      B: '',
    },
    swap: {
      receiveAddress: v1.swap?.receiveAddress ?? '',
      refundAddress: v1.swap?.refundAddress ?? '',
    },
  };
}

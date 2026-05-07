// Derivation scheme miradex-v0:
//   24-word BIP39 mnemonic (256-bit entropy)
//     -> BIP32 seed (PBKDF2)
//       -> BTC: m/84'/0'/0'/0/0 (BIP84 P2WPKH)
//       -> s_b: HMAC-SHA512(seed, "miradex/s_b/v0")[:32] mod L
//       -> v_b: HMAC-SHA512(seed, "miradex/v_b/v0")[:32] mod L
// The mnemonic is the master recovery key for the BTC wallet, s_b, v_b, and
// the DLEQ proof (re-derived via WASM).

import * as bip39 from 'bip39';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as bitcoin from 'bitcoinjs-lib';
import type { KeystoreDerivation } from '../keystore.js';
import { wipe } from './bytes.js';

const bip32 = BIP32Factory(ecc);

const DERIVATION_SCHEME = 'miradex-v0';
const SCALAR_DOMAIN = 'miradex/s_b/v0';
const VIEW_KEY_DOMAIN = 'miradex/v_b/v0';
const BTC_KEY_DOMAIN = 'miradex/b/v0';

function btcDerivationPath(network: 'mainnet' | 'testnet' | 'regtest'): string {
  return network === 'mainnet' ? "m/84'/0'/0'/0/0" : "m/84'/1'/0'/0/0";
}

export interface MnemonicKeys {
  readonly mnemonic: string;
  readonly wif: string;
  readonly btcAddress: string;
  /** 32-byte hex seed for s_b — feed to WASM generate_client_keys_from_seed */
  readonly s_b_seed: string;
  /** 32-byte hex seed for v_b — feed to WASM generate_client_keys_from_seed */
  readonly v_b_seed: string;
  /** 32-byte hex seed for b (secp256k1 Bitcoin key) — feed to WASM */
  readonly b_seed: string;
  readonly derivation: KeystoreDerivation;
}

// 24-word BIP39, entropy from crypto.getRandomValues via @scure/bip39.
export function generateMnemonicKeys(network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet'): MnemonicKeys {
  const mnemonic = bip39.generateMnemonic(256);
  return deriveFromMnemonic(mnemonic, network);
}

// Throws MnemonicError on an invalid mnemonic.
export function deriveFromMnemonic(
  mnemonic: string,
  network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet',
): MnemonicKeys {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) {
    throw new MnemonicError(`mnemonic must be 12 or 24 words, got ${String(words.length)}`);
  }
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new MnemonicError('Invalid BIP39 mnemonic');
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const net = network === 'mainnet' ? bitcoin.networks.bitcoin : (network === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet);
  const path = btcDerivationPath(network);

  const root = bip32.fromSeed(seed, net);
  const child = root.derivePath(path);
  const wif = child.toWIF();
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(child.publicKey),
    network: net,
  });

  if (!address) {
    throw new MnemonicError('Failed to derive BTC address from mnemonic');
  }

  const s_b_raw = hmac(sha512, seed, new TextEncoder().encode(SCALAR_DOMAIN));
  const s_b_seed = bytesToHex(s_b_raw.subarray(0, 32));

  const v_b_raw = hmac(sha512, seed, new TextEncoder().encode(VIEW_KEY_DOMAIN));
  const v_b_seed = bytesToHex(v_b_raw.subarray(0, 32));

  const b_raw = hmac(sha512, seed, new TextEncoder().encode(BTC_KEY_DOMAIN));
  const b_seed = bytesToHex(b_raw.subarray(0, 32));

  // AV-G.2: wipe scratch + root seed as soon as the derived hex is captured.
  wipe(s_b_raw);
  wipe(v_b_raw);
  wipe(b_raw);
  wipe(seed);

  return {
    mnemonic,
    wif,
    btcAddress: address,
    s_b_seed,
    v_b_seed,
    b_seed,
    derivation: {
      scheme: DERIVATION_SCHEME,
      btcPath: path,
      scalarDomain: SCALAR_DOMAIN,
      viewKeyDomain: VIEW_KEY_DOMAIN,
    },
  };
}

export class MnemonicError extends Error {
  readonly name = 'MnemonicError';
}

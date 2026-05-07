// Ephemeral P2WPKH wallet for the atomic-swap lock tx; keys live in memory
// only and persist via the keystore file.

import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { VerificationError } from '../../types/index.js';

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

export interface TempBtcWallet {
  readonly keyPair: ReturnType<typeof ECPair.makeRandom>;
  readonly address: string;
  readonly publicKey: Buffer;
  readonly wif: string;
}

// Persist via createKeystore if the caller needs resume.
export function createTempWallet(network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet'): TempBtcWallet {
  const net = network === 'mainnet' ? bitcoin.networks.bitcoin : (network === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet);
  const keyPair = ECPair.makeRandom({ network: net });

  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network: net,
  });

  if (!address) throw new Error('Failed to derive BTC address');

  return {
    keyPair,
    address,
    publicKey: Buffer.from(keyPair.publicKey),
    wif: keyPair.toWIF(),
  };
}

// Sign every input with the wallet's keypair, finalise, return base64.
export function signPsbt(
  psbtBase64: string,
  wallet: TempBtcWallet,
  network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet',
): string {
  const net = network === 'mainnet' ? bitcoin.networks.bitcoin : (network === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet);
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: net });

  psbt.signAllInputs(wallet.keyPair);
  psbt.finalizeAllInputs();

  return psbt.toBase64();
}

// Segwit txid is invariant to signing (hash version+inputs+outputs+locktime
// only), so this matches what the sidecar broadcasts after signFundingPsbt.
export interface UnsignedFundingPsbt {
  /** Base64-encoded UNSIGNED PSBT, ready to send to the sidecar in /presigs. */
  readonly psbtBase64: string;
  /** Big-endian display-form txid of the (eventually-signed) lock tx. */
  readonly txid: string;
  /** Index of the lock output within the tx (always 0 for the simple shape). */
  readonly vout: number;
  /** Lock-output value in satoshis. */
  readonly amountSats: number;
}

// Build an unsigned PSBT paying from the wallet's UTXOs to lockAddress.
// Returns the deterministic txid+vout+value the sidecar uses for Message2/3.
// Sign later with signFundingPsbt, after encsig + snapshot.
// lockAmountSats MUST match Message2; omitted = full UTXO value (testing only).
export function buildUnsignedFundingPsbt(
  wallet: TempBtcWallet,
  utxos: readonly { readonly txid: string; readonly vout: number; readonly value: number }[],
  lockAddress: string,
  network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet',
  lockAmountSats?: number,
): UnsignedFundingPsbt {
  if (utxos.length === 0) throw new Error('At least one UTXO is required');

  const net = network === 'mainnet' ? bitcoin.networks.bitcoin : (network === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet);
  try {
    bitcoin.address.toOutputScript(lockAddress, net);
  } catch {
    throw new VerificationError(
      'E_DEST_ADDR_INVALID',
      `lockAddress ${lockAddress} is invalid for ${network}`,
    );
  }

  const psbt = new bitcoin.Psbt({ network: net });

  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(wallet.keyPair.publicKey),
    network: net,
  });
  if (!p2wpkh.output) throw new Error('Failed to derive P2WPKH script');

  const totalInputValue = utxos.reduce((sum, u) => sum + u.value, 0);

  for (const utxo of utxos) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: p2wpkh.output,
        value: BigInt(utxo.value),
      },
    });
  }

  const outputSats = lockAmountSats && lockAmountSats > 0 ? lockAmountSats : totalInputValue;

  psbt.addOutput({
    address: lockAddress,
    value: BigInt(outputSats),
  });

  // Segwit txid is fixed once inputs/outputs are set, but bitcoinjs-lib
  // doesn't expose an unsigned-tx accessor on Psbt. Rebuild manually.
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = 0;
  for (const input of psbt.txInputs) {
    tx.addInput(input.hash, input.index, input.sequence ?? 0xffffffff);
  }
  for (const output of psbt.txOutputs) {
    tx.addOutput(output.script, BigInt(output.value));
  }
  const txid = tx.getId();

  return {
    psbtBase64: psbt.toBase64(),
    txid,
    vout: 0,
    amountSats: outputSats,
  };
}

// Returns base64 of the fully-signed PSBT, ready to broadcast or POST /fund.
export function signFundingPsbt(
  unsignedPsbtBase64: string,
  wallet: TempBtcWallet,
  network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet',
): string {
  return signPsbt(unsignedPsbtBase64, wallet, network);
}

// Back-compat helper. Prefer build + sign separately so the snapshot can
// be written between the two.
export function buildAndSignFundingPsbt(
  wallet: TempBtcWallet,
  utxos: readonly { readonly txid: string; readonly vout: number; readonly value: number }[],
  lockAddress: string,
  network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet',
  lockAmountSats?: number,
): string {
  const unsigned = buildUnsignedFundingPsbt(wallet, utxos, lockAddress, network, lockAmountSats);
  return signFundingPsbt(unsigned.psbtBase64, wallet, network);
}

export function walletFromWif(
  wif: string,
  network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet',
): TempBtcWallet {
  const net = network === 'mainnet' ? bitcoin.networks.bitcoin : (network === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet);
  const keyPair = ECPair.fromWIF(wif, net);

  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network: net,
  });

  if (!address) throw new Error('Failed to derive BTC address from WIF');

  return {
    keyPair,
    address,
    publicKey: Buffer.from(keyPair.publicKey),
    wif: keyPair.toWIF(),
  };
}

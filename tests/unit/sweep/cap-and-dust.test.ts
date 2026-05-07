import { describe, it, expect } from 'vitest';
import { buildSweepTx } from '../../../src/lib/bitcoin/sweep.js';
import { VerificationError } from '../../../src/types/index.js';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';

const ECPair = ECPairFactory(ecc);

// Deterministic testnet wallet + dest address for fixtures.
function fixture() {
  const keyPair = ECPair.makeRandom({ network: bitcoin.networks.testnet });
  const wif = keyPair.toWIF();
  const { address: fromAddress } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network: bitcoin.networks.testnet,
  });
  const destKeyPair = ECPair.makeRandom({ network: bitcoin.networks.testnet });
  const { address: destAddress } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(destKeyPair.publicKey),
    network: bitcoin.networks.testnet,
  });
  if (!fromAddress || !destAddress) throw new Error('fixture');
  return { wif, fromAddress, destAddress };
}

describe('buildSweepTx — input cap + dust floor', () => {
  it('refuses > 10 inputs with E_DEPOSIT_TOO_MANY_UTXOS', () => {
    const { wif, destAddress } = fixture();
    const utxos = Array.from({ length: 11 }, (_, i) => ({
      txid: i.toString(16).padStart(64, '0'),
      vout: 0,
      value: 10_000,
      height: 100,
    }));
    let caught: VerificationError | undefined;
    try {
      buildSweepTx(wif, {
        txid: utxos[0]!.txid,
        vout: 0,
        value: utxos.reduce((s, u) => s + u.value, 0),
        confirmations: 1,
        status: 'confirmed',
        utxos,
      }, destAddress, 10_000, 'testnet');
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_DEPOSIT_TOO_MANY_UTXOS');
  });

  it('refuses output below dust floor with E_SWEEP_DUST', () => {
    const { wif, destAddress } = fixture();
    let caught: VerificationError | undefined;
    try {
      buildSweepTx(wif, {
        txid: 'aa'.repeat(32),
        vout: 0,
        value: 10_000,
        confirmations: 1,
        status: 'confirmed',
      }, destAddress, 100, 'testnet');
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_SWEEP_DUST');
  });

  it('rejects invalid destAddress with E_DEST_ADDR_INVALID', () => {
    const { wif } = fixture();
    let caught: VerificationError | undefined;
    try {
      buildSweepTx(wif, {
        txid: 'aa'.repeat(32),
        vout: 0,
        value: 10_000,
        confirmations: 1,
        status: 'confirmed',
      }, 'not-a-valid-address', 9_000, 'testnet');
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_DEST_ADDR_INVALID');
  });
});

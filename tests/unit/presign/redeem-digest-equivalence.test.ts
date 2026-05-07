import { describe, it, expect } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import {
  buildMultisigWitnessScript,
  computeRedeemDigest,
  computeRedeemDigestFromTxHex,
} from '../../../src/atomic-swap/presign.js';
import type { ProtocolParams } from '../../../src/types/index.js';

const ECPair = ECPairFactory(ecc);

// Fixture: build a signed TxLock PSBT (same helper pattern as amnesty-fee-dust
// tests) and confirm that the digest computed from the PSBT matches the
// digest computed from the same tx's raw hex — i.e., Option B (on-chain
// reconstruction) is byte-identical to the fresh-fund path.

function fixture(lockValueSats: number, network: 'mainnet' | 'testnet') {
  const net = network === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const aKp = ECPair.makeRandom({ network: net });
  const bKp = ECPair.makeRandom({ network: net });
  const aHex = Buffer.from(aKp.publicKey).toString('hex');
  const bHex = Buffer.from(bKp.publicKey).toString('hex');
  const bPrivHex = Buffer.from(bKp.privateKey as Uint8Array).toString('hex');

  const ws = buildMultisigWitnessScript(aHex, bHex);
  const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: ws }, network: net });
  if (!p2wsh.output) throw new Error('fixture: p2wsh derivation');

  const fundKp = ECPair.makeRandom({ network: net });
  const fundP2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(fundKp.publicKey),
    network: net,
  });
  if (!fundP2wpkh.output || !fundP2wpkh.address) throw new Error('fixture: fund derivation');

  const psbt = new bitcoin.Psbt({ network: net });
  psbt.addInput({
    hash: Buffer.from('11'.repeat(32), 'hex'),
    index: 0,
    witnessUtxo: { script: Buffer.from(fundP2wpkh.output), value: BigInt(lockValueSats + 1_000) },
  });
  psbt.addOutput({ script: Buffer.from(p2wsh.output), value: BigInt(lockValueSats) });
  psbt.signInput(0, {
    publicKey: Buffer.from(fundKp.publicKey),
    sign: (h: Buffer) => Buffer.from(fundKp.sign(h)),
  });
  psbt.finalizeAllInputs();
  const signedPsbtBase64 = psbt.toBase64();
  const rawTxHex = psbt.extractTransaction().toHex();

  const redeemKp = ECPair.makeRandom({ network: net });
  const redeemAddr = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(redeemKp.publicKey),
    network: net,
  }).address;
  if (!redeemAddr) throw new Error('fixture: redeem addr');

  const punishKp = ECPair.makeRandom({ network: net });
  const punishAddr = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(punishKp.publicKey),
    network: net,
  }).address;
  if (!punishAddr) throw new Error('fixture: punish addr');

  const protocolParams: ProtocolParams = {
    A: aHex,
    S_a_bitcoin: aHex,
    cancel_timelock: 72,
    punish_timelock: 144,
    redeem_address: redeemAddr,
    punish_address: punishAddr,
    tx_cancel_fee_sats: 2_000,
    tx_refund_fee_sats: 2_000,
    tx_redeem_fee_sats: 2_000,
    tx_punish_fee_sats: 2_000,
  };

  return { signedPsbtBase64, rawTxHex, bPrivHex, bHex, protocolParams, network };
}

describe('computeRedeemDigestFromTxHex equivalence', () => {
  it('produces byte-identical digest to computeRedeemDigest for the same tx', () => {
    const f = fixture(100_000, 'testnet');
    const fromPsbt = computeRedeemDigest({
      signedPsbtBase64: f.signedPsbtBase64,
      protocolParams: f.protocolParams,
      bPubHex: f.bHex,
      network: f.network,
    });
    const fromRaw = computeRedeemDigestFromTxHex({
      lockTxRawHex: f.rawTxHex,
      protocolParams: f.protocolParams,
      bPubHex: f.bHex,
      network: f.network,
    });
    expect(fromRaw).toBe(fromPsbt);
    expect(fromRaw).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mainnet path matches too', () => {
    const f = fixture(250_000, 'mainnet');
    const fromPsbt = computeRedeemDigest({
      signedPsbtBase64: f.signedPsbtBase64,
      protocolParams: f.protocolParams,
      bPubHex: f.bHex,
      network: f.network,
    });
    const fromRaw = computeRedeemDigestFromTxHex({
      lockTxRawHex: f.rawTxHex,
      protocolParams: f.protocolParams,
      bPubHex: f.bHex,
      network: f.network,
    });
    expect(fromRaw).toBe(fromPsbt);
  });
});

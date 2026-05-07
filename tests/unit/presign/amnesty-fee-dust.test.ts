import { describe, it, expect } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { computePreSigs, buildMultisigWitnessScript } from '../../../src/atomic-swap/presign.js';
import type { ProtocolParams } from '../../../src/types/index.js';
import { VerificationError } from '../../../src/types/index.js';

const ECPair = ECPairFactory(ecc);

// Helper: build a minimal signed-looking PSBT whose first output is a P2WSH
// matching the 2-of-2 descriptor derived from (A, B).
function buildFixture(args: { readonly lockValueSats: number; readonly network: 'mainnet' | 'testnet' }) {
  const net = args.network === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;

  const aKeyPair = ECPair.makeRandom({ network: net });
  const bKeyPair = ECPair.makeRandom({ network: net });
  const aHex = Buffer.from(aKeyPair.publicKey).toString('hex');
  const bHex = Buffer.from(bKeyPair.publicKey).toString('hex');
  const bPrivHex = Buffer.from(bKeyPair.privateKey as Uint8Array).toString('hex');

  const witnessScript = buildMultisigWitnessScript(aHex, bHex);
  const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: witnessScript }, network: net });
  if (!p2wsh.output) throw new Error('fixture: failed to derive P2WSH');

  // Build a minimal funding tx: one P2WPKH input, one P2WSH output.
  const fundingKeyPair = ECPair.makeRandom({ network: net });
  const fundingP2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(fundingKeyPair.publicKey),
    network: net,
  });
  if (!fundingP2wpkh.output || !fundingP2wpkh.address) throw new Error('fixture: funding p2wpkh derivation failed');

  const psbt = new bitcoin.Psbt({ network: net });
  const fakePrevTxid = Buffer.from('11'.repeat(32), 'hex');
  const fundingValueSats = args.lockValueSats + 1_000; // leave a fee gap
  psbt.addInput({
    hash: fakePrevTxid,
    index: 0,
    witnessUtxo: {
      script: Buffer.from(fundingP2wpkh.output),
      value: BigInt(fundingValueSats),
    },
  });
  psbt.addOutput({ script: Buffer.from(p2wsh.output), value: BigInt(args.lockValueSats) });
  psbt.signInput(0, {
    publicKey: Buffer.from(fundingKeyPair.publicKey),
    sign: (hash: Buffer) => Buffer.from(fundingKeyPair.sign(hash)),
  });
  psbt.finalizeAllInputs();
  const signedPsbtBase64 = psbt.toBase64();

  const refundKeyPair = ECPair.makeRandom({ network: net });
  const refundP2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(refundKeyPair.publicKey),
    network: net,
  });
  if (!refundP2wpkh.address) throw new Error('fixture: refund address derivation failed');

  const redeemKeyPair = ECPair.makeRandom({ network: net });
  const redeemP2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(redeemKeyPair.publicKey),
    network: net,
  });
  if (!redeemP2wpkh.address) throw new Error('fixture: redeem address derivation failed');

  const punishKeyPair = ECPair.makeRandom({ network: net });
  const punishP2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(punishKeyPair.publicKey),
    network: net,
  });
  if (!punishP2wpkh.address) throw new Error('fixture: punish address derivation failed');

  return {
    aHex,
    bHex,
    bPrivHex,
    signedPsbtBase64,
    refundAddress: refundP2wpkh.address,
    redeemAddress: redeemP2wpkh.address,
    punishAddress: punishP2wpkh.address,
    network: args.network,
  };
}

function baseProtocolParams(args: {
  readonly aHex: string;
  readonly redeemAddress: string;
  readonly punishAddress: string;
}): ProtocolParams {
  return {
    A: args.aHex,
    S_a_bitcoin: args.aHex,
    cancel_timelock: 72,
    punish_timelock: 144,
    redeem_address: args.redeemAddress,
    punish_address: args.punishAddress,
    tx_cancel_fee_sats: 2_000,
    tx_refund_fee_sats: 2_000,
    tx_redeem_fee_sats: 2_000,
    tx_punish_fee_sats: 2_000,
  };
}

describe('computePreSigs — fee bounds, amnesty cap, dust floor', () => {
  it('happy path: balanced fees and no amnesty produces three sigs', () => {
    const f = buildFixture({ lockValueSats: 100_000, network: 'testnet' });
    const pp = baseProtocolParams({ aHex: f.aHex, redeemAddress: f.redeemAddress, punishAddress: f.punishAddress });
    const sigs = computePreSigs({
      bHex: f.bPrivHex,
      signedPsbtBase64: f.signedPsbtBase64,
      protocolParams: pp,
      refundAddress: f.refundAddress,
      network: f.network,
    });
    expect(sigs.tx_cancel_sig).toMatch(/^[0-9a-f]+$/);
    expect(sigs.tx_punish_sig).toMatch(/^[0-9a-f]+$/);
    expect(sigs.tx_early_refund_sig).toMatch(/^[0-9a-f]+$/);
  });

  it('throws E_FEE_BELOW_RELAY when a fee is zero', () => {
    const f = buildFixture({ lockValueSats: 100_000, network: 'testnet' });
    const pp: ProtocolParams = {
      ...baseProtocolParams({ aHex: f.aHex, redeemAddress: f.redeemAddress, punishAddress: f.punishAddress }),
      tx_cancel_fee_sats: 0,
    };
    let caught: VerificationError | undefined;
    try {
      computePreSigs({
        bHex: f.bPrivHex,
        signedPsbtBase64: f.signedPsbtBase64,
        protocolParams: pp,
        refundAddress: f.refundAddress,
        network: f.network,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_FEE_BELOW_RELAY');
  });

  it('throws E_FEE_ABOVE_CAP when a fee exceeds the weight ceiling', () => {
    const f = buildFixture({ lockValueSats: 10_000_000, network: 'testnet' });
    const pp: ProtocolParams = {
      ...baseProtocolParams({ aHex: f.aHex, redeemAddress: f.redeemAddress, punishAddress: f.punishAddress }),
      tx_cancel_fee_sats: 200_000,
    };
    let caught: VerificationError | undefined;
    try {
      computePreSigs({
        bHex: f.bPrivHex,
        signedPsbtBase64: f.signedPsbtBase64,
        protocolParams: pp,
        refundAddress: f.refundAddress,
        network: f.network,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_FEE_ABOVE_CAP');
  });

  it('throws E_AMNESTY_EXCEEDS_CAP when amnesty exceeds the configured policy ratio', () => {
    const f = buildFixture({ lockValueSats: 100_000, network: 'testnet' });
    const pp: ProtocolParams = {
      ...baseProtocolParams({ aHex: f.aHex, redeemAddress: f.redeemAddress, punishAddress: f.punishAddress }),
      amnesty_amount_sats: 11_000, // 11% of 100k — over the 10% cap below
      tx_partial_refund_fee_sats: 2_000,
      tx_reclaim_fee_sats: 2_000,
      tx_withhold_fee_sats: 2_000,
      tx_mercy_fee_sats: 2_000,
      remaining_refund_timelock: 72,
    };
    let caught: VerificationError | undefined;
    try {
      computePreSigs({
        bHex: f.bPrivHex,
        signedPsbtBase64: f.signedPsbtBase64,
        protocolParams: pp,
        refundAddress: f.refundAddress,
        network: f.network,
        amnestyPolicy: { maxRatioBps: 1_000 },
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_AMNESTY_EXCEEDS_CAP');
  });

  it('throws E_AMNESTY_NEGATIVE when amnesty_amount_sats is negative', () => {
    const f = buildFixture({ lockValueSats: 100_000, network: 'testnet' });
    const pp: ProtocolParams = {
      ...baseProtocolParams({ aHex: f.aHex, redeemAddress: f.redeemAddress, punishAddress: f.punishAddress }),
      amnesty_amount_sats: -1,
    };
    let caught: VerificationError | undefined;
    try {
      computePreSigs({
        bHex: f.bPrivHex,
        signedPsbtBase64: f.signedPsbtBase64,
        protocolParams: pp,
        refundAddress: f.refundAddress,
        network: f.network,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_AMNESTY_NEGATIVE');
  });

  it('throws E_OUTPUT_DUST when the punish output falls below the p2wpkh dust floor', () => {
    // Craft: lockValueSats - cancelFee (low, within bounds) - punishFee just leaves dust.
    // Single-in/single-out fee ceiling at 500 sat/vB over 154 vB = 77_000 sats max.
    // Pick fees that sum close to the lock value so the final output dips under 294 sats.
    const f = buildFixture({ lockValueSats: 5_000, network: 'testnet' });
    const pp: ProtocolParams = {
      ...baseProtocolParams({ aHex: f.aHex, redeemAddress: f.redeemAddress, punishAddress: f.punishAddress }),
      tx_cancel_fee_sats: 2_000,
      tx_punish_fee_sats: 2_900, // cancelOut=3000, punishOut=100 → below 294
    };
    let caught: VerificationError | undefined;
    try {
      computePreSigs({
        bHex: f.bPrivHex,
        signedPsbtBase64: f.signedPsbtBase64,
        protocolParams: pp,
        refundAddress: f.refundAddress,
        network: f.network,
      });
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_OUTPUT_DUST');
  });
});

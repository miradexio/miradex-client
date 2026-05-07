/**
 * V2 → V3 keystore migration tests.
 *
 * The V3 keystore adds `eigenwallet_master_seed` and `libp2p_peer_id` so a
 * recovery binary can reproduce the per-swap libp2p identity. Loading a V2
 * file succeeds (so existing users can see / inspect their old keystores),
 * but stamps empty strings for the new fields — the refuse-new-swap guard
 * in runAtomicSwap / resumeAtomicSwap then prevents a V2 keystore from
 * being used for a fresh swap.
 */
import { describe, it, expect } from 'vitest';
import { createKeystore, parseKeystore } from '../../../src/lib/keystore.js';

describe('keystore V2 → V3 migration', () => {
  it('loads a V2 keystore and upgrades in-memory to V3 with empty libp2p fields', () => {
    const v2 = {
      version: 2,
      createdAt: '2025-10-01T00:00:00Z',
      warning: 'DO NOT SHARE',
      mnemonic: 'abandon '.repeat(23) + 'art',
      derivation: {
        scheme: 'miradex-v0',
        btcPath: "m/84'/0'/0'/0/0",
        scalarDomain: 'miradex/s_b/v0',
        viewKeyDomain: 'miradex/v_b/v0',
      },
      btc: {
        wif: 'L1testWifKey',
        address: 'bc1qtest',
        network: 'mainnet',
      },
      keys: {
        s_b: '11'.repeat(32),
        v_b: '22'.repeat(32),
        S_b_bitcoin: '02' + '33'.repeat(32),
        S_b_monero: '44'.repeat(32),
        dleq_proof: '55'.repeat(64),
        b: '66'.repeat(32),
        B: '02' + '77'.repeat(32),
      },
      swap: {
        receiveAddress: '4Addr...',
        refundAddress: 'bc1qrefund',
      },
    };
    const loaded = parseKeystore(JSON.stringify(v2));
    expect(loaded.version).toBe(3);
    expect(loaded.keys.s_b).toBe('11'.repeat(32));
    expect(loaded.keys.eigenwallet_master_seed).toBe('');
    expect(loaded.keys.libp2p_peer_id).toBe('');
    expect(loaded.mnemonic).toBe(v2.mnemonic);
  });

  it('loads a V3 keystore unchanged', () => {
    const v3 = createKeystore({
      wif: 'L1x',
      btcAddress: 'bc1qtest',
      network: 'mainnet',
      s_b: '11'.repeat(32),
      v_b: '22'.repeat(32),
      S_b_bitcoin: '02' + '33'.repeat(32),
      S_b_monero: '44'.repeat(32),
      dleq_proof: '55'.repeat(64),
      b: '66'.repeat(32),
      B: '02' + '77'.repeat(32),
      eigenwallet_master_seed: 'aa'.repeat(32),
      libp2p_peer_id: '12D3KooWFixture',
      receiveAddress: '4addr',
      refundAddress: 'bc1qrefund',
    });
    const roundtripped = parseKeystore(JSON.stringify(v3));
    expect(roundtripped.version).toBe(3);
    expect(roundtripped.keys.eigenwallet_master_seed).toBe('aa'.repeat(32));
    expect(roundtripped.keys.libp2p_peer_id).toBe('12D3KooWFixture');
  });

  it('rejects unsupported version numbers', () => {
    const bad = { version: 99, createdAt: '', warning: '', btc: {}, keys: {}, swap: {} };
    expect(() => parseKeystore(JSON.stringify(bad))).toThrow(/Unsupported keystore version/);
  });

  it('migrates V1 keystores through V2 into V3 with empty new fields', () => {
    const v1 = {
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      btc: { wif: 'L1old', address: 'bc1qold', network: 'mainnet' },
      dleq: {
        sBitcoin: '02' + '33'.repeat(32),
        sMonero: '44'.repeat(32),
        proof: '55'.repeat(64),
        sB: '11'.repeat(32),
      },
      monero: { privateViewKey: '22'.repeat(32), publicSpendKey: '44'.repeat(32) },
      swap: { receiveAddress: '4old', refundAddress: 'bc1qold' },
    };
    const loaded = parseKeystore(JSON.stringify(v1));
    expect(loaded.version).toBe(3);
    expect(loaded.keys.s_b).toBe('11'.repeat(32));
    expect(loaded.keys.eigenwallet_master_seed).toBe('');
    expect(loaded.keys.libp2p_peer_id).toBe('');
    expect(loaded.btc.address).toBe('bc1qold');
  });
});

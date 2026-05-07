import { describe, it, expect } from 'vitest';
import { aggregateUtxosAsDeposit } from '../../../src/lib/bitcoin/sweep.js';
import type { Utxo } from '../../../src/interfaces/blockchain.js';
import { VerificationError } from '../../../src/types/index.js';

function utxo(i: number, confirmations = 1): Utxo {
  return {
    txid: i.toString(16).padStart(64, '0'),
    vout: 0,
    value: 50_000,
    confirmations,
  };
}

describe('aggregateUtxosAsDeposit (AV-A.20 dust-storm cap)', () => {
  it('accepts 10 UTXOs', () => {
    const utxos = Array.from({ length: 10 }, (_, i) => utxo(i));
    const result = aggregateUtxosAsDeposit(utxos);
    expect(result).not.toBeNull();
    expect(result?.utxos?.length).toBe(10);
  });

  it('throws E_DEPOSIT_TOO_MANY_UTXOS at 11', () => {
    const utxos = Array.from({ length: 11 }, (_, i) => utxo(i));
    let caught: VerificationError | undefined;
    try {
      aggregateUtxosAsDeposit(utxos);
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_DEPOSIT_TOO_MANY_UTXOS');
  });

  it('uses confirmations field (not height) for mempool detection', () => {
    const utxos = [utxo(1, 0), utxo(2, 1)];
    const result = aggregateUtxosAsDeposit(utxos);
    expect(result?.confirmations).toBe(0);
    expect(result?.status).toBe('mempool');
  });
});

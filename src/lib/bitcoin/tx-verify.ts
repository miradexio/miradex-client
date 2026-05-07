// Verify TxCancel on-chain before sharing s_b. Without this, a server lying
// about a confirmed TxCancel can trick us into leaking s_b; the maker then
// combines s_a + s_b to sweep XMR while leaving BTC locked.
//
// Steps:
//   1. fetch raw tx from Electrum independently
//   2. confirm server-supplied hex matches on-chain hex
//   3. decode + verify the tx spends from the known lock address
//   4. confirm block inclusion (height > 0)

import * as bitcoin from 'bitcoinjs-lib';
import type { BlockchainDataProvider } from '../../interfaces/blockchain.js';
import { addressToScriptHash } from './script-hash.js';
import { uint8ArrayEquals } from '../crypto/bytes.js';

export interface TxCancelVerification {
  readonly verified: boolean;
  readonly reason: string;
  /** Raw TxCancel hex, present on the success path. Needed by client-side refund. */
  readonly txCancelHex?: string;
  /** TxCancel txid (big-endian display form), present on the success path. */
  readonly txCancelTxid?: string;
  /** Block height at which TxCancel confirmed, present on the success path. */
  readonly blockHeight?: number;
}

export async function verifyTxCancel(
  blockchain: BlockchainDataProvider,
  txCancelTxid: string,
  txCancelHex: string,
  lockAddress: string,
  network: 'mainnet' | 'testnet' | 'regtest',
): Promise<TxCancelVerification> {
  const onChainHex = await blockchain.getTransaction(txCancelTxid);
  if (!onChainHex) {
    return { verified: false, reason: 'TxCancel not found on-chain via Electrum' };
  }

  if (onChainHex !== txCancelHex) {
    return {
      verified: false,
      reason: 'Server tx hex does not match on-chain tx — possible tampering',
    };
  }

  const spendsFromLock = verifyTxSpendsFromAddress(onChainHex, lockAddress, network);
  if (!spendsFromLock) {
    return {
      verified: false,
      reason: 'TxCancel does not spend from the expected lock address',
    };
  }

  const height = await blockchain.getTransactionHeight(txCancelTxid);
  if (height <= 0) {
    return {
      verified: false,
      reason:
        height === 0
          ? 'TxCancel is in the mempool but not yet confirmed'
          : 'Could not verify TxCancel block inclusion',
    };
  }

  return {
    verified: true,
    reason: `Confirmed at block height ${String(height)}`,
    txCancelHex: onChainHex,
    txCancelTxid,
    blockHeight: height,
  };
}

// P2WSH inputs don't carry the previous output script. Re-derive the
// P2WSH from the witness script (last witness element) and compare to the
// lock address scriptPubKey.
function verifyTxSpendsFromAddress(
  rawHex: string,
  lockAddress: string,
  network: 'mainnet' | 'testnet' | 'regtest',
): boolean {
  try {
    const tx = bitcoin.Transaction.fromHex(rawHex);
    const btcNetwork = network === 'mainnet' ? bitcoin.networks.bitcoin : (network === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet);

    const expectedOutput = bitcoin.address.toOutputScript(lockAddress, btcNetwork);

    // For each input, the last witness element is the witness script for
    // P2WSH. Re-derive its P2WSH scriptPubKey and compare to the lock.
    for (const input of tx.ins) {
      if (!input.witness || input.witness.length === 0) continue;

      const witnessScript = input.witness[input.witness.length - 1];
      if (!witnessScript || witnessScript.length === 0) continue;

      const p2wsh = bitcoin.payments.p2wsh({
        redeem: { output: witnessScript },
        network: btcNetwork,
      });

      if (
        p2wsh.output &&
        uint8ArrayEquals(new Uint8Array(p2wsh.output), new Uint8Array(expectedOutput))
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

// Belt-and-suspenders: confirm the lock address has no remaining UTXOs
// (the TxCancel actually consumed them).
export async function verifyLockAddressSpent(
  blockchain: BlockchainDataProvider,
  lockAddress: string,
  network: 'mainnet' | 'testnet' | 'regtest',
): Promise<boolean> {
  try {
    const scriptHash = addressToScriptHash(lockAddress, network);
    const utxos = await blockchain.listUnspent(scriptHash);
    return utxos.length === 0;
  } catch {
    return false;
  }
}

// Zero server trust: discover TxCancel by querying the lock address's
// Electrum history. The address has exactly 2 txs (TxLock + TxCancel); filter
// out the known depositTxid, otherwise find the tx that spends FROM the lock.
export async function discoverAndVerifyTxCancel(
  blockchain: BlockchainDataProvider,
  lockAddress: string,
  depositTxid: string,
  network: 'mainnet' | 'testnet' | 'regtest',
): Promise<TxCancelVerification> {
  const scriptHash = addressToScriptHash(lockAddress, network);
  const history = await blockchain.getHistory(scriptHash);

  if (history.length < 2) {
    return {
      verified: false,
      reason: `Lock address has ${String(history.length)} transaction(s) — TxCancel not yet broadcast`,
    };
  }

  let cancelTxid = '';
  let cancelHeight = 0;

  if (depositTxid) {
    const cancelEntry = history.find((entry) => entry.tx_hash !== depositTxid);
    if (cancelEntry) {
      cancelTxid = cancelEntry.tx_hash;
      cancelHeight = cancelEntry.height;
    }
  }

  // No depositTxid: scan history for the tx that spends from the lock.
  if (!cancelTxid) {
    for (const entry of history) {
      const hex = await blockchain.getTransaction(entry.tx_hash);
      if (!hex) continue;
      if (verifyTxSpendsFromAddress(hex, lockAddress, network)) {
        cancelTxid = entry.tx_hash;
        cancelHeight = entry.height;
        break;
      }
    }
  }

  if (!cancelTxid) {
    return {
      verified: false,
      reason: 'Could not identify TxCancel in lock address history',
    };
  }

  if (cancelHeight <= 0) {
    return {
      verified: false,
      reason:
        cancelHeight === 0
          ? 'TxCancel is in the mempool but not yet confirmed'
          : 'TxCancel has unknown confirmation status',
    };
  }

  const rawHex = await blockchain.getTransaction(cancelTxid);
  if (!rawHex) {
    return {
      verified: false,
      reason: 'Could not fetch TxCancel raw transaction from Electrum',
    };
  }

  const spendsFromLock = verifyTxSpendsFromAddress(rawHex, lockAddress, network);
  if (!spendsFromLock) {
    return {
      verified: false,
      reason: 'Transaction found but does not spend from the lock address',
    };
  }

  return {
    verified: true,
    reason: `TxCancel ${cancelTxid.slice(0, 12)}... confirmed at height ${String(cancelHeight)}`,
    txCancelHex: rawHex,
    txCancelTxid: cancelTxid,
    blockHeight: cancelHeight,
  };
}

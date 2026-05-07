// CLI uses Electrum TCP/TLS; browser uses WebSocket Electrum or mempool.space REST.

export interface Utxo {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  // Authoritative; 0 = mempool, positive = confirmed. Provider derives this
  // from its native response (Electrum height, mempool.space status.confirmed).
  readonly confirmations: number;
  /** Raw block height, diagnostics only — do not derive state from it. */
  readonly height?: number;
}

export interface ScriptHashHistoryEntry {
  readonly tx_hash: string;
  readonly height: number;
}

export interface BlockchainDataProvider {
  listUnspent(scriptHash: string): Promise<readonly Utxo[]>;
  getTransaction(txid: string): Promise<string>;
  getTransactionHeight(txid: string): Promise<number>;
  getHistory(scriptHash: string): Promise<readonly ScriptHashHistoryEntry[]>;
  broadcastTransaction(hex: string): Promise<string>;
  estimateFee(blocks: number): Promise<number>;
}

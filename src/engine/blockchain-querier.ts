// Platform-agnostic BTC chain query surface. Node = Electrum (TCP/TLS),
// browser = mempool.space (REST). Used by zero-trust TxCancel verification
// so the engine doesn't bind directly to ElectrumClient.
export interface BlockchainQuerier {
  // Confirmed + mempool transactions for the address.
  getAddressTransactions(
    address: string,
    network: 'mainnet' | 'testnet' | 'regtest',
  ): Promise<readonly TxSummary[]>;

  // Fetch the raw tx ourselves rather than trusting the server's hex.
  getRawTransaction(txid: string): Promise<string | null>;

  // 0 = mempool, -1 = not found.
  getTransactionHeight(txid: string): Promise<number>;
}

export interface TxSummary {
  readonly txid: string;
  readonly height: number; // 0 = mempool, >0 = confirmed
  readonly inputAddresses: readonly string[];
  readonly outputAddresses: readonly string[];
}

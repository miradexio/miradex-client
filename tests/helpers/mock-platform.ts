import type {
  PlatformAdapter,
  DetectedDeposit,
  FeeEstimate,
  KeystoreSaveResult,
  KeystoreMetadata,
} from '../../src/engine/platform.js';
import type { SwapKeystore } from '../../src/lib/keystore.js';
import type { BlockchainQuerier, TxSummary } from '../../src/engine/blockchain-querier.js';
import type { BlockchainDataProvider } from '../../src/interfaces/blockchain.js';
import type { Logger } from '../../src/interfaces/logger.js';

export interface MockPlatformConfig {
  depositToReturn: DetectedDeposit | null;
  feeEstimate: FeeEstimate;
  qrResult: string;
  txCancelVerified: boolean;
  txCancelReason: string;
  txCancelBlockHeight: number;
  addressTransactions: readonly TxSummary[];
}

export interface CapturedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly data: Record<string, unknown>;
  readonly message: string;
}

export interface MockPlatformControls {
  simulateDeposit(deposit: DetectedDeposit): void;
  getStoredKeystores(): Map<string, SwapKeystore>;
  setTxCancelVerified(verified: boolean, reason: string): void;
  setAddressTransactions(txs: readonly TxSummary[]): void;
  setFeeEstimate(fee: FeeEstimate): void;
  getLogs(): readonly CapturedLog[];
  clearLogs(): void;
}

/**
 * In-memory platform adapter for tests.
 * No filesystem, no network, no Electrum.
 */
export function createMockPlatform(
  overrides?: Partial<MockPlatformConfig>,
): PlatformAdapter & MockPlatformControls {
  const keystores = new Map<string, SwapKeystore>();
  const config: MockPlatformConfig = {
    depositToReturn: null,
    feeEstimate: { feeSats: 1400, feeRate: 10 },
    qrResult: 'MOCK_QR_CODE',
    txCancelVerified: true,
    txCancelReason: 'Confirmed at block 800000',
    txCancelBlockHeight: 800000,
    addressTransactions: [],
    ...overrides,
  };

  let depositResolver: ((d: DetectedDeposit) => void) | null = null;
  let keystoreCounter = 0;
  const logs: CapturedLog[] = [];

  const capturingLogger: Logger = {
    debug(data: Record<string, unknown>, message: string): void { logs.push({ level: 'debug', data, message }); },
    info(data: Record<string, unknown>, message: string): void { logs.push({ level: 'info', data, message }); },
    warn(data: Record<string, unknown>, message: string): void { logs.push({ level: 'warn', data, message }); },
    error(data: Record<string, unknown>, message: string): void { logs.push({ level: 'error', data, message }); },
  };

  const mockQuerier: BlockchainQuerier = {
    async getAddressTransactions(): Promise<readonly TxSummary[]> {
      return config.addressTransactions;
    },
    async getRawTransaction(): Promise<string | null> {
      return 'deadbeef';
    },
    async getTransactionHeight(): Promise<number> {
      return config.txCancelBlockHeight;
    },
  };

  return {
    watchDeposit: async (_addr, _net, signal, onStatus) => {
      if (config.depositToReturn) return config.depositToReturn;
      onStatus?.('Waiting for deposit...');
      return new Promise<DetectedDeposit>((resolve, reject) => {
        depositResolver = resolve;
        signal.addEventListener('abort', () => reject(new Error('Aborted')));
      });
    },

    checkDeposit: async () => config.depositToReturn,
    fetchUtxo: async () => config.depositToReturn,
    estimateFee: async () => config.feeEstimate,

    saveKeystore: async (ks: SwapKeystore, _label: string): Promise<KeystoreSaveResult> => {
      keystoreCounter++;
      const id = `test-keystore-${keystoreCounter}`;
      keystores.set(id, ks);
      return { id };
    },

    loadKeystore: async (id: string): Promise<SwapKeystore> => {
      const ks = keystores.get(id);
      if (!ks) throw new Error(`Keystore ${id} not found`);
      return ks;
    },

    listKeystores: async (): Promise<readonly KeystoreMetadata[]> => {
      return [...keystores.entries()].map(([id, ks]) => ({
        id,
        btcAddress: ks.btc.address,
        destAddress: ks.swap.receiveAddress,
        refundAddress: ks.swap.refundAddress,
        amount: '0',
        network: ks.btc.network as 'mainnet' | 'testnet',
        status: 'created' as const,
        depositTxid: null,
        depositValue: null,
        swapId: null,
        createdAt: ks.createdAt,
      }));
    },
    deleteKeystore: async (): Promise<void> => {},

    generateQr: async (): Promise<string> => config.qrResult,
    broadcastTx: async (): Promise<string> => 'mock-txid',

    createBlockchainQuerier: (): BlockchainQuerier => mockQuerier,

    createBlockchainProvider: async (): Promise<BlockchainDataProvider> => ({
      listUnspent: async () => [],
      getTransaction: async () => 'deadbeef',
      getTransactionHeight: async () => config.txCancelBlockHeight,
      getHistory: async () => [],
      broadcastTransaction: async () => 'mock-txid',
      estimateFee: async () => 10,
    }),

    logger: capturingLogger,

    // ── Control methods ────────────────────────────────────────────
    simulateDeposit: (deposit: DetectedDeposit): void => {
      config.depositToReturn = deposit;
      depositResolver?.(deposit);
      depositResolver = null;
    },
    getStoredKeystores: (): Map<string, SwapKeystore> => new Map(keystores),
    setTxCancelVerified: (verified: boolean, reason: string): void => {
      config.txCancelVerified = verified;
      config.txCancelReason = reason;
    },
    setAddressTransactions: (txs: readonly TxSummary[]): void => {
      config.addressTransactions = txs;
    },
    setFeeEstimate: (fee: FeeEstimate): void => {
      config.feeEstimate = fee;
    },
    getLogs: (): readonly CapturedLog[] => [...logs],
    clearLogs: (): void => { logs.length = 0; },
  } as PlatformAdapter & MockPlatformControls;
}

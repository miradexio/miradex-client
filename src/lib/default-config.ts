// Single home for hardcoded defaults so individual modules don't carry
// magic strings. Add new infrastructure defaults here.

export const API_URL = 'http://127.0.0.1:7001/';
export const API_TOR_URL = 'http://miradextor.onion:7001';
export const API_TIMEOUT_MS = 30_000;
export const API_MAX_RETRIES = 3;
export const API_RETRY_BASE_MS = 1_000;

export const TOR_SOCKS_PROXY = 'socks5://127.0.0.1:9050';
// IANA-unassigned private port. Picked deliberately to avoid collisions with
// Feather Wallet (19_450), system Tor (9_050), and other common dev services.
export const TOR_MANAGED_PORT = 47_652;
export const TOR_EXTERNAL_PORT = 9_050;
export const TOR_MODE: 'external' | 'bundled' = 'bundled';

export interface ElectrumServerEntry {
  readonly host: string;
  readonly port: number;
  readonly ssl: boolean;
}

/** Primary Electrum server URL (used in config schema default). */
export const ELECTRUM_PRIMARY_URL = 'ssl://electrum.blockstream.info:50002';

/** Testnet Electrum server URL. */
export const ELECTRUM_TESTNET_URL = 'ssl://electrum.blockstream.info:60002';

export function electrumUrlForNetwork(
  configuredUrl: string,
  network: 'mainnet' | 'testnet' | 'regtest',
): string {
  // Respect a user-configured server regardless of network.
  if (configuredUrl !== ELECTRUM_PRIMARY_URL) return configuredUrl;
  return network === 'testnet' ? ELECTRUM_TESTNET_URL : configuredUrl;
}

/** Ordered list of Electrum servers. First entry is the primary. */
export const ELECTRUM_SERVERS: readonly ElectrumServerEntry[] = [
  { host: 'electrum.blockstream.info', port: 50002, ssl: true },
  { host: 'electrum.eigenwallet.org', port: 22293, ssl: false },
  { host: 'bitcoin.stackwallet.com', port: 50002, ssl: true },
  { host: 'b.1209k.com', port: 50002, ssl: true },
  { host: 'mainnet.foundationdevices.com', port: 50002, ssl: true },
  { host: 'bitcoin.lu.ke', port: 50001, ssl: false },
  { host: 'electrum.coinfinity.co', port: 50002, ssl: true },
  { host: 'electrum1.bluewallet.io', port: 50001, ssl: false },
  { host: 'electrum2.bluewallet.io', port: 50001, ssl: false },
  { host: 'electrum3.bluewallet.io', port: 50001, ssl: false },
  { host: 'btc-electrum.cakewallet.com', port: 50002, ssl: true },
  { host: 'bitcoin.aranguren.org', port: 50001, ssl: false },
];

export const ELECTRUM_CONNECT_TIMEOUT_MS = 8_000;
export const ELECTRUM_REQUEST_TIMEOUT_MS = 10_000;

/** Chain the node list applies to. */
export type DefaultNodeBlockchain = 'bitcoin' | 'monero';

// Browser-hit directly: real-money swaps must not trust a single server-side
// proxy. Every entry probed 2026-05 to confirm CORS *, mainnet nettype, valid
// TLS. Stagenet/testnet runs through the crypto-server proxy
// (apps/crypto-server/src/swap/routes/monero-proxy.routes.ts); mainnet does not.
export const MONERO_MAINNET_NODES: readonly string[] = [
  'https://node.sethforprivacy.com',
  'https://node.sethforprivacy.com:443',
  'https://dewitte.fiatfaucet.com',
  'https://chad.fiatfaucet.com',
  'https://kowalski.fiatfaucet.com',
  'https://connect.xmr-node.org',
  'https://connect.xmr-node.org:443',
  'https://monerod.not.futbol',
  'https://xmr.0xrpc.io',
  'https://xmr.jayjonkman.nl:18089',
  'https://monero.definitelynotafed.com',
  'https://monero.definitelynotafed.com:443',
  'https://xmr1.doggett.tech:18089',
  'https://xmr2.doggett.tech:18089',
  'https://xmr3.doggett.tech:18089',
  'https://xmr4.doggett.tech:18089',
  'https://xmr5.doggett.tech:18089',
  'https://public-monero-node.xyz',
  'https://public-monero-node.xyz:443',
  'https://xmr.hexide.com',
  'https://xmr.greyfox.tech:443',
  'https://xmr-node.cakewallet.com:18081',
  'https://xmr.surveillance.monster',
  'https://node.xmr.surf',
  'https://xmr.thinhhv.com:443',
  'https://xmr.unshakled.net',
  'https://xmr.unshakled.net:443',
  'https://xmr.cryptostorm.is:18081',
  'https://xmr.qu.ax:443',
  'https://monero-rpc.cheems.de.box.skhron.com.ua:18089',
  'https://xmr.letmego.me',
  'https://xmr.letmego.me:443',
  'https://xmr.ci.vet:443',
  'https://xmr.winslow.cloud:18089',
  'https://xmr.visnova.pl',
  'https://monero.openinternet.io',
  'https://xmr.support:18089',
];

// Monero's public testnet equivalent.
export const MONERO_STAGENET_NODES: readonly string[] = [
  'https://node.sethforprivacy.com:38089',

  'https://testnet.miradex.io/api/v1/swap/proxy/monero/stagenet',
  'https://testnet.miradex.io/api/v1/swap/proxy/monero/stagenet'
];

// scheme://host:port form, accepted directly by Electrum / monerod clients.
// Monero `testnet` key holds stagenet endpoints (Monero has no Bitcoin-style testnet).
export const DEFAULT_NODES: Readonly<
  Record<'mainnet' | 'testnet' | 'regtest', Readonly<Record<DefaultNodeBlockchain, readonly string[]>>>
> = {
  testnet: {
    bitcoin: [
      'ssl://blackie.c3-soft.com:57006',
      'ssl://v22019051929289916.bestsrv.de:50002',
      'tcp://v22019051929289916.bestsrv.de:50001',
      'ssl://electrum.blockstream.info:60002',
      'ssl://blockstream.info:993',
      'tcp://testnet.aranguren.org:51001',
      'ssl://testnet.aranguren.org:51002',
      'ssl://bitcoin.devmole.eu:5010',
      'tcp://bitcoin.devmole.eu:5000',
    ],
    monero: MONERO_STAGENET_NODES,
  },
  mainnet: {
    bitcoin: [
      'tcp://electrum.eigenwallet.org:22293',
      'ssl://electrum.blockstream.info:50002',
      'ssl://bitcoin.stackwallet.com:50002',
      'ssl://b.1209k.com:50002',
      'ssl://mainnet.foundationdevices.com:50002',
      'tcp://bitcoin.lu.ke:50001',
      'ssl://electrum.coinfinity.co:50002',
      'tcp://electrum1.bluewallet.io:50001',
      'tcp://electrum2.bluewallet.io:50001',
      'tcp://electrum3.bluewallet.io:50001',
      'ssl://btc-electrum.cakewallet.com:50002',
      'tcp://bitcoin.aranguren.org:50001',
    ],
    monero: MONERO_MAINNET_NODES,
  },
  regtest: {
    bitcoin: [],
    monero: [],
  },
} as const;

export const MEMPOOL_API = 'https://mempool.space/api';
export const MEMPOOL_TESTNET_API = 'https://mempool.space/testnet/api';

// 1-in P2WPKH -> 1-out P2WSH. Header(10.5) + input(68) + output(43) ~= 122 vb;
// rounded up to 130 for signature-size variance.
export const LOCK_TX_VBYTES = 130;

/** Fallback feerate when all fee sources are unreachable (sat/vbyte). */
export const FALLBACK_FEE_RATE = 10;

// Bitcoin Core defaults minrelaytxfee to 1.0, but many public/testnet nodes
// raise it to 1.5-3.0. Below 3 produces sporadic "min relay fee not met"
// rejections that force a re-sign; 3 sat/vB covers every sane policy.
export const MIN_FEE_RATE = 3;

// +25% headroom on the estimate, to cover mempool changes between estimate
// at deposit-time and broadcast at fund-time.
export const FEE_MARGIN_MULTIPLIER = 1.25;

// Sanity ceiling. Testnet halfHourFee oracles routinely return absurd
// values (>250 sat/vB on a chain where 1 sat/vB confirms in a block); without
// a cap a misbehaving oracle can drive the lock-tx fee above the deposit.
// Mainnet ceiling sits above historical peaks so it only catches oracle bugs.
export const MAX_FEE_RATE_MAINNET = 100;
export const MAX_FEE_RATE_TESTNET = 10;

export const DEPOSIT_POLL_MS = 5_000;
export const FUNDING_POLL_MS = 5_000;
export const FUNDING_TIMEOUT_MS = 300_000;
export const FUNDING_SETTLE_MS = 15_000;
export const SWEEP_POLL_MS = 30_000;
export const SWEEP_TIMEOUT_MS = 3_600_000;
export const POW_MAX_RETRIES = 3;
export const POW_BACKOFF_MS = 2_000;

export const DEFAULT_SLIPPAGE_BPS = 300;
export const DEFAULT_MAX_DEVIATION_BPS = 300;
export const DEFAULT_FROM_TOKEN = 'BTC';
export const DEFAULT_TO_TOKEN = 'XMR';
export const DEFAULT_FIAT = 'USD';

// BTC
export const BTC_P2WPKH_INPUT_VBYTES = 68n;
export const BTC_P2WSH_INPUT_VBYTES = 76n;
export const BTC_TX_OVERHEAD_VBYTES = 42n;
export const BTC_VBYTES_SINGLE_IN_SINGLE_OUT = 154n;
export const BTC_VBYTES_SINGLE_IN_TWO_OUT = 187n;

// Bitcoin Electrum
export const ELECTRUM_DEFAULT_SSL_PORT = 50_002;
export const ELECTRUM_DEFAULT_TCP_PORT = 50_001;
export const ELECTRUM_QUORUM = 2;

// Verification
export const VERIFY_MAX_ATTEMPTS = 12;
export const VERIFY_RETRY_DELAY_MS = 5_000;
export const VERIFY_FETCH_TIMEOUT_MS = 10_000;
export const BROADCAST_TIMEOUT_MS = 10_000;

// Deposit safety
export const MAX_DEPOSIT_UTXOS = 10;

// XMR / Monero
export const MIN_XMR_CONFIRMATIONS = 10;
export const MONERO_RING_SIZE = 16;
export const MONERO_PRE_CLSAG_RING_SIZE = 11;
export const MONERO_FETCH_TIMEOUT_MS = 15_000;
export const MONERO_QUORUM = 2;
export const MONERO_SWEEP_MAX_ATTEMPTS = 5;
export const MONERO_SWEEP_MAX_RING_RETRIES = 5;
export const MONERO_TX_SIZE_ESTIMATE = 3_200;
export const MONERO_FALLBACK_FEE_PER_BYTE = 23_000n;
export const MONERO_MIN_FEE_PICONEROS = 10n;
export const MONERO_MAX_FEE_RATIO_BPS = 1_000;

// PoW
export const POW_BATCH_YIELD_SIZE = 10_000;

// Engine bounds (Fix 8.4.8)
export const ENGINE_SLIPPAGE_MIN_BPS = 10;
export const ENGINE_SLIPPAGE_MAX_BPS = 500;
export const ENGINE_POLL_MIN_MS = 100;
export const ENGINE_POLL_MAX_MS = 30_000;
export const ENGINE_RETRY_MIN = 1;
export const ENGINE_RETRY_MAX = 10;

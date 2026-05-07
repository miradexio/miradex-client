import { validateBase58Check, validateXrpAddress } from './base58.js';
import { validateBech32 } from './bech32.js';
import { validateEvmAddress } from './evm.js';
import { validateSolanaAddress } from './solana.js';
import { validateMoneroAddress } from './monero.js';
import { validateTonAddress } from './ton.js';
import { validatePolkadotAddress } from './polkadot.js';

export interface ValidationResult {
  readonly valid: boolean;
  readonly reason?: string;
}

type Validator = (address: string) => ValidationResult;

const CHAIN_VALIDATORS: Record<string, Validator> = {
  // BTC: bech32 or base58check — mainnet and testnet
  bitcoin: (addr) => {
    if (addr.startsWith('bc1')) return validateBech32(addr, 'bc');
    if (addr.startsWith('tb1')) return validateBech32(addr, 'tb');
    // Mainnet: 1..=0x00, 3..=0x05 | Testnet: m/n=0x6f, 2=0xc4
    return validateBase58Check(addr, [0x00, 0x05, 0x6f, 0xc4]);
  },

  // EVM chains — all share EIP-55
  ethereum: validateEvmAddress,
  bsc: validateEvmAddress,
  polygon: validateEvmAddress,
  arbitrum: validateEvmAddress,
  avalanche: validateEvmAddress,
  base: validateEvmAddress,

  // Litecoin: bech32 (ltc1) or base58check (L=0x30, M=0x32, 3=0x05)
  litecoin: (addr) => {
    if (addr.startsWith('ltc1')) return validateBech32(addr, 'ltc');
    return validateBase58Check(addr, [0x30, 0x32, 0x05]);
  },

  // Bitcoin Cash: legacy base58check (same as BTC) or cashaddr
  bitcoincash: (addr) => {
    if (addr.startsWith('bitcoincash:') || addr.startsWith('q') || addr.startsWith('p')) {
      // CashAddr — basic format check (full cashaddr decode is complex)
      const stripped = addr.replace('bitcoincash:', '');
      if (/^[qp][0-9a-z]{41}$/.test(stripped)) return { valid: true };
      return { valid: false, reason: 'Invalid cashaddr format' };
    }
    return validateBase58Check(addr, [0x00, 0x05]);
  },

  solana: validateSolanaAddress,
  monero: validateMoneroAddress,

  // Tron: base58check starting with T (version byte 0x41)
  tron: (addr) => validateBase58Check(addr, [0x41]),

  ton: validateTonAddress,
  polkadot: validatePolkadotAddress,

  // Cosmos: bech32 with "cosmos" HRP
  cosmos: (addr) => validateBech32(addr, 'cosmos'),

  // THORChain: bech32 with "thor" HRP
  thorchain: (addr) => validateBech32(addr, 'thor'),

  xrp: validateXrpAddress,

  // Dogecoin: base58check (D=0x1e, 9/A=0x16)
  dogecoin: (addr) => validateBase58Check(addr, [0x1e, 0x16]),

  // Dash: base58check (X=0x4c, 7=0x10)
  dash: (addr) => validateBase58Check(addr, [0x4c, 0x10]),

  // Zcash: bech32 (zs1) or base58check (t1=0x1cb8, t3=0x1cbd)
  zcash: (addr) => {
    if (addr.startsWith('zs1')) return validateBech32(addr, 'zs');
    // Zcash transparent uses 2-byte version prefixes
    // t1... = mainnet P2PKH, t3... = mainnet P2SH
    if (addr.startsWith('t1') || addr.startsWith('t3')) {
      return validateBase58Check(addr, [0x1c]); // first byte of 2-byte version
    }
    return { valid: false, reason: 'Zcash address must start with t1, t3, or zs1' };
  },
};

const TOKEN_TO_CHAIN: Record<string, string> = {
  BTC: 'bitcoin',
  'BTC-LN': 'bitcoin',
  ETH: 'ethereum',
  USDT: 'ethereum',
  USDC: 'ethereum',
  DAI: 'ethereum',
  WBTC: 'ethereum',
  LTC: 'litecoin',
  BCH: 'bitcoincash',
  SOL: 'solana',
  BNB: 'bsc',
  POL: 'polygon',
  ARB: 'arbitrum',
  TRX: 'tron',
  TON: 'ton',
  DOT: 'polkadot',
  AVAX: 'avalanche',
  ATOM: 'cosmos',
  XRP: 'xrp',
  DOGE: 'dogecoin',
  DASH: 'dash',
  RUNE: 'thorchain',
  ZEC: 'zcash',
  XMR: 'monero',
};

// Pure function; works identically in Node and browser.
export function validateAddress(address: string, tokenOrChain: string): ValidationResult {
  if (!address || !address.trim()) return { valid: false, reason: 'Address is empty' };

  const chain = resolveChain(tokenOrChain);
  const validator = CHAIN_VALIDATORS[chain];

  if (!validator) {
    // Unknown chain: accept any non-empty address.
    return { valid: true };
  }

  return validator(address.trim());
}

export function resolveChain(tokenOrChain: string): string {
  return TOKEN_TO_CHAIN[tokenOrChain.toUpperCase()] ?? tokenOrChain.toLowerCase();
}

export function getSupportedChains(): readonly string[] {
  return Object.keys(CHAIN_VALIDATORS);
}

const CHAIN_TO_TOKENS: Record<string, readonly string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [token, chain] of Object.entries(TOKEN_TO_CHAIN)) {
    if (!out[chain]) out[chain] = [];
    out[chain].push(token);
  }
  // Base shares stablecoins with Ethereum; surface the common set so the
  // address-book/picker doesn't render an empty Tokens column.
  if (!out['base']) out['base'] = ['ETH', 'USDC'];
  return out;
})();

// Tokens commonly received on a given chain. Drives the Tokens column in the
// address book without per-row tagging.
export function tokensForChain(chain: string): readonly string[] {
  return CHAIN_TO_TOKENS[resolveChain(chain)] ?? [];
}

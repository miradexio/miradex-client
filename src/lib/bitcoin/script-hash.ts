// Electrum indexes by SHA256(scriptPubKey), byte-reversed, hex-encoded.
// Uses @noble/hashes (not node:crypto) for browser compatibility.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as bitcoin from 'bitcoinjs-lib';

export function addressToScriptHash(
  address: string,
  network: 'mainnet' | 'testnet' | 'regtest' = 'mainnet',
): string {
  const net = network === 'mainnet' ? bitcoin.networks.bitcoin : (network === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet);
  const outputScript = bitcoin.address.toOutputScript(address, net);
  const hash = sha256(outputScript);
  const reversed = new Uint8Array(hash);
  reversed.reverse();
  return bytesToHex(reversed);
}

export interface ElectrumServer {
  readonly host: string;
  readonly port: number;
  readonly ssl: boolean;
}

export function parseElectrumUrl(url: string): ElectrumServer {
  const sslMatch = url.match(/^ssl:\/\/([^:]+):(\d+)/);
  if (sslMatch) {
    return { host: sslMatch[1] ?? '', port: parseInt(sslMatch[2] ?? '50002', 10), ssl: true };
  }
  const tcpMatch = url.match(/^tcp:\/\/([^:]+):(\d+)/);
  if (tcpMatch) {
    return { host: tcpMatch[1] ?? '', port: parseInt(tcpMatch[2] ?? '50001', 10), ssl: false };
  }
  return { host: url, port: 50002, ssl: true };
}

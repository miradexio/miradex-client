import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KEYGEN_WASM_SHA256,
  MONERO_SWEEP_WASM_SHA256,
  SWAP_WASM_SHA256,
} from '../../../src/wasm-pins.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('wasm-pins', () => {
  it('SWAP_WASM_SHA256 matches the committed unified binary', () => {
    const actual = sha(join(root, 'wasm/miradex-rust/miradex_rust_bg.wasm'));
    expect(actual).toBe(SWAP_WASM_SHA256);
  });

  it('legacy KEYGEN_WASM_SHA256 alias equals SWAP_WASM_SHA256', () => {
    expect(KEYGEN_WASM_SHA256).toBe(SWAP_WASM_SHA256);
  });

  it('legacy MONERO_SWEEP_WASM_SHA256 alias equals SWAP_WASM_SHA256', () => {
    expect(MONERO_SWEEP_WASM_SHA256).toBe(SWAP_WASM_SHA256);
  });

  it('pins are 64-char lowercase hex', () => {
    expect(SWAP_WASM_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(KEYGEN_WASM_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(MONERO_SWEEP_WASM_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

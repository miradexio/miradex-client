import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SWAP_WASM_SHA256 } from '../../../src/wasm-pins.js';
import {
  __resetWasmCache,
  ensureWasm,
} from '../../../src/lib/crypto/wasm.js';
import { WasmError } from '../../../src/lib/crypto/errors.js';

beforeEach(() => {
  __resetWasmCache();
});

afterEach(() => {
  __resetWasmCache();
});

describe('miradex-rust integrity pin', () => {
  it('SWAP_WASM_SHA256 matches the committed binary', () => {
    const wasmUrl = new URL(
      '../../../wasm/miradex-rust/miradex_rust_bg.wasm',
      import.meta.url,
    );
    const bytes = readFileSync(fileURLToPath(wasmUrl));
    const actual = createHash('sha256').update(bytes).digest('hex');
    expect(actual).toBe(SWAP_WASM_SHA256);
  });

  it('ensureWasm rejects tampered bytes when verifyIntegrity is on', async () => {
    const wasmUrl = new URL(
      '../../../wasm/miradex-rust/miradex_rust_bg.wasm',
      import.meta.url,
    );
    const bytes = new Uint8Array(readFileSync(fileURLToPath(wasmUrl)));
    const tampered = new Uint8Array(bytes);
    tampered[100] ^= 1;

    await expect(
      ensureWasm({ verifyIntegrity: true, overrideBytes: tampered }),
    ).rejects.toBeInstanceOf(WasmError);
  });
});

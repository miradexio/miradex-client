import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetWasmCache,
  ensureWasm,
  generateClientKeys,
  isKeygenAvailable,
} from '../../../src/lib/crypto/wasm.js';
import { WasmError } from '../../../src/lib/crypto/errors.js';

beforeEach(() => {
  __resetWasmCache();
});

afterEach(() => {
  __resetWasmCache();
});

describe('ensureWasm', () => {
  it('is idempotent', async () => {
    await ensureWasm();
    expect(isKeygenAvailable()).toBe(true);
    await ensureWasm();
    expect(isKeygenAvailable()).toBe(true);
  });

  it('deduplicates concurrent calls', async () => {
    const [a, b] = await Promise.all([ensureWasm(), ensureWasm()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(isKeygenAvailable()).toBe(true);
  });

  it('rejects tampered bytes when verifyIntegrity=true', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const url = new URL(
      '../../../wasm/miradex-rust/miradex_rust_bg.wasm',
      import.meta.url,
    );
    const real = new Uint8Array(await readFile(fileURLToPath(url)));
    const tampered = new Uint8Array(real);
    tampered[100] ^= 0x01;

    await expect(
      ensureWasm({ verifyIntegrity: true, overrideBytes: tampered }),
    ).rejects.toBeInstanceOf(WasmError);
  });

  it('accepts matching bytes when verifyIntegrity=true', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const url = new URL(
      '../../../wasm/miradex-rust/miradex_rust_bg.wasm',
      import.meta.url,
    );
    const bytes = new Uint8Array(await readFile(fileURLToPath(url)));

    await expect(
      ensureWasm({ verifyIntegrity: true, overrideBytes: bytes }),
    ).resolves.toBeUndefined();
    expect(isKeygenAvailable()).toBe(true);
  });

  it('generateClientKeys throws before ensureWasm', () => {
    expect(() => generateClientKeys()).toThrowError(WasmError);
  });

  it('generateClientKeys returns a parsed bundle after ensureWasm', async () => {
    await ensureWasm();
    const keys = generateClientKeys();
    expect(keys.s_b_bitcoin).toMatch(/^[0-9a-f]+$/);
    expect(keys.B).toMatch(/^[0-9a-f]{66}$/);
  });
});

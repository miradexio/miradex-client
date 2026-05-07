#!/usr/bin/env node
// Verify wasm/miradex-rust/miradex_rust_bg.wasm matches the SHA256 pinned in
// src/wasm-pins.ts. Exit 0 on match, non-zero on mismatch.
//
// Use case: a paranoid auditor clones the repo, runs `pnpm run build:wasm`
// (which builds from miradex-rust/ and re-pins), then `pnpm run verify-wasm`
// confirms the freshly-built binary matches what's published. If you suspect
// drift, run `pnpm run verify-wasm` *without* rebuilding to compare the
// committed binary against the committed pin.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const WASM_PATH = join(root, 'wasm/miradex-rust/miradex_rust_bg.wasm');
const PINS_PATH = join(root, 'src/wasm-pins.ts');

const actual = createHash('sha256').update(readFileSync(WASM_PATH)).digest('hex');

const pinsSrc = readFileSync(PINS_PATH, 'utf8');
const match = pinsSrc.match(/SWAP_WASM_SHA256\s*=\s*"([0-9a-f]{64})"/);
if (!match) {
  console.error(`could not parse SWAP_WASM_SHA256 from ${PINS_PATH}`);
  process.exit(2);
}
const expected = match[1];

if (actual === expected) {
  console.log(`ok: ${WASM_PATH} matches pin ${expected}`);
  process.exit(0);
}

console.error(
  `mismatch:\n  expected (src/wasm-pins.ts): ${expected}\n  actual   (built wasm):       ${actual}`,
);
process.exit(1);

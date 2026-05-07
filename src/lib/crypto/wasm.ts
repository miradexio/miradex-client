// `await ensureWasm()` once at the entry of an atomic-swap flow, then call
// the sync wrappers below. Thorchain / Chainflip / NEAR-Intents verification
// never touches this file, so non-atomicswap providers don't load the binary.

import { z } from 'zod';
import { detectPlatform, type Platform } from './platform.js';
import { WasmError } from './errors.js';
import type { WasmModule } from './types.js';
import { SWAP_WASM_SHA256 } from '../../wasm-pins.js';
import type { ClientKeys } from '../../types/index.js';

let cached: WasmModule | null = null;
let initInFlight: Promise<WasmModule> | null = null;

export interface EnsureWasmOptions {
  // Hash the bytes and compare against SWAP_WASM_SHA256. Defaults to the
  // value of process.env.MIRADEX_VERIFY_WASM === '1'.
  readonly verifyIntegrity?: boolean;
  // Override the platform reader (e.g. browser with a non-default asset path).
  // Ignored when overrideBytes is set.
  readonly loadBytes?: () => Promise<Uint8Array>;
  // Required on React Native (no platform reader available).
  readonly overrideBytes?: Uint8Array;
}

export async function ensureWasm(options?: EnsureWasmOptions): Promise<void> {
  if (cached) return;
  if (initInFlight) {
    await initInFlight;
    return;
  }

  initInFlight = (async (): Promise<WasmModule> => {
    const platform = detectPlatform();
    let bytes: Uint8Array;

    if (options?.overrideBytes) {
      bytes = options.overrideBytes;
    } else if (options?.loadBytes) {
      bytes = await options.loadBytes();
    } else {
      bytes = await readBytes(platform);
    }

    if (shouldVerifyIntegrity(options)) {
      await verifyIntegrity(bytes);
    }

    const mod = await instantiate(bytes);
    cached = mod;
    return mod;
  })();

  try {
    await initInFlight;
  } catch (err) {
    initInFlight = null;
    if (err instanceof WasmError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new WasmError('E_WASM_INIT', `ensureWasm failed: ${message}`, err);
  } finally {
    initInFlight = null;
  }
}

function getModule(): WasmModule {
  if (!cached) {
    throw new WasmError(
      'E_WASM_NOT_LOADED',
      'ensureWasm() must be called before this operation',
    );
  }
  return cached;
}

function shouldVerifyIntegrity(opts: EnsureWasmOptions | undefined): boolean {
  if (opts?.verifyIntegrity !== undefined) return opts.verifyIntegrity;
  return typeof process !== 'undefined' && process.env['MIRADEX_VERIFY_WASM'] === '1';
}

async function readBytes(platform: Platform): Promise<Uint8Array> {
  switch (platform) {
    case 'node':
    case 'electron-main':
      return readBytesNode();
    case 'browser':
    case 'electron-renderer':
    case 'worker':
      return readBytesBrowser();
    case 'react-native':
      throw new WasmError(
        'E_WASM_RN_REQUIRES_BYTES',
        'React Native requires explicit bytes via ensureWasm({ overrideBytes })',
      );
    case 'unknown':
    default:
      throw new WasmError(
        'E_WASM_PLATFORM_UNKNOWN',
        `cannot detect platform for WASM loading (got ${platform})`,
      );
  }
}

async function readBytesNode(): Promise<Uint8Array> {
  const [{ readFile }, { fileURLToPath }] = await Promise.all([
    import('node:fs/promises'),
    import('node:url'),
  ]);
  const url = new URL(
    '../../../wasm/miradex-rust/miradex_rust_bg.wasm',
    import.meta.url,
  );
  const buffer = await readFile(fileURLToPath(url));
  return new Uint8Array(buffer);
}

async function readBytesBrowser(): Promise<Uint8Array> {
  const wasmUrl = new URL(
    '../../../wasm/miradex-rust/miradex_rust_bg.wasm',
    import.meta.url,
  );
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new WasmError('E_WASM_FETCH', `fetch ${wasmUrl.href} returned ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function verifyIntegrity(bytes: Uint8Array): Promise<void> {
  const [{ sha256 }, { bytesToHex }] = await Promise.all([
    import('@noble/hashes/sha2.js'),
    import('@noble/hashes/utils.js'),
  ]);
  const actual = bytesToHex(sha256(bytes));
  if (actual !== SWAP_WASM_SHA256) {
    throw new WasmError(
      'E_WASM_INTEGRITY',
      `swap-wasm integrity check failed: expected ${SWAP_WASM_SHA256}, got ${actual}`,
    );
  }
}

async function instantiate(bytes: Uint8Array): Promise<WasmModule> {
  // Relative import: wasm ships inside this package's tarball under
  // wasm/miradex-rust/. A separate npm package would need a file: dep that
  // pnpm resolves relative to the consumer, breaking workspace installs.
  const wasmBindgen = (await import(
    '../../../wasm/miradex-rust/miradex_rust.js'
  )) as unknown as {
    readonly default: (input: { module_or_path: Uint8Array }) => Promise<unknown>;
  } & WasmModule;
  await wasmBindgen.default({ module_or_path: bytes });
  return wasmBindgen;
}

// initKeygen is the testing seam; production code reaches the cache via ensureWasm.
export function isKeygenAvailable(): boolean {
  return cached !== null;
}
export function initKeygen(mod: WasmModule): void {
  cached = mod;
}

// Sync wrappers below: callers must await ensureWasm() first.

const ClientKeysSchema = z.object({
  s_b_bitcoin: z.string(),
  s_b_monero: z.string(),
  s_b: z.string(),
  dleq_proof: z.string(),
  v_b: z.string(),
  b: z.string(),
  B: z.string(),
});

function parseClientKeys(jsonStr: string): ClientKeys {
  const parsed = ClientKeysSchema.safeParse(JSON.parse(jsonStr));
  if (!parsed.success) {
    throw new WasmError(
      'E_CLIENT_KEYS_SHAPE',
      `Invalid key format from WASM: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function generateClientKeys(): ClientKeys {
  return parseClientKeys(getModule().generate_client_keys());
}

export function generateClientKeysFromSeed(
  sBHex: string,
  vBHex: string,
  bHex: string,
): ClientKeys {
  return parseClientKeys(getModule().generate_client_keys_from_seed(sBHex, vBHex, bHex));
}

export function verifyDleqProof(
  sBitcoinHex: string,
  sMoneroHex: string,
  proofHex: string,
): boolean {
  return getModule().verify_dleq_proof(sBitcoinHex, sMoneroHex, proofHex);
}

export function signDigest(bHex: string, digestHex: string): string {
  return getModule().sign_digest(bHex, digestHex);
}

export function encsignDigest(
  bHex: string,
  encryptionKeyHex: string,
  digestHex: string,
): string {
  return getModule().encsign_digest(bHex, encryptionKeyHex, digestHex);
}

export function decryptSignature(scalarHex: string, encsigHex: string): string {
  return getModule().decrypt_signature(scalarHex, encsigHex);
}

export function verifyEncsig(
  verificationKeyHex: string,
  encryptionKeyHex: string,
  digestHex: string,
  encsigHex: string,
): boolean {
  return getModule().verify_encsig(verificationKeyHex, encryptionKeyHex, digestHex, encsigHex);
}

export function recoverAdaptorScalar(
  sigHex: string,
  encsigHex: string,
  encryptionKeyHex: string,
): string {
  return getModule().recover_adaptor_scalar(sigHex, encsigHex, encryptionKeyHex);
}

export function deriveKeyImages(
  outputsJson: string,
  viewKeyHex: string,
  spendKeyHex: string,
): string {
  return getModule().derive_key_images(outputsJson, viewKeyHex, spendKeyHex);
}

export function selectDecoys(
  realOutputIndex: number,
  distributionJson: string,
  ringSize: number,
): string {
  return getModule().select_decoys(BigInt(realOutputIndex), distributionJson, ringSize);
}

export function signSweepTx(
  constructionDataJson: string,
  spendKeyHex: string,
  viewKeyHex: string,
): string {
  return getModule().sign_sweep_tx(constructionDataJson, spendKeyHex, viewKeyHex);
}

export function computeCommitmentMask(
  viewKeyHex: string,
  txPublicKeyHex: string,
  outputIndex: number,
): string {
  return getModule().compute_commitment_mask(viewKeyHex, txPublicKeyHex, BigInt(outputIndex));
}

export function verifyCommitment(
  viewKeyHex: string,
  txPublicKeyHex: string,
  outputIndex: number,
  amount: bigint,
  onChainCommitmentHex: string,
): boolean {
  return getModule().verify_commitment(
    viewKeyHex,
    txPublicKeyHex,
    BigInt(outputIndex),
    BigInt(amount),
    onChainCommitmentHex,
  );
}

export function decryptAmount(
  viewKeyHex: string,
  txPublicKeyHex: string,
  outputIndex: number,
  encryptedAmountHex: string,
): bigint {
  return getModule().decrypt_amount(
    viewKeyHex,
    txPublicKeyHex,
    BigInt(outputIndex),
    encryptedAmountHex,
  );
}

export function secp256k1ScalarToEd25519(secpScalarHex: string): string {
  return getModule().secp256k1_scalar_to_ed25519(secpScalarHex);
}

export function ed25519ScalarAdd(scalarAHex: string, scalarBHex: string): string {
  return getModule().ed25519_scalar_add(scalarAHex, scalarBHex);
}

// Test-only.
export function __resetWasmCache(): void {
  cached = null;
  initInFlight = null;
}

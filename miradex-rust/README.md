# miradex-rust

Rust source for the BTC/XMR atomic-swap cryptographic primitives used by
[`@miradexio/client`](..). Builds to a WebAssembly module that is consumed by
the TypeScript SDK at runtime.

This crate is the source of truth. The shipped binary lives at
`../wasm/miradex-rust/` and is checked into the repo so that ordinary
contributors don't need a Rust toolchain to work on `@miradexio/client`.

## Build the wasm

From the `miradex-client/` package root (one level up):

```
pnpm run build:wasm
```

That runs `miradex-rust/scripts/build-wasm.sh` and then `pin-wasm`, which
re-hashes the resulting binary into `src/wasm-pins.ts`.

## Reproducing the published binary

Anyone with these tools can rebuild bit-identically and verify the SHA256
they get matches the one pinned in `src/wasm-pins.ts`:

| Tool | Pinned version | Source |
| --- | --- | --- |
| Rust | `1.90.0` (channel) | `miradex-rust/rust-toolchain.toml` |
| `wasm-pack` | `0.14.0` | `cargo install wasm-pack --version 0.14.0` |
| `binaryen` (`wasm-opt`) | `version_119` | https://github.com/WebAssembly/binaryen/releases/tag/version_119 |
| `jq` | any 1.x | system package |

Steps:

```
# 1. Toolchain (rust-toolchain.toml auto-installs on first cargo invocation)
cargo install wasm-pack --version 0.14.0

# 2. Install binaryen (Linux example; macOS users: brew install binaryen)
curl -L https://github.com/WebAssembly/binaryen/releases/download/version_119/binaryen-version_119-x86_64-linux.tar.gz \
  | tar xz -C /tmp
sudo cp /tmp/binaryen-version_119/bin/wasm-opt /usr/local/bin/

# 3. Clone, build, verify
git clone <repo>
cd miradex-client
pnpm install
pnpm run build:wasm        # rebuilds wasm + repins SHA256
pnpm run verify-wasm       # exits 0 if the freshly-built binary matches the pin
```

If `verify-wasm` exits 0, the committed binary at
`../wasm/miradex-rust/miradex_rust_bg.wasm` is bit-identical to what this
source produces in this toolchain.

If you suspect drift between source and the binary committed to git, run
`pnpm run verify-wasm` *without* first rebuilding — it compares the
already-committed binary to the already-committed pin.

## Caveats on bit-reproducibility

- `Cargo.lock` is committed; do not delete it before building.
- `wasm-pack` patch versions can change the cdylib layout. Match the version
  in the table above.
- `wasm-opt` produces different output across binaryen releases. Match the
  pinned `binaryen` release.
- macOS / Linux produce identical wasm output for these crates in practice.

## What this crate exports

`#[wasm_bindgen]` exports in `src/lib.rs` are mirrored in
`../src/lib/crypto/types.ts`. Adding a new export means updating both.

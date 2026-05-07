#!/usr/bin/env bash
# Build the miradex-rust crate to wasm and stage it for @miradex/client.
#
# Default OUT_DIR is ../wasm/miradex-rust (i.e. miradex-client/wasm/miradex-rust),
# which is what miradex-client/package.json's `file:./wasm/miradex-rust` dep
# points at. Override OUT_DIR to publish elsewhere.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-${CRATE_DIR}/../wasm/miradex-rust}"
OUT_NAME="miradex_rust"

cd "${CRATE_DIR}"

mkdir -p "$(dirname "${OUT_DIR}")"
rm -rf "${OUT_DIR}"

wasm-pack build \
  --release \
  --target web \
  --out-dir "${OUT_DIR}" \
  --out-name "${OUT_NAME}"

# wasm-pack writes a `*` .gitignore into its output dir on the assumption that
# pkg/ is a transient build artifact. We use Layout B (vendored wasm), so we
# DO commit and publish these files — drop the .gitignore so npm pack and git
# both see them.
rm -f "${OUT_DIR}/.gitignore"

WASM_BIN="${OUT_DIR}/${OUT_NAME}_bg.wasm"

if command -v wasm-opt >/dev/null 2>&1; then
  echo "running wasm-opt -Oz"
  # Feature flags must cover everything rustc 1.90 emits for wasm32, otherwise
  # wasm-opt's validator rejects the input. Modern rustc emits:
  #   - `i32.trunc_sat_f64_s` / `i64.trunc_sat_f64_u`  → nontrapping-float-to-int
  #   - bulk memory ops (memory.copy, memory.fill)     → bulk-memory
  #   - sign-extension ops (i32.extend8_s, ...)        → sign-ext
  #   - typed function refs in tables                  → reference-types
  #   - multi-result blocks                            → multivalue
  #   - mutable globals                                → mutable-globals
  # Enabling these does NOT add features to the binary; it only tells wasm-opt
  # which features the input is allowed to use during validation.
  wasm-opt -Oz \
    --enable-bulk-memory \
    --enable-sign-ext \
    --enable-nontrapping-float-to-int \
    --enable-reference-types \
    --enable-multivalue \
    --enable-mutable-globals \
    --strip-debug \
    --strip-producers \
    --vacuum \
    "${WASM_BIN}" -o "${WASM_BIN}.opt"
  mv "${WASM_BIN}.opt" "${WASM_BIN}"
else
  echo "warning: wasm-opt not installed; binary not optimised" >&2
fi

# Post-process the generated package.json to add bundler exports field.
PKG_JSON="${OUT_DIR}/package.json"
if command -v jq >/dev/null 2>&1; then
  jq --arg name "${OUT_NAME}" '. + {
    "exports": {
      ".": {
        "types": ("./" + $name + ".d.ts"),
        "import": ("./" + $name + ".js")
      },
      "./wasm": ("./" + $name + "_bg.wasm"),
      "./package.json": "./package.json"
    }
  }' "${PKG_JSON}" > "${PKG_JSON}.new"
  mv "${PKG_JSON}.new" "${PKG_JSON}"
else
  echo "warning: jq not installed; pkg/package.json exports field not added" >&2
fi

SIZE="$(wc -c <"${WASM_BIN}")"
echo "built ${OUT_NAME}_bg.wasm: ${SIZE} bytes (out: ${OUT_DIR})"

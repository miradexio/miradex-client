// .code is a stable string matching MiradexWasmError::code() in Rust
// (see ../../../miradex-rust/src).
export class WasmError extends Error {
  readonly name = 'WasmError';
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

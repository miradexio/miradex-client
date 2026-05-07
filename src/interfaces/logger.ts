// Caller-provided: file-based for CLI, console for browser, no-op for silent.
export interface Logger {
  debug(data: Readonly<Record<string, unknown>>, message: string): void;
  info(data: Readonly<Record<string, unknown>>, message: string): void;
  warn(data: Readonly<Record<string, unknown>>, message: string): void;
  error(data: Readonly<Record<string, unknown>>, message: string): void;
}

export const noopLogger: Logger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

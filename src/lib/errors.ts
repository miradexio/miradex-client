// Every SDK error is either a MiradexError subclass with a category, or a
// foreign error that classifyError maps to one. The category drives
// withRetry policy. Platform-neutral: only Error / TypeError / DOMException.
//
// Categories:
//   network        - DNS, TLS, reset, fetch timeout. Retry forever.
//   server         - HTTP 5xx. Retry forever.
//   rate-limit     - HTTP 429. Bounded retry.
//   client-bounded - 404 (freshly created), 408, 409, 422. Bounded retry.
//   client-fatal   - other 4xx (400, 401, 403, 405, 410, ...). Fail.
//   protocol       - schema mismatch / missing required field. Fail.
//   verification   - crypto / security check failed. Fail.
//   cancelled      - user / engine cancellation. Propagate.
//   unknown        - unclassified. Bounded retry as a safety net.
export type ErrorCategory =
  | 'network'
  | 'server'
  | 'rate-limit'
  | 'client-bounded'
  | 'client-fatal'
  | 'protocol'
  | 'verification'
  | 'cancelled'
  | 'unknown';

export interface MiradexErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

// Subclasses set name and category. cause + details travel along.
export class MiradexError extends Error {
  override readonly name: string = 'MiradexError';
  readonly category: ErrorCategory;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  override readonly cause: unknown;

  constructor(message: string, category: ErrorCategory, options?: MiradexErrorOptions) {
    super(message);
    this.category = category;
    this.cause = options?.cause;
    this.details = options?.details;
  }
}

// MiradexError short-circuits; everything else is fingerprinted against
// platform-neutral fetch / DNS / TLS failures.
export function classifyError(err: unknown): ErrorCategory {
  if (err instanceof MiradexError) return err.category;

  // Native fetch: Node 20+ throws TypeError("fetch failed") with .cause
  // carrying ECONN...; browsers throw TypeError("Failed to fetch") sans cause.
  if (err instanceof TypeError) {
    if (/^(?:fetch failed|failed to fetch|networkerror|load failed)/i.test(err.message)) {
      return 'network';
    }
  }

  // Per-request timeout via AbortController.abort().
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') {
    return 'network';
  }

  if (err instanceof Error) {
    // Last-resort fingerprint for environments that bury Node codes in
    // message / cause without extending TypeError.
    const merged = `${err.message} ${cause(err)}`.toLowerCase();
    if (
      /\b(?:econnrefused|econnreset|enotfound|eai_again|etimedout|epipe|ehostunreach|enetunreach|socket hang up|getaddrinfo|other side closed|terminated)\b/.test(
        merged,
      )
    ) {
      return 'network';
    }
  }

  return 'unknown';
}

function cause(err: Error): string {
  const c = (err as { cause?: unknown }).cause;
  if (c === undefined || c === null) return '';
  if (c instanceof Error) return c.message;
  return String(c);
}

/** Convenience: shorthand string from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class SwapCancelledError extends MiradexError {
  override readonly name = 'SwapCancelledError';
  constructor(message = 'Swap cancelled by user') {
    super(message, 'cancelled');
  }
}

// Always category 'network' so withRetry retries forever (capped backoff).
export class NetworkError extends MiradexError {
  override readonly name = 'NetworkError';
  constructor(message: string, options?: MiradexErrorOptions) {
    super(message, 'network', options);
  }
}

// One class for all four HTTP categories (server / rate-limit / client-bounded
// / client-fatal); category derived from statusCode + code. SCHEMA_MISMATCH is
// always 'protocol' regardless of status — retrying won't fix it.
export class ApiError extends MiradexError {
  override readonly name = 'ApiError';
  readonly statusCode: number;
  readonly code: string;
  constructor(
    message: string,
    statusCode: number,
    code: string,
    options?: MiradexErrorOptions,
  ) {
    super(message, deriveApiCategory(statusCode, code), options);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Map an HTTP status + server code to a retry category. */
export function deriveApiCategory(statusCode: number, code: string): ErrorCategory {
  if (code === 'SCHEMA_MISMATCH') return 'protocol';
  if (statusCode >= 500) return 'server';
  if (statusCode === 429) return 'rate-limit';
  if (statusCode === 408 || statusCode === 409 || statusCode === 422) return 'client-bounded';
  if (statusCode === 404) return 'client-bounded';
  if (statusCode >= 400) return 'client-fatal';
  return 'unknown';
}

/** Whether the SDK should retry this error at all. */
export function isRetryable(err: unknown): boolean {
  const c = classifyError(err);
  return c !== 'protocol' && c !== 'verification' && c !== 'client-fatal' && c !== 'cancelled';
}

/** Whether the SDK should retry this error indefinitely (capped backoff). */
export function isUnboundedRetry(err: unknown): boolean {
  const c = classifyError(err);
  return c === 'network' || c === 'server';
}

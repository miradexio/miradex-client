// Retries by ErrorCategory. network/server retry forever with exponential
// backoff capped at maxBackoffMs; bounded categories retry up to
// maxBoundedRetries; fatal categories propagate. AbortSignal honoured before
// every attempt and during every sleep — abort surfaces SwapCancelledError
// within ms.

import type { Logger } from '../interfaces/logger.js';
import { noopLogger } from '../interfaces/logger.js';
import {
  SwapCancelledError,
  classifyError,
  errorMessage,
  type ErrorCategory,
} from './errors.js';

export interface RetryOptions {
  /** Cap on retries for client-bounded / unknown. Default 3. */
  readonly maxBoundedRetries?: number;
  /** Initial backoff in ms; doubles each attempt up to maxBackoffMs. Default 500. */
  readonly baseMs?: number;
  /** Cap for per-retry sleep, in ms. Default 60_000. */
  readonly maxBackoffMs?: number;
  /** When aborted, the next sleep / attempt rejects with SwapCancelledError. */
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  /** Label appended to log lines (call site / endpoint). Default 'op'. */
  readonly label?: string;
  /** Override the default classifier (e.g. promote a transient string to 'network'). */
  readonly classify?: (err: unknown) => ErrorCategory;
  /** Hook fired once per retry after classification, before backoff. */
  readonly onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  readonly category: ErrorCategory;
  readonly attempt: number;
  readonly backoffMs: number;
  readonly error: unknown;
  readonly isUnbounded: boolean;
}

const DEFAULT_MAX_BOUNDED = 3;
const DEFAULT_BASE_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
// Cap the exponent so 2 ** n can't overflow Number on a long retry chain.
const MAX_EXPONENT = 30;

// Returns the first successful resolution of fn, retrying per the policy.
// Example:
//   await withRetry(
//     () => api.executeAction(swapId, { type: 'submit_encsig', tx_redeem_encsig }),
//     { logger, label: 'submit_encsig', signal: engineSignal },
//   );
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxBounded = options.maxBoundedRetries ?? DEFAULT_MAX_BOUNDED;
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const log = options.logger ?? noopLogger;
  const label = options.label ?? 'op';
  const classify = options.classify ?? classifyError;

  let unboundedRetries = 0;
  let boundedRetries = 0;
  let attempt = 0;

  while (true) {
    if (options.signal?.aborted) throw new SwapCancelledError();

    try {
      return await fn(attempt);
    } catch (err: unknown) {
      attempt++;
      const category = classify(err);

      if (
        category === 'cancelled' ||
        category === 'protocol' ||
        category === 'verification' ||
        category === 'client-fatal'
      ) {
        throw err;
      }

      const isUnbounded = category === 'network' || category === 'server';
      if (isUnbounded) {
        unboundedRetries++;
      } else {
        // 'rate-limit' | 'client-bounded' | 'unknown'
        boundedRetries++;
        if (boundedRetries > maxBounded) {
          log.warn(
            {
              label,
              attempts: boundedRetries,
              category,
              error: errorMessage(err),
            },
            `${label}: bounded retry exhausted, surfacing error`,
          );
          throw err;
        }
      }

      const totalRetries = unboundedRetries + boundedRetries;
      const backoffMs = computeBackoffMs(totalRetries, baseMs, maxBackoffMs);

      log.warn(
        {
          label,
          attempt: totalRetries,
          category,
          backoffMs,
          error: errorMessage(err),
        },
        `${label}: retrying after ${String(backoffMs)}ms`,
      );

      options.onRetry?.({
        category,
        attempt: totalRetries,
        backoffMs,
        error: err,
        isUnbounded,
      });

      await sleepWithSignal(backoffMs, options.signal);
    }
  }
}

// Exposed for tests and callers that want the same schedule.
export function computeBackoffMs(retryNumber: number, baseMs: number, maxMs: number): number {
  if (retryNumber <= 0) return 0;
  const exp = baseMs * 2 ** Math.min(retryNumber - 1, MAX_EXPONENT);
  return Math.min(exp, maxMs);
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new SwapCancelledError();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal === undefined) return;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new SwapCancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

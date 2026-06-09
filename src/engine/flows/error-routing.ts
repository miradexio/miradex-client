import { VerificationError } from '../../types/index.js';
import { SwapCancelledError } from '../../atomic-swap/types.js';
import { isPreFunding } from '../../types/status.js';

export type ErrorRouteResult =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'stalled'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

export function routeError(
  err: unknown,
  signalAborted: boolean,
  lastSeenStatus: string | null,
): ErrorRouteResult {
  if (signalAborted || err instanceof SwapCancelledError) {
    return { kind: 'cancelled' };
  }

  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof VerificationError) {
    return { kind: 'failed', message };
  }

  if (lastSeenStatus !== null && !isPreFunding(lastSeenStatus)) {
    return { kind: 'stalled', message };
  }

  return { kind: 'failed', message };
}

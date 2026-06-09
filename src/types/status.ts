// Terminal-status literals + set for client-side reducers. SwapStatus and
// related wire types live in src/wire/server/swap.zod.ts as zod-inferred
// types; import them through the package barrel.

export type TerminalStatus =
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'withheld'
  | 'expired';

// Set<string> because SwapStatus has a forward-compat `unknown:${string}` tail.
//
// 'punished' is deliberately NOT terminal: when Alice broadcasts TxPunish
// (Bob missed the refund window) the sidecar runs
// cooperative_xmr_redeem_after_punish, recovers s_a, and flips
// requiredAction to 'sweep'. The driver finishes via XMR sweep into
// 'completed'. Marking 'punished' terminal would bail mid-recovery.
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>([
  'completed',
  'failed',
  'refunded',
  'withheld',
  'expired',
]);

export const PRE_FUNDING_STATUSES: ReadonlySet<string> = new Set<string>([
  'pending',
  'awaiting_funding',
  'initializing',
]);

export function isPreFunding(status: string): boolean {
  return PRE_FUNDING_STATUSES.has(status);
}

// Three strictness levels:
//   FlowContext          - base, nullable (keygen, creating-swap)
//   PopulatedFlowContext - snapshot-critical fields non-empty
//                          (awaiting-deposit, deposit-detected)
//   VerifiedFlowContext  - populated + verification non-null
//                          (signing, funding, confirming, swapping)
// Types are inferred from the schemas; validation uses safeParse.

import { z } from 'zod';


const VerificationCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});

const VerificationResultSchema = z.object({
  verified: z.boolean(),
  provider: z.string(),
  checks: z.array(VerificationCheckSchema).readonly(),
  timestamp: z.number(),
});

const EXTRA_TYPES = ['prompt', 'message', 'warning', 'error'] as const;

const FlowContextExtraSchema = z.object({
  text: z.string().min(1, 'extra.text must not be empty'),
  type: z.enum(EXTRA_TYPES),
});

// Every field nullable; the engine builds it up progressively.
const FlowContextBaseSchema = z.object({
  // True when the server returned a restricted (ownership-proof-less) detail:
  // sensitive fields stay null and populated/verified validation is skipped.
  restricted: z.boolean(),
  depositAddr: z.string().nullable(),
  destAddress: z.string().nullable(),
  refundAddress: z.string().nullable(),
  keystoreId: z.string().nullable(),
  depositAmount: z.string().nullable(),
  fromToken: z.string().nullable(),
  toToken: z.string().nullable(),
  expectedOut: z.string().nullable(),
  amountInUsd: z.string().nullable(),
  expectedOutUsd: z.string().nullable(),
  qr: z.string().nullable(),
  verification: VerificationResultSchema.nullable(),
  verificationSourceUrl: z.string().nullable(),
  expiresAt: z.string().nullable(),
  depositMemo: z.string().nullable(),
  provider: z.string().nullable(),
  swapId: z.string().nullable(),
  swapNumber: z.string().nullable(),
  extra: FlowContextExtraSchema.nullable(),
});

// Critical snapshot fields must be non-empty for deposit-ready phases.
const PopulatedFlowContextSchema = FlowContextBaseSchema.extend({
  depositAddr: z.string().min(1, 'depositAddr is required for this phase'),
  destAddress: z.string().min(1, 'destAddress is required for this phase'),
  fromToken: z.string().min(1, 'fromToken is required for this phase'),
  toToken: z.string().min(1, 'toToken is required for this phase'),
  qr: z.string().min(1, 'qr is required for this phase'),
  provider: z.string().min(1, 'provider is required for this phase'),
  // expectedOut stays nullable: it's display-only, sourced from /quotes which
  // can fail transiently. Deposit/swap/refund paths don't need it; blocking
  // here would fail an otherwise-fine swap. UIs render null as "-".
  expectedOut: z.string().nullable(),
});

// Post-verification: everything populated + verification non-null.
const VerifiedFlowContextSchema = PopulatedFlowContextSchema.extend({
  verification: VerificationResultSchema,
});

export type FlowContextExtra = z.infer<typeof FlowContextExtraSchema>;
export type FlowContextExtraType = FlowContextExtra['type'];
export type FlowContext = z.infer<typeof FlowContextBaseSchema>;
export type PopulatedFlowContext = z.infer<typeof PopulatedFlowContextSchema>;
export type VerifiedFlowContext = z.infer<typeof VerifiedFlowContextSchema>;
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

// Re-exported for tests and adapter implementations.
export {
  FlowContextBaseSchema,
  PopulatedFlowContextSchema,
  VerifiedFlowContextSchema,
  FlowContextExtraSchema,
  VerificationResultSchema,
  VerificationCheckSchema,
};

export interface FlowContextValidationError {
  readonly phase: string;
  readonly fields: readonly string[];
  readonly message: string;
}

export type FlowContextResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: FlowContextValidationError };

// Engine calls these before emitting phases; structured error per failure.
function buildValidationError(
  phase: string,
  zodError: z.ZodError,
): FlowContextValidationError {
  const fields = zodError.issues.map((issue) => issue.path.join('.'));
  const details = zodError.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  );
  return {
    phase,
    fields,
    message: `FlowContext validation failed for phase '${phase}': ${details.join('; ')}`,
  };
}

export function validateBase(
  ctx: unknown,
  phase: string,
): FlowContextResult<FlowContext> {
  const result = FlowContextBaseSchema.safeParse(ctx);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: buildValidationError(phase, result.error) };
}

export function validatePopulated(
  ctx: unknown,
  phase: string,
): FlowContextResult<PopulatedFlowContext> {
  const result = PopulatedFlowContextSchema.safeParse(ctx);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: buildValidationError(phase, result.error) };
}

export function validateVerified(
  ctx: unknown,
  phase: string,
): FlowContextResult<VerifiedFlowContext> {
  const result = VerifiedFlowContextSchema.safeParse(ctx);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: buildValidationError(phase, result.error) };
}

const EMPTY_FLOW_CONTEXT: FlowContext = {
  restricted: false,
  depositAddr: null,
  destAddress: null,
  refundAddress: null,
  keystoreId: null,
  depositAmount: null,
  fromToken: null,
  toToken: null,
  expectedOut: null,
  amountInUsd: null,
  expectedOutUsd: null,
  qr: null,
  verification: null,
  verificationSourceUrl: null,
  expiresAt: null,
  depositMemo: null,
  provider: null,
  swapId: null,
  swapNumber: null,
  extra: null,
};

// null in `partial` is a valid override and means "not yet known".
export function createFlowContext(partial: Partial<FlowContext>): FlowContext {
  return { ...EMPTY_FLOW_CONTEXT, ...partial };
}

// Only non-undefined keys overwrite. null means "reset to unknown".
export function mergeFlowContext(
  current: FlowContext,
  partial: Partial<FlowContext>,
): FlowContext {
  return { ...current, ...partial };
}

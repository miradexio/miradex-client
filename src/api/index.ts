import { z } from 'zod';
import type { Logger } from '../interfaces/logger.js';
import { noopLogger } from '../interfaces/logger.js';
import { ApiError, NetworkError } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';
import {
  apiEnvelopeSchema,
  createSwapBodySchema,
  createSwapResponseSchema,
  limitsResponseSchema,
  liquidityResponseSchema,
  powChallengeSchema,
  providersResponseSchema,
  quotesResponseSchema,
  rateResponseSchema,
  recentSwapSchema,
  swapActionBodySchema,
  swapActionResponseSchema,
  swapDetailSchema,
  swapPairSchema,
  swapTokenMapSchema,
  verifyKeysBodySchema,
  verifyKeysResponseSchema,
} from '../wire/server/index.js';
import type {
  CreateSwapBody,
  CreateSwapResponse,
  LimitsResponse,
  LiquidityResponse,
  PowChallenge,
  ProvidersResponse,
  QuotesResponse,
  RateResponse,
  RecentSwap,
  SwapAction,
  SwapActionResponse,
  SwapDetail,
  SwapPair,
  SwapTokenMap,
  VerifyKeysBody,
  VerifyKeysResponse,
} from '../wire/server/index.js';

// Back-compat re-exports; canonical definitions live in lib/errors.ts.
export { ApiError, NetworkError };

/**
 * Address-knowledge ownership proof. The server returns full swap detail
 * (and accepts actions) only when this matches the swap's destination
 * address; otherwise GET responses are restricted and actions are rejected.
 */
export interface SwapOwnershipProof {
  readonly destAddress: string;
}

export interface ExecuteActionOptions {
  readonly timeoutMs?: number;
  readonly proof?: SwapOwnershipProof;
}

/**
 * The API surface swap flows and atomic-swap helpers depend on. ApiClient
 * implements it structurally; createAuthorizedSwapApi returns a proof-bound
 * view so per-swap modules never thread the proof through call sites.
 */
export interface SwapApi {
  getSwapDetail(id: string, proof?: SwapOwnershipProof): Promise<SwapDetail>;
  executeAction(
    swapId: string,
    action: SwapAction,
    opts?: ExecuteActionOptions,
  ): Promise<SwapActionResponse>;
  createSwap(body: CreateSwapBody, powHeader?: string): Promise<CreateSwapResponse>;
  getChallenge(): Promise<PowChallenge>;
  getQuotes(params: GetQuotesParams): Promise<QuotesResponse>;
  verifyKeys(keys: VerifyKeysBody): Promise<VerifyKeysResponse>;
}

export function createAuthorizedSwapApi(api: SwapApi, proof: SwapOwnershipProof): SwapApi {
  return {
    getSwapDetail: (id, callerProof) => api.getSwapDetail(id, callerProof ?? proof),
    executeAction: (swapId, action, opts) =>
      api.executeAction(swapId, action, { ...opts, proof: opts?.proof ?? proof }),
    createSwap: (body, powHeader) => api.createSwap(body, powHeader),
    getChallenge: () => api.getChallenge(),
    getQuotes: (params) => api.getQuotes(params),
    verifyKeys: (keys) => api.verifyKeys(keys),
  };
}

export interface ApiClientConfig {
  readonly baseUrl: string;
  readonly timeout?: number;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly logger?: Logger;
}

export interface GetQuotesParams {
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly fromChain?: string;
  readonly toChain?: string;
}

export interface GetRateParams {
  readonly from: string;
  readonly to: string;
  readonly fromChain?: string;
  readonly toChain?: string;
}

export interface GetLimitsParams {
  readonly from: string;
  readonly to: string;
  readonly fromChain?: string;
  readonly toChain?: string;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly logger: Logger;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeout = config.timeout ?? 60_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseMs = config.retryBaseMs ?? 500;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.logger = config.logger ?? noopLogger;
  }

  async getTokens(): Promise<SwapTokenMap> {
    const { tokens } = await this.get(
      '/api/v1/swap/tokens',
      z.object({ tokens: swapTokenMapSchema }),
    );
    return tokens;
  }

  async getPairs(): Promise<readonly SwapPair[]> {
    const { pairs } = await this.get(
      '/api/v1/swap/pairs',
      z.object({ pairs: z.array(swapPairSchema) }),
    );
    return pairs;
  }

  async getQuotes(params: GetQuotesParams): Promise<QuotesResponse> {
    const qs = this.buildQuery({
      from: params.from,
      to: params.to,
      amount: params.amount,
      fromChain: params.fromChain,
      toChain: params.toChain,
    });
    return this.get(`/api/v1/swap/quotes?${qs}`, quotesResponseSchema);
  }

  async getRate(params: GetRateParams): Promise<RateResponse> {
    const qs = this.buildQuery({
      from: params.from,
      to: params.to,
      fromChain: params.fromChain,
      toChain: params.toChain,
    });
    return this.get(`/api/v1/swap/rate?${qs}`, rateResponseSchema);
  }

  async getLimits(params: GetLimitsParams): Promise<LimitsResponse> {
    const qs = this.buildQuery({
      from: params.from,
      to: params.to,
      fromChain: params.fromChain,
      toChain: params.toChain,
    });
    return this.get(`/api/v1/swap/limits?${qs}`, limitsResponseSchema);
  }

  async getProviders(): Promise<ProvidersResponse> {
    return this.get('/api/v1/swap/providers', providersResponseSchema);
  }

  async getLiquidity(): Promise<LiquidityResponse> {
    return this.get('/api/v1/swap/liquidity', liquidityResponseSchema);
  }

  async getRecents(): Promise<readonly RecentSwap[]> {
    const { recents } = await this.get(
      '/api/v1/swap/recents',
      z.object({ recents: z.array(recentSwapSchema) }),
    );
    return recents;
  }

  async getChallenge(): Promise<PowChallenge> {
    return this.get('/api/v1/pow/challenge', powChallengeSchema);
  }

  async createSwap(body: CreateSwapBody, powHeader?: string): Promise<CreateSwapResponse> {
    const validBody = createSwapBodySchema.parse(body);
    // 2-minute ceiling because /swap/new is the slowest path: PoW check,
    // THORChain memo registration (broadcast + poll), engine round-trip.
    // Typical 15-25s, worst case approaches a minute; the generic 60s
    // default would surface spurious timeouts mid-swap.
    return this.post(
      '/api/v1/swap/new',
      createSwapResponseSchema,
      validBody,
      powHeader ? { 'X-Pow-Payload': powHeader } : undefined,
      120_000,
    );
  }

  async getSwapDetail(id: string, proof?: SwapOwnershipProof): Promise<SwapDetail> {
    const query = buildProofQuery(proof);
    return this.get(`/api/v1/swap/${encodeURIComponent(id)}${query}`, swapDetailSchema);
  }

  async getSwapByFundingAddress(address: string): Promise<SwapDetail | null> {
    return this.get(
      `/api/v1/swap/get-id/${encodeURIComponent(address)}`,
      swapDetailSchema.nullable(),
    );
  }

  async executeAction(
    swapId: string,
    action: SwapAction,
    opts?: ExecuteActionOptions,
  ): Promise<SwapActionResponse> {
    const validBody = swapActionBodySchema.parse(action);
    const query = buildProofQuery(opts?.proof);
    return this.post(
      `/api/v1/swap/${encodeURIComponent(swapId)}/action${query}`,
      swapActionResponseSchema,
      validBody,
      undefined,
      opts?.timeoutMs,
    );
  }

  async verifyKeys(keys: VerifyKeysBody): Promise<VerifyKeysResponse> {
    const validBody = verifyKeysBodySchema.parse(keys);
    return this.post('/api/v1/swap/verify-keys', verifyKeysResponseSchema, validBody);
  }

  private buildQuery(params: Readonly<Record<string, string | undefined>>): string {
    const filtered = Object.entries(params).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    return new URLSearchParams(filtered).toString();
  }

  private get<TSchema extends z.ZodTypeAny>(
    path: string,
    schema: TSchema,
    timeoutMs?: number,
  ): Promise<z.infer<TSchema>> {
    return this.request('GET', path, schema, undefined, undefined, timeoutMs);
  }

  private post<TSchema extends z.ZodTypeAny>(
    path: string,
    schema: TSchema,
    body: unknown,
    extraHeaders?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<z.infer<TSchema>> {
    return this.request('POST', path, schema, body, extraHeaders, timeoutMs);
  }

  // X-Pow-Payload is single-use (server SETNXs it in verifyPowSolution). A
  // retry after PoW already verified bounces off replay protection with
  // "403 challenge already used"; caller must fetch a fresh challenge.
  // Detect and skip the retry wrapper so the original error surfaces.
  private hasSingleUseToken(extraHeaders: Record<string, string> | undefined): boolean {
    if (!extraHeaders) return false;
    return Object.prototype.hasOwnProperty.call(extraHeaders, 'X-Pow-Payload');
  }

  private async request<TSchema extends z.ZodTypeAny>(
    method: string,
    path: string,
    responseSchema: TSchema,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<z.infer<TSchema>> {
    const url = `${this.baseUrl}${path}`;
    const effectiveTimeout = timeoutMs ?? this.timeout;
    this.logger.debug({ method, path }, 'API request');

    if (this.hasSingleUseToken(extraHeaders)) {
      return this.runOnce(method, path, url, responseSchema, body, extraHeaders, effectiveTimeout);
    }

    return withRetry(
      async () => this.runOnce(method, path, url, responseSchema, body, extraHeaders, effectiveTimeout),
      {
        maxBoundedRetries: this.maxRetries,
        baseMs: this.retryBaseMs,
        logger: this.logger,
        label: `${method} ${path}`,
      },
    );
  }

  // Throws map to ErrorCategory via lib/errors.ts:
  //   ApiError('SCHEMA_MISMATCH') -> protocol     -> fail
  //   ApiError(4xx)               -> client-*     -> bounded / fatal per status
  //   ApiError(5xx)               -> server       -> unbounded retry
  //   NetworkError                -> network      -> unbounded retry
  private async runOnce<TSchema extends z.ZodTypeAny>(
    method: string,
    path: string,
    url: string,
    responseSchema: TSchema,
    body: unknown,
    extraHeaders: Record<string, string> | undefined,
    effectiveTimeout: number,
  ): Promise<z.infer<TSchema>> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), effectiveTimeout);

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...extraHeaders,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (fetchErr: unknown) {
      clearTimeout(timer);
      throw normaliseFetchError(fetchErr, effectiveTimeout);
    }
    clearTimeout(timer);

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (parseErr: unknown) {
      // undici / browser fetch sometimes truncate on connection reset.
      throw new NetworkError('Failed to parse response body', {
        cause: parseErr,
        details: { status: res.status },
      });
    }

    const parsed = apiEnvelopeSchema(responseSchema).safeParse(raw);
    if (!parsed.success) {
      this.logger.error(
        { method, path, status: res.status, issues: parsed.error.issues },
        'Schema mismatch',
      );
      throw new ApiError(
        'Server response did not match expected schema',
        502,
        'SCHEMA_MISMATCH',
        { details: { method, path, status: res.status, issues: parsed.error.issues } },
      );
    }

    const envelope = parsed.data as
      | { readonly success: true; readonly data: z.infer<TSchema> }
      | {
          readonly success: false;
          readonly error: { code: string; message: string; details?: unknown };
        };

    if (!envelope.success) {
      const { code, message, details } = envelope.error;
      this.logger.warn({ method, path, status: res.status, code }, 'API error');
      throw new ApiError(message, res.status, code, {
        details: typeof details === 'object' && details !== null
          ? (details as Readonly<Record<string, unknown>>)
          : undefined,
      });
    }

    return envelope.data;
  }
}

function buildProofQuery(proof: SwapOwnershipProof | undefined): string {
  if (!proof) return '';
  return `?${new URLSearchParams({ destAddress: proof.destAddress }).toString()}`;
}

// One shape for the retry classifier across platforms. TypeError covers
// undici / browser fetch failures; DOMException('AbortError') covers the
// per-request timeout. Other errors keep their original message.
function normaliseFetchError(err: unknown, timeoutMs: number): NetworkError {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') {
    return new NetworkError(`Request timeout after ${String(timeoutMs)}ms`, { cause: err });
  }
  if (err instanceof Error) {
    return new NetworkError(err.message, { cause: err });
  }
  return new NetworkError(String(err));
}

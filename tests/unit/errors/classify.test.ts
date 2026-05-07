import { describe, it, expect } from 'vitest';
import {
  ApiError,
  MiradexError,
  NetworkError,
  SwapCancelledError,
  classifyError,
  deriveApiCategory,
  errorMessage,
  isRetryable,
  isUnboundedRetry,
} from '../../../src/lib/errors.js';
import { ProtocolError } from '../../../src/types/protocol.js';
import { VerificationError } from '../../../src/types/verification.js';

describe('classifyError', () => {
  it('preserves the category of any MiradexError subclass', () => {
    expect(classifyError(new NetworkError('boom'))).toBe('network');
    expect(classifyError(new SwapCancelledError())).toBe('cancelled');
    expect(classifyError(new ApiError('5xx', 503, 'X'))).toBe('server');
    expect(classifyError(new ApiError('429', 429, 'X'))).toBe('rate-limit');
    expect(classifyError(new ApiError('404', 404, 'X'))).toBe('client-bounded');
    expect(classifyError(new ApiError('400', 400, 'X'))).toBe('client-fatal');
    expect(classifyError(new ApiError('schema', 502, 'SCHEMA_MISMATCH'))).toBe('protocol');
    expect(classifyError(new ProtocolError('E_TERMINAL', 'msg'))).toBe('protocol');
    expect(classifyError(new VerificationError('E_LOCK_ADDR_MISMATCH', 'msg'))).toBe('verification');
  });

  it('classifies undici / browser fetch failures as network', () => {
    expect(classifyError(new TypeError('fetch failed'))).toBe('network');
    expect(classifyError(new TypeError('Failed to fetch'))).toBe('network');
    expect(classifyError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe('network');
  });

  it('classifies AbortError DOMException as network', () => {
    const ex = new DOMException('aborted', 'AbortError');
    expect(classifyError(ex)).toBe('network');
  });

  it('fingerprints common Node-style failure messages as network', () => {
    expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:7022'))).toBe('network');
    expect(classifyError(new Error('getaddrinfo ENOTFOUND example.invalid'))).toBe('network');
    expect(classifyError(new Error('socket hang up'))).toBe('network');
    expect(classifyError(new Error('other side closed'))).toBe('network');
  });

  it('falls back to unknown for anything else', () => {
    expect(classifyError(new Error('boom'))).toBe('unknown');
    expect(classifyError('string thrown')).toBe('unknown');
    expect(classifyError(undefined)).toBe('unknown');
  });
});

describe('deriveApiCategory', () => {
  it('maps SCHEMA_MISMATCH to protocol regardless of status', () => {
    expect(deriveApiCategory(502, 'SCHEMA_MISMATCH')).toBe('protocol');
    expect(deriveApiCategory(200, 'SCHEMA_MISMATCH')).toBe('protocol');
  });

  it('maps 5xx to server', () => {
    expect(deriveApiCategory(500, 'X')).toBe('server');
    expect(deriveApiCategory(503, 'X')).toBe('server');
  });

  it('maps 429 to rate-limit', () => {
    expect(deriveApiCategory(429, 'RATE_LIMITED')).toBe('rate-limit');
  });

  it('maps 404/408/409/422 to client-bounded', () => {
    expect(deriveApiCategory(404, 'X')).toBe('client-bounded');
    expect(deriveApiCategory(408, 'X')).toBe('client-bounded');
    expect(deriveApiCategory(409, 'X')).toBe('client-bounded');
    expect(deriveApiCategory(422, 'X')).toBe('client-bounded');
  });

  it('maps other 4xx to client-fatal', () => {
    expect(deriveApiCategory(400, 'X')).toBe('client-fatal');
    expect(deriveApiCategory(401, 'X')).toBe('client-fatal');
    expect(deriveApiCategory(403, 'X')).toBe('client-fatal');
    expect(deriveApiCategory(405, 'X')).toBe('client-fatal');
  });
});

describe('isRetryable / isUnboundedRetry', () => {
  it('rejects fatal categories from any retry', () => {
    expect(isRetryable(new ApiError('400', 400, 'X'))).toBe(false);
    expect(isRetryable(new ProtocolError('E_TERMINAL', 'm'))).toBe(false);
    expect(isRetryable(new VerificationError('E_LOCK_ADDR_MISMATCH', 'm'))).toBe(false);
    expect(isRetryable(new SwapCancelledError())).toBe(false);
  });

  it('accepts transient categories', () => {
    expect(isRetryable(new NetworkError('x'))).toBe(true);
    expect(isRetryable(new ApiError('5xx', 503, 'X'))).toBe(true);
    expect(isRetryable(new ApiError('429', 429, 'X'))).toBe(true);
    expect(isRetryable(new ApiError('404', 404, 'X'))).toBe(true);
    expect(isRetryable(new Error('unknown'))).toBe(true);
  });

  it('marks only network + server as unbounded', () => {
    expect(isUnboundedRetry(new NetworkError('x'))).toBe(true);
    expect(isUnboundedRetry(new ApiError('5xx', 502, 'X'))).toBe(true);
    expect(isUnboundedRetry(new ApiError('429', 429, 'X'))).toBe(false);
    expect(isUnboundedRetry(new ApiError('404', 404, 'X'))).toBe(false);
    expect(isUnboundedRetry(new Error('unknown'))).toBe(false);
  });
});

describe('errorMessage', () => {
  it('extracts message from Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });
  it('stringifies non-Error throwables', () => {
    expect(errorMessage('raw string')).toBe('raw string');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});

describe('MiradexError ergonomics', () => {
  it('is instanceof Error and MiradexError', () => {
    const err = new NetworkError('x');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MiradexError);
    expect(err).toBeInstanceOf(NetworkError);
  });

  it('preserves cause + details', () => {
    const cause = new Error('inner');
    const err = new NetworkError('outer', { cause, details: { x: 1 } });
    expect(err.cause).toBe(cause);
    expect(err.details).toEqual({ x: 1 });
  });
});

import { describe, it, expect } from 'vitest';
import { routeError } from '../../../src/engine/flows/error-routing.js';
import { SwapCancelledError } from '../../../src/atomic-swap/types.js';
import { VerificationError } from '../../../src/types/index.js';

describe('routeError', () => {
  it('routes SwapCancelledError to cancelled', () => {
    expect(routeError(new SwapCancelledError(), false, 'deposited')).toEqual({
      kind: 'cancelled',
    });
  });

  it('routes any error to cancelled when signal is aborted', () => {
    expect(routeError(new Error('boom'), true, 'deposited')).toEqual({
      kind: 'cancelled',
    });
  });

  it('routes VerificationError to failed regardless of swap status', () => {
    const err = new VerificationError('E_DLEQ_PROOF_INVALID', 'dleq invalid');
    expect(routeError(err, false, 'swapping')).toEqual({
      kind: 'failed',
      message: 'dleq invalid',
    });
    expect(routeError(err, false, 'pending')).toEqual({
      kind: 'failed',
      message: 'dleq invalid',
    });
  });

  it('routes a generic error to stalled when the last seen status is post-funding', () => {
    const err = new Error('network blip');
    expect(routeError(err, false, 'deposited')).toEqual({
      kind: 'stalled',
      message: 'network blip',
    });
    expect(routeError(err, false, 'swapping')).toEqual({
      kind: 'stalled',
      message: 'network blip',
    });
    expect(routeError(err, false, 'sending')).toEqual({
      kind: 'stalled',
      message: 'network blip',
    });
    expect(routeError(err, false, 'punished')).toEqual({
      kind: 'stalled',
      message: 'network blip',
    });
  });

  it('routes a generic error to failed when the last seen status is pre-funding', () => {
    const err = new Error('boom');
    expect(routeError(err, false, 'pending')).toEqual({
      kind: 'failed',
      message: 'boom',
    });
    expect(routeError(err, false, 'awaiting_funding')).toEqual({
      kind: 'failed',
      message: 'boom',
    });
    expect(routeError(err, false, 'initializing')).toEqual({
      kind: 'failed',
      message: 'boom',
    });
  });

  it('routes a generic error to failed when no status has been seen', () => {
    const err = new Error('boom');
    expect(routeError(err, false, null)).toEqual({
      kind: 'failed',
      message: 'boom',
    });
  });

  it('uses String(err) as message when err is not an Error instance', () => {
    expect(routeError('plain string', false, 'deposited')).toEqual({
      kind: 'stalled',
      message: 'plain string',
    });
  });
});

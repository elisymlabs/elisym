import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/hosted/lib/api';
import {
  GENERIC_ALERT,
  GENERIC_ERROR,
  GENERIC_REQUEST_FAILURE,
  alertMessage,
  errorMessage,
  requestFailureMessage,
} from '../../src/hosted/lib/errors';

/** A text the server might send: an operator RPC URL with its key. */
const LEAK = 'fetch failed: URL: https://rpc.example/?api-key=SECRET';

describe('what the merchant reads', () => {
  it('is a fixed sentence per refusal code and unauthorized reason', () => {
    expect(errorMessage(new ApiError(409, 'stale_config'))).toContain('changed elsewhere');
    expect(errorMessage(new ApiError(0, 'network'))).toContain('could not be reached');
    expect(errorMessage(new ApiError(401, 'unauthorized', { reason: 'stale' }))).toContain(
      'clock is off by more than a minute',
    );
    expect(errorMessage(new ApiError(401, 'unauthorized', { reason: 'replay' }))).toContain(
      'already sent once',
    );
    expect(errorMessage(new ApiError(401, 'unauthorized', { reason: 'new' }))).toContain(
      'did not accept your signature',
    );
  });

  it('never carries a text the server or an exception sent', () => {
    for (const error of [
      new ApiError(500, 'internal', { message: LEAK }),
      new ApiError(400, 'bad_config', { problems: [LEAK], message: LEAK }),
      new ApiError(409, 'unsigned_payout', { message: LEAK }),
      new ApiError(401, 'unauthorized', { reason: LEAK }),
      new Error(LEAK),
      LEAK,
      undefined,
    ]) {
      expect(errorMessage(error)).not.toContain('SECRET');
    }
    expect(errorMessage(new ApiError(500, LEAK))).toBe(GENERIC_ERROR);
    expect(errorMessage(new Error(LEAK))).toBe(GENERIC_ERROR);
  });

  it('gives an unknown or inherited name the generic sentence, never a prototype member', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope']) {
      expect(errorMessage(new ApiError(400, name))).toBe(GENERIC_ERROR);
      expect(alertMessage(name)).toBe(GENERIC_ALERT);
      expect(requestFailureMessage({ code: name })).toBe(GENERIC_REQUEST_FAILURE);
    }
    expect(errorMessage(new ApiError(401, 'unauthorized', { reason: 'constructor' }))).toContain(
      'did not accept your signature',
    );
  });

  it('says each alert kind in its own sentence, and an unknown one generically', () => {
    for (const kind of [
      'start_refused',
      'start_failed',
      'node_stopped',
      'offer_mismatch',
      'rail_unavailable',
      'webhook_secret_missing',
      'drift',
      'setup_failed',
      'inbox_relays_refused',
    ]) {
      expect(alertMessage(kind), kind).not.toBe(GENERIC_ALERT);
    }
    expect(alertMessage('webhook_secret_missing')).toContain('Generate a secret');
    expect(alertMessage(LEAK)).toBe(GENERIC_ALERT);
  });

  it('says a failed request by its code only', () => {
    expect(requestFailureMessage({ code: 'order_paid' })).toContain('completes it itself');
    expect(requestFailureMessage({ code: 'bad_refund_amount' })).toContain('refund amount');
    expect(requestFailureMessage({ problem: LEAK })).toBe(GENERIC_REQUEST_FAILURE);
    expect(requestFailureMessage({ code: 7 })).toBe(GENERIC_REQUEST_FAILURE);
    expect(requestFailureMessage(null)).toBe(GENERIC_REQUEST_FAILURE);
    expect(requestFailureMessage(LEAK)).toBe(GENERIC_REQUEST_FAILURE);
  });
});

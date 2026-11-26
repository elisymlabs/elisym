import { describe, expect, it } from 'vitest';
import { merchantResult, problemCode } from '../src/admin/request-results';

const RAW_TEXT = 'fetch failed. URL: https://rpc.example/?api-key=SECRET123';

describe('merchant request results (A15)', () => {
  it('codes a malformed order key as bad_request', () => {
    expect(problemCode('hand_answer', 'nokey is not <buyer>:<orderId>')).toBe('bad_request');
    expect(problemCode('hand_answer', `${RAW_TEXT} is not <buyer>:<orderId> or so`)).toBe('failed');
  });

  it('keeps only whole, non-negative counts', () => {
    expect(merchantResult('hand_answer', { taken: 0, copyTaken: 3, relays: 2 })).toEqual({
      taken: 0,
      copyTaken: 3,
      relays: 2,
    });
    expect(
      merchantResult('hand_answer', {
        done: true,
        taken: -1,
        copyTaken: 1.5,
        relays: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toEqual({ done: true });
    expect(merchantResult('hand_answer', { taken: '2' })).toBeNull();
  });

  it('keeps only a known setup outcome', () => {
    expect(merchantResult('setup', { setup: 'done' })).toEqual({ setup: 'done' });
    expect(merchantResult('setup', { setup: RAW_TEXT })).toBeNull();
  });

  it('keeps only listings of a product id and a known state', () => {
    expect(
      merchantResult('setup', {
        listings: [
          { d: 'socks', listing: 'unchanged' },
          { d: RAW_TEXT, listing: 'out' },
          { d: 'hats', listing: 'failed' },
          'socks',
        ],
      }),
    ).toEqual({
      listings: [
        { d: 'socks', listing: 'unchanged' },
        { d: 'hats', listing: 'failed' },
      ],
    });
  });
});

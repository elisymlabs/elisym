import { describe, expect, it } from 'vitest';
import { explain } from '../../src/cloud/lib/errors';
import {
  KEY_IN_USE_WAIT_MS,
  type RelayPool,
  consoleRelayQuery,
} from '../../src/cloud/lib/key-in-use';
import { termsUrlFrom } from '../../src/cloud/lib/origin';
import { CLOUD_RELAYS } from '../../src/cloud/lib/relays';
import { startTierOf } from '../../src/cloud/lib/start';

describe('a /start link', () => {
  it('reads a tier id on /start only (the catalog says whether it may be started)', () => {
    expect(startTierOf('https://console.example/start?tier=starter')).toBe('starter');
    expect(startTierOf('https://console.example/start?tier=business&x=1')).toBe('business');
    expect(startTierOf('https://console.example/start?tier=white-label')).toBe('white-label');
    expect(startTierOf('https://console.example/start?tier=a')).toBe('a');
    expect(startTierOf('https://console.example/start?tier=9')).toBe('9');
    for (const url of [
      'https://console.example/start?tier=Starter',
      'https://console.example/start?tier=-starter',
      `https://console.example/start?tier=${'a'.repeat(33)}`,
      'https://console.example/start?tier=',
      'https://console.example/start',
      'https://console.example/?tier=starter',
      'https://console.example/start/?tier=starter',
      'https://console.example/redeem?tier=starter',
    ]) {
      expect(startTierOf(url), url).toBeUndefined();
    }
  });
});

describe('the terms page from config', () => {
  it('is none, or an https URL', () => {
    expect(termsUrlFrom(undefined)).toBeUndefined();
    expect(termsUrlFrom('')).toBeUndefined();
    expect(termsUrlFrom('https://elisym.example/terms')).toBe('https://elisym.example/terms');
    for (const value of [
      'javascript:alert(1)',
      'http://elisym.example/terms',
      'terms',
      'data:,x',
    ]) {
      expect(() => termsUrlFrom(value), value).toThrow('VITE_TERMS_URL');
    }
  });
});

describe('what a refusal says', () => {
  it('words the codes the console meets, and names any other', () => {
    expect(explain('invalid_invite', 400)).toContain('not valid');
    expect(explain('key_owns_a_store', 409)).toContain('One key per store');
    expect(explain('over_limit', 409)).toContain('contact us to move up');
    expect(explain('not_on_plan', 409)).toContain('an own RPC needs a plan that takes one');
    expect(explain('terms_not_accepted', 409)).toContain('accept them again');
    expect(explain('rate_limited', 429)).toContain('Too many attempts');
    expect(explain('stale', 401)).toContain('clock');
    expect(explain('something_new', 409)).toBe('The cloud refused it (something_new).');
    expect(explain(undefined, 502)).toBe('The cloud did not answer as expected (HTTP 502).');
    // A code that is an Object property name is not a known code.
    expect(explain('toString', 400)).toBe('The cloud refused it (toString).');
  });
});

describe("the console's relay query", () => {
  it('asks the console relays with a time bound, and closes the pool even when the query fails', async () => {
    const calls: unknown[] = [];
    const pool = (fail: boolean): RelayPool => ({
      async querySync(relays, filter, params) {
        calls.push({ relays, filter, params });
        if (fail) {
          throw new Error('relays down');
        }
        return [];
      },
      close(relays) {
        calls.push({ closed: relays });
      },
    });
    const filter = { kinds: [10133], authors: ['a'.repeat(64)] };
    expect(await consoleRelayQuery(() => pool(false))(filter)).toEqual([]);
    await expect(consoleRelayQuery(() => pool(true))(filter)).rejects.toThrow('relays down');
    const once = { relays: [...CLOUD_RELAYS], filter, params: { maxWait: KEY_IN_USE_WAIT_MS } };
    expect(calls).toEqual([
      once,
      { closed: [...CLOUD_RELAYS] },
      once,
      { closed: [...CLOUD_RELAYS] },
    ]);
    expect(KEY_IN_USE_WAIT_MS).toBe(4000);
  });

  it('closes the pool only once the query has settled', async () => {
    const order: string[] = [];
    let settle = () => {};
    const query = consoleRelayQuery(() => ({
      querySync: () =>
        new Promise((resolve) => {
          settle = () => {
            order.push('settled');
            resolve([]);
          };
        }),
      close: () => {
        order.push('closed');
      },
    }));
    const pending = query({ kinds: [10133] });
    await Promise.resolve();
    expect(order).toEqual([]);
    settle();
    await pending;
    expect(order).toEqual(['settled', 'closed']);
  });
});

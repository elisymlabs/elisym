import { describe, expect, it } from 'vitest';
import {
  createFreeLlmLimiterSet,
  FREE_LLM_GLOBAL_KEY,
  freeLlmCustomerKey,
  resolvePerSkillRateLimit,
} from '../src/llm-health';

describe('createFreeLlmLimiterSet', () => {
  it('uses default caps when options omitted', () => {
    const set = createFreeLlmLimiterSet();
    expect(set.global.maxPerWindow).toBeGreaterThan(0);
    expect(set.defaultPerCustomer.maxPerWindow).toBeGreaterThan(0);
  });

  it('global limiter denies after maxPerWindow hits', () => {
    const set = createFreeLlmLimiterSet({
      global: { perWindowMs: 60_000, maxPerWindow: 3 },
    });
    expect(set.globalLimiter.check(FREE_LLM_GLOBAL_KEY).allowed).toBe(true);
    expect(set.globalLimiter.check(FREE_LLM_GLOBAL_KEY).allowed).toBe(true);
    expect(set.globalLimiter.check(FREE_LLM_GLOBAL_KEY).allowed).toBe(true);
    expect(set.globalLimiter.check(FREE_LLM_GLOBAL_KEY).allowed).toBe(false);
  });

  it('default per-customer limiter is keyed on (customer, skill)', () => {
    const set = createFreeLlmLimiterSet({
      defaultPerCustomer: { perWindowMs: 60_000, maxPerWindow: 2 },
    });
    const limiter = set.getPerCustomerLimiter('skill-x', undefined);
    const a = freeLlmCustomerKey('cust-a', 'skill-x');
    const c = freeLlmCustomerKey('cust-b', 'skill-x');

    limiter.check(a);
    limiter.check(a);
    expect(limiter.check(a).allowed).toBe(false);
    // different skill, same customer - the default limiter is shared,
    // so the (customer, skill) key keeps counters independent.
    const limiterY = set.getPerCustomerLimiter('skill-y', undefined);
    expect(limiterY).toBe(limiter);
    const b = freeLlmCustomerKey('cust-a', 'skill-y');
    expect(limiterY.check(b).allowed).toBe(true);
    // different customer, same skill - independent counter.
    expect(limiter.check(c).allowed).toBe(true);
  });

  it('returns a dedicated limiter for a skill with override', () => {
    const set = createFreeLlmLimiterSet({
      defaultPerCustomer: { perWindowMs: 60_000, maxPerWindow: 2 },
    });
    const override = { perWindowMs: 24 * 60 * 60 * 1000, maxPerWindow: 5 };
    const a = set.getPerCustomerLimiter('skill-x', override);
    const b = set.getPerCustomerLimiter('skill-x', override);
    const def = set.getPerCustomerLimiter('skill-y', undefined);
    // Same skill returns the cached per-skill limiter.
    expect(a).toBe(b);
    // Different skill (no override) returns the shared default limiter.
    expect(a).not.toBe(def);

    // Override cap of 5 applies, not the default cap of 2.
    const key = freeLlmCustomerKey('cust', 'skill-x');
    for (let i = 0; i < 5; i++) {
      expect(a.check(key).allowed).toBe(true);
    }
    expect(a.check(key).allowed).toBe(false);
  });

  it('peek does not count toward window', () => {
    const set = createFreeLlmLimiterSet({
      global: { perWindowMs: 60_000, maxPerWindow: 1 },
    });
    set.globalLimiter.peek(FREE_LLM_GLOBAL_KEY);
    set.globalLimiter.peek(FREE_LLM_GLOBAL_KEY);
    expect(set.globalLimiter.check(FREE_LLM_GLOBAL_KEY).allowed).toBe(true);
    expect(set.globalLimiter.check(FREE_LLM_GLOBAL_KEY).allowed).toBe(false);
  });

  it('respects maxKeys cap on default per-customer limiter', () => {
    const set = createFreeLlmLimiterSet({
      maxKeys: 2,
      defaultPerCustomer: { perWindowMs: 60_000, maxPerWindow: 5 },
    });
    const limiter = set.getPerCustomerLimiter('skill-x', undefined);
    limiter.check('a');
    limiter.check('b');
    limiter.check('c');
    expect(limiter.size()).toBeLessThanOrEqual(2);
  });

  it('prunePerCustomer drops expired hits in default and per-skill limiters', () => {
    const set = createFreeLlmLimiterSet({
      defaultPerCustomer: { perWindowMs: 1, maxPerWindow: 5 },
    });
    const def = set.getPerCustomerLimiter('skill-default', undefined);
    const overridden = set.getPerCustomerLimiter('skill-x', {
      perWindowMs: 1,
      maxPerWindow: 5,
    });
    def.check('a');
    overridden.check('b');

    // Wait past the 1ms window.
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait
    }
    set.prunePerCustomer();
    expect(def.size()).toBe(0);
    expect(overridden.size()).toBe(0);
  });
});

describe('resolvePerSkillRateLimit', () => {
  it('returns undefined when skill omits rate_limit', () => {
    expect(resolvePerSkillRateLimit(undefined)).toBeUndefined();
  });

  it('returns the override when well-formed', () => {
    const override = { perWindowMs: 60_000, maxPerWindow: 10 };
    expect(resolvePerSkillRateLimit(override)).toBe(override);
  });

  it('returns undefined on bogus override values', () => {
    expect(resolvePerSkillRateLimit({ perWindowMs: 0, maxPerWindow: 5 })).toBeUndefined();
    expect(resolvePerSkillRateLimit({ perWindowMs: 60_000, maxPerWindow: 0 })).toBeUndefined();
  });
});

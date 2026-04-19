import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/lib/rateLimiter';

describe('RateLimiter', () => {
  it('allows up to maxPerWindow within the window', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxPerWindow: 3 });
    expect(limiter.check('alice', 1_000).allowed).toBe(true);
    expect(limiter.check('alice', 1_100).allowed).toBe(true);
    expect(limiter.check('alice', 1_200).allowed).toBe(true);
    const denied = limiter.check('alice', 1_300);
    expect(denied.allowed).toBe(false);
    expect(denied.resetAt).toBe(61_000);
  });

  it('frees the slot once the window slides past the oldest hit', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxPerWindow: 2 });
    limiter.check('bob', 1_000);
    limiter.check('bob', 2_000);
    expect(limiter.check('bob', 3_000).allowed).toBe(false);
    // Advance past the first hit; one slot frees.
    expect(limiter.check('bob', 1_000 + 60_001).allowed).toBe(true);
  });

  it('keys are independent', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxPerWindow: 1 });
    expect(limiter.check('alice', 1_000).allowed).toBe(true);
    expect(limiter.check('bob', 1_000).allowed).toBe(true);
    expect(limiter.check('alice', 1_500).allowed).toBe(false);
    expect(limiter.check('bob', 1_500).allowed).toBe(false);
  });

  it('evicts least-recently-used keys when maxTrackedKeys is exceeded', () => {
    const limiter = new RateLimiter({
      windowMs: 60_000,
      maxPerWindow: 1,
      maxTrackedKeys: 2,
    });
    limiter.check('alice', 1_000);
    limiter.check('bob', 2_000);
    limiter.check('carol', 3_000); // alice should be evicted
    expect(limiter.size()).toBe(2);
    // alice was evicted, so a new check is allowed (counter starts fresh)
    expect(limiter.check('alice', 4_000).allowed).toBe(true);
  });

  it('refreshes LRU even on denial so attackers cannot pump out other keys', () => {
    const limiter = new RateLimiter({
      windowMs: 60_000,
      maxPerWindow: 1,
      maxTrackedKeys: 2,
    });
    limiter.check('alice', 1_000);
    limiter.check('bob', 2_000);
    // Hammer alice; she stays denied but should be moved to MRU so bob is
    // the next eviction target on insertion of a third key.
    limiter.check('alice', 3_000);
    limiter.check('alice', 3_100);
    limiter.check('carol', 4_000);
    // bob got evicted - a new check resets; alice is still tracked + denied.
    expect(limiter.check('alice', 4_100).allowed).toBe(false);
    expect(limiter.check('bob', 4_200).allowed).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { createSlidingWindowLimiter } from '../src/primitives/rateLimiter';

describe('createSlidingWindowLimiter', () => {
  it('allows up to maxPerWindow within the window', () => {
    const limiter = createSlidingWindowLimiter({
      windowMs: 60_000,
      maxPerWindow: 3,
      maxKeys: 100,
    });
    expect(limiter.check('alice', 1_000).allowed).toBe(true);
    expect(limiter.check('alice', 1_100).allowed).toBe(true);
    expect(limiter.check('alice', 1_200).allowed).toBe(true);
    const denied = limiter.check('alice', 1_300);
    expect(denied.allowed).toBe(false);
    expect(denied.resetAt).toBe(61_000);
    expect(denied.count).toBe(3);
  });

  it('frees the slot once the window slides past the oldest hit', () => {
    const limiter = createSlidingWindowLimiter({
      windowMs: 60_000,
      maxPerWindow: 2,
      maxKeys: 100,
    });
    limiter.check('bob', 1_000);
    limiter.check('bob', 2_000);
    expect(limiter.check('bob', 3_000).allowed).toBe(false);
    expect(limiter.check('bob', 1_000 + 60_001).allowed).toBe(true);
  });

  it('boundary: a hit exactly windowMs ago is outside the window', () => {
    const limiter = createSlidingWindowLimiter({
      windowMs: 60_000,
      maxPerWindow: 1,
      maxKeys: 100,
    });
    limiter.check('carol', 1_000);
    expect(limiter.check('carol', 61_000).allowed).toBe(true);
  });

  it('keys are independent', () => {
    const limiter = createSlidingWindowLimiter({
      windowMs: 60_000,
      maxPerWindow: 1,
      maxKeys: 100,
    });
    expect(limiter.check('alice', 1_000).allowed).toBe(true);
    expect(limiter.check('bob', 1_000).allowed).toBe(true);
    expect(limiter.check('alice', 1_500).allowed).toBe(false);
    expect(limiter.check('bob', 1_500).allowed).toBe(false);
  });

  it('resetAt is monotonic across repeated denials for the same key', () => {
    const limiter = createSlidingWindowLimiter({
      windowMs: 60_000,
      maxPerWindow: 1,
      maxKeys: 100,
    });
    limiter.check('dave', 1_000);
    const first = limiter.check('dave', 2_000);
    const second = limiter.check('dave', 3_000);
    const third = limiter.check('dave', 30_000);
    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
    expect(third.allowed).toBe(false);
    expect(first.resetAt).toBe(61_000);
    expect(second.resetAt).toBe(61_000);
    expect(third.resetAt).toBe(61_000);
  });

  it('evicts least-recently-used keys when maxKeys is exceeded', () => {
    const limiter = createSlidingWindowLimiter({
      windowMs: 60_000,
      maxPerWindow: 1,
      maxKeys: 2,
    });
    limiter.check('alice', 1_000);
    limiter.check('bob', 2_000);
    limiter.check('carol', 3_000);
    expect(limiter.size()).toBe(2);
    expect(limiter.check('alice', 4_000).allowed).toBe(true);
  });

  it('refreshes LRU even on denial so attackers cannot evict other keys', () => {
    const limiter = createSlidingWindowLimiter({
      windowMs: 60_000,
      maxPerWindow: 1,
      maxKeys: 2,
    });
    limiter.check('alice', 1_000);
    limiter.check('bob', 2_000);
    limiter.check('alice', 3_000);
    limiter.check('alice', 3_100);
    limiter.check('carol', 4_000);
    expect(limiter.check('alice', 4_100).allowed).toBe(false);
    expect(limiter.check('bob', 4_200).allowed).toBe(true);
  });

  it('prune drops entries whose windows have fully elapsed', () => {
    const limiter = createSlidingWindowLimiter({
      windowMs: 60_000,
      maxPerWindow: 5,
      maxKeys: 10,
    });
    limiter.check('alice', 1_000);
    limiter.check('bob', 2_000);
    expect(limiter.size()).toBe(2);
    limiter.prune(70_000);
    expect(limiter.size()).toBe(0);
  });

  it('prune compacts partial windows without dropping active keys', () => {
    const limiter = createSlidingWindowLimiter({
      windowMs: 60_000,
      maxPerWindow: 5,
      maxKeys: 10,
    });
    limiter.check('alice', 1_000);
    limiter.check('alice', 50_000);
    limiter.prune(65_000);
    expect(limiter.size()).toBe(1);
    const decision = limiter.check('alice', 66_000);
    expect(decision.allowed).toBe(true);
    expect(decision.count).toBe(2);
  });

  it('reset clears all tracked keys', () => {
    const limiter = createSlidingWindowLimiter({
      windowMs: 60_000,
      maxPerWindow: 1,
      maxKeys: 10,
    });
    limiter.check('alice', 1_000);
    limiter.check('bob', 2_000);
    limiter.reset();
    expect(limiter.size()).toBe(0);
  });

  it('peek does not record a hit and never denies until check is called', () => {
    const limiter = createSlidingWindowLimiter({
      windowMs: 60_000,
      maxPerWindow: 2,
      maxKeys: 100,
    });
    const first = limiter.peek('erin', 1_000);
    expect(first.allowed).toBe(true);
    expect(first.count).toBe(0);

    limiter.check('erin', 2_000);
    limiter.check('erin', 3_000);
    const afterFill = limiter.peek('erin', 4_000);
    expect(afterFill.allowed).toBe(false);
    expect(afterFill.count).toBe(2);

    // Peek reported denial but did not push; a fresh peek sees the same count.
    expect(limiter.peek('erin', 4_500).count).toBe(2);
  });

  it('rejects non-positive options', () => {
    expect(() => createSlidingWindowLimiter({ windowMs: 0, maxPerWindow: 1, maxKeys: 1 })).toThrow(
      RangeError,
    );
    expect(() => createSlidingWindowLimiter({ windowMs: 1, maxPerWindow: 0, maxKeys: 1 })).toThrow(
      RangeError,
    );
    expect(() => createSlidingWindowLimiter({ windowMs: 1, maxPerWindow: 1, maxKeys: 0 })).toThrow(
      RangeError,
    );
  });
});

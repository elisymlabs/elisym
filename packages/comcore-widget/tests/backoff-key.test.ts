import { describe, expect, it } from 'vitest';
import { Backoff } from '../src/backoff';
import { loadVisitorKey } from '../src/visitor-key';
import { MemoryStorage, ThrowingStorage, testKey } from './fixtures';

describe('Backoff', () => {
  it('doubles from 1 s to a 60 s cap, with jitter in the upper half of each step', () => {
    const lowest = new Backoff(() => 0);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(() => lowest.next())).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    const highest = new Backoff(() => 1);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(() => highest.next())).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });

  it('starts over after a reset', () => {
    const backoff = new Backoff(() => 1);
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.next()).toBe(1_000);
  });
});

describe('loadVisitorKey', () => {
  it('keeps one V per (browser, store) in localStorage', () => {
    const storage = new MemoryStorage();
    const store = testKey().pubkey;
    const first = loadVisitorKey(store, storage);
    const second = loadVisitorKey(store, storage);
    expect(first.scope).toBe('browser');
    expect(second.pubkey).toBe(first.pubkey);
    expect(loadVisitorKey(testKey().pubkey, storage).pubkey).not.toBe(first.pubkey);
  });

  it('replaces a malformed stored key', () => {
    const storage = new MemoryStorage();
    const store = testKey().pubkey;
    storage.setItem(`comcore:v:${store}`, 'not-a-key');
    const key = loadVisitorKey(store, storage);
    expect(key.scope).toBe('browser');
    expect(storage.getItem(`comcore:v:${store}`)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to a per-tab key when storage throws or is missing', () => {
    const store = testKey().pubkey;
    const blocked = loadVisitorKey(store, new ThrowingStorage());
    expect(blocked.scope).toBe('tab');
    expect(loadVisitorKey(store, new ThrowingStorage()).pubkey).not.toBe(blocked.pubkey);
    expect(loadVisitorKey(store, undefined).scope).toBe('tab');
  });
});

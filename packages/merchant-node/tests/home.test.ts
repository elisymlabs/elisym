import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  HOME_ENV,
  LOCK_STALE_MS,
  heldByRunningMerchant,
  merchantHome,
  takeLock,
} from '../src/home';

describe('the merchant home', () => {
  it('is the flag, else the environment, else ~/.elisym-merchant', () => {
    expect(merchantHome('/srv/shop', { [HOME_ENV]: '/data' }).dir).toBe('/srv/shop');
    expect(merchantHome(undefined, { [HOME_ENV]: '/data' }).dir).toBe('/data');
    expect(merchantHome(undefined, { [HOME_ENV]: '' }).dir).toBe(
      join(homedir(), '.elisym-merchant'),
    );
    expect(merchantHome(undefined, {}).dir).toBe(join(homedir(), '.elisym-merchant'));
  });

  it('resolves a relative home and keeps every file in it', () => {
    const home = merchantHome('shop', {});
    expect(home.dir).toBe(resolve('shop'));
    for (const file of [home.config, home.keys, home.ledger, home.lock, home.nostrJson]) {
      expect(file.startsWith(`${home.dir}/`)).toBe(true);
    }
  });
});

describe('the home lock', () => {
  function freshHome() {
    return merchantHome(mkdtempSync(join(tmpdir(), 'merchant-home-')), {});
  }

  it('is held while refreshed, and taken over once it went stale', () => {
    const home = freshHome();
    writeFileSync(home.lock, 'someone');
    expect(heldByRunningMerchant(home)).toBe(true);
    expect(() => takeLock(home)).toThrow('another merchant holds');
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
    utimesSync(home.lock, old, old);
    expect(heldByRunningMerchant(home)).toBe(false);
    const release = takeLock(home);
    expect(readFileSync(home.lock, 'utf8')).toContain(`${process.pid}-`);
    expect(heldByRunningMerchant(home)).toBe(true);
    release();
    expect(heldByRunningMerchant(home)).toBe(false);
  });

  it('is free when there is none, and never releases a lock that is not its own', () => {
    const home = freshHome();
    expect(heldByRunningMerchant(home)).toBe(false);
    const release = takeLock(home);
    writeFileSync(home.lock, 'another holder');
    release();
    expect(readFileSync(home.lock, 'utf8')).toBe('another holder');
  });

  it('refreshes its lock, and stops when another process took it', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const home = freshHome();
      let lost = 0;
      const release = takeLock(home, { onLost: () => (lost += 1) });
      const old = new Date(Date.now() - LOCK_STALE_MS + 5_000);
      utimesSync(home.lock, old, old);
      vi.advanceTimersByTime(20_000);
      expect(Date.now() - statSync(home.lock).mtimeMs).toBeLessThan(5_000);
      expect(lost).toBe(0);
      // Stopped past the stale limit, the home was taken by another.
      writeFileSync(home.lock, 'another holder');
      vi.advanceTimersByTime(20_000);
      vi.advanceTimersByTime(20_000);
      expect(lost).toBe(1);
      release();
      expect(readFileSync(home.lock, 'utf8')).toBe('another holder');
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts back a lock that was refreshed after it was judged stale', () => {
    const home = freshHome();
    writeFileSync(home.lock, 'a live holder');
    // Judged as if long ago; by the time it is moved aside it is fresh.
    expect(() => takeLock(home, { judgedAt: Date.now() + 2 * LOCK_STALE_MS })).toThrow(
      'another merchant holds',
    );
    expect(readFileSync(home.lock, 'utf8')).toBe('a live holder');
    expect(readdirSync(home.dir)).toEqual(['run.lock']);
  });
});

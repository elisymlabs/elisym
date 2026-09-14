/**
 * The click-time balance read sits between a Buy click and a real payment, so
 * its two rules are load-bearing: a read that does not come back in time is
 * UNKNOWN (never zero, never a hang), and only a reading that did come back is
 * allowed to overwrite the polling cache.
 */
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { readAndPrimeBalance, withReadTimeout } from '../app/hooks/useWalletBalances';

const KEY = ['sol-balance-raw', 'wallet-1'] as const;

function never(): Promise<bigint> {
  return new Promise(() => {});
}

function slower(ms: number, value: bigint): Promise<bigint> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

describe('withReadTimeout', () => {
  it('passes a balance through, including a genuine zero', async () => {
    await expect(withReadTimeout(Promise.resolve(42n), 50)).resolves.toBe(42n);
    await expect(withReadTimeout(Promise.resolve(0n), 50)).resolves.toBe(0n);
  });

  it('resolves unknown, not zero, when the read fails', async () => {
    await expect(withReadTimeout(Promise.reject(new Error('rpc down')), 50)).resolves.toBeNull();
  });

  it('abandons a read that outlives the bound instead of hanging', async () => {
    await expect(withReadTimeout(never(), 10)).resolves.toBeNull();
  });

  it('does not let a late read win after the bound has passed', async () => {
    await expect(withReadTimeout(slower(60, 7n), 10)).resolves.toBeNull();
  });
});

describe('readAndPrimeBalance', () => {
  it('primes the polling cache with a balance that arrived', async () => {
    const queryClient = new QueryClient();
    const balance = await readAndPrimeBalance(queryClient, KEY, Promise.resolve(123n), 50);
    expect(balance).toBe(123n);
    expect(queryClient.getQueryData(KEY)).toBe(123n);
  });

  it('primes a genuine zero, which is a balance like any other', async () => {
    // The prime is gated on `!== null`, not on truthiness - an empty wallet is
    // a real reading and the gate must see it, or it decides on a stale one.
    const queryClient = new QueryClient();
    const balance = await readAndPrimeBalance(queryClient, KEY, Promise.resolve(0n), 50);
    expect(balance).toBe(0n);
    expect(queryClient.getQueryData(KEY)).toBe(0n);
  });

  it('leaves the cache untouched when the read fails', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(KEY, 500n);
    const balance = await readAndPrimeBalance(
      queryClient,
      KEY,
      Promise.reject(new Error('rpc down')),
      50,
    );
    expect(balance).toBeNull();
    // The previous reading survives - a failed read must never be written back
    // as a zero, nor wipe what the poll already knew.
    expect(queryClient.getQueryData(KEY)).toBe(500n);
  });

  it('leaves the cache untouched when the read times out', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(KEY, 500n);
    const balance = await readAndPrimeBalance(queryClient, KEY, never(), 10);
    expect(balance).toBeNull();
    expect(queryClient.getQueryData(KEY)).toBe(500n);
  });
});

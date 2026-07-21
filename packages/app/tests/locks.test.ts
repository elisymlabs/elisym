/**
 * Serialization primitive tests (`locks.ts`): FIFO ordering per key,
 * cross-key independence, rejection isolation, and the webLocks fallback.
 */
import { describe, expect, it } from 'vitest';
import { createKeyedQueue, webLocks } from '../app/lib/locks';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('createKeyedQueue', () => {
  it('runs tasks for one key strictly in FIFO order', async () => {
    const runQueued = createKeyedQueue();
    const order: string[] = [];
    await Promise.all([
      runQueued('key', async () => {
        await delay(15);
        order.push('first');
      }),
      runQueued('key', async () => {
        await delay(5);
        order.push('second');
      }),
      runQueued('key', async () => {
        order.push('third');
      }),
    ]);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('does not serialize across different keys', async () => {
    const runQueued = createKeyedQueue();
    const order: string[] = [];
    await Promise.all([
      runQueued('key-a', async () => {
        await delay(20);
        order.push('slow-a');
      }),
      runQueued('key-b', async () => {
        order.push('fast-b');
      }),
    ]);
    expect(order).toEqual(['fast-b', 'slow-a']);
  });

  it('propagates a rejection to its caller without poisoning the chain', async () => {
    const runQueued = createKeyedQueue();
    const failing = runQueued('key', async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    const after = await runQueued('key', async () => 'still works');
    expect(after).toBe('still works');
  });
});

describe('webLocks fallback', () => {
  it('executes the task when the Web Locks API is unavailable', async () => {
    const value = await webLocks.withLock('elisym-test-lock', async () => 42);
    expect(value).toBe(42);
  });
});

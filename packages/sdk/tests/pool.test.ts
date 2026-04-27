import type { Event, Filter } from 'nostr-tools';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SimplePool before importing NostrPool
const mockQuerySync = vi.fn<any>().mockResolvedValue([]);
const mockPublish = vi.fn<any>().mockReturnValue([Promise.resolve('ok')]);
const mockSubscribeMany = vi.fn<any>().mockReturnValue({ close: vi.fn() });
const mockClose = vi.fn();

vi.mock('nostr-tools', async (importOriginal) => {
  const orig = await importOriginal<typeof import('nostr-tools')>();
  return {
    ...orig,
    SimplePool: vi.fn().mockImplementation(() => ({
      querySync: mockQuerySync,
      publish: mockPublish,
      subscribeMany: mockSubscribeMany,
      close: mockClose,
    })),
  };
});

import { NostrPool } from '../src';

beforeEach(() => {
  vi.clearAllMocks();
  mockQuerySync.mockResolvedValue([]);
  mockPublish.mockReturnValue([Promise.resolve('ok')]);
  mockSubscribeMany.mockReturnValue({ close: vi.fn() });
});

const TEST_RELAYS = ['wss://r1.test', 'wss://r2.test'];

// --- querySync ---

describe('NostrPool.querySync', () => {
  it('returns events from relays', async () => {
    const fakeEvent = { id: 'e1', kind: 1 } as Event;
    mockQuerySync.mockResolvedValue([fakeEvent]);

    const pool = new NostrPool(TEST_RELAYS);
    const result = await pool.querySync({ kinds: [1] } as Filter);
    expect(result).toEqual([fakeEvent]);
    expect(mockQuerySync).toHaveBeenCalledWith(TEST_RELAYS, { kinds: [1] });
  });

  it('returns result before timeout fires', async () => {
    // Mock resolves after 50ms - faster than QUERY_TIMEOUT_MS
    const fakeEvent = { id: 'e1', kind: 1 } as Event;
    mockQuerySync.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([fakeEvent]), 50)),
    );

    const pool = new NostrPool(TEST_RELAYS);
    const result = await pool.querySync({ kinds: [1] } as Filter);
    expect(result).toEqual([fakeEvent]);
  });
});

// --- queryBatched ---

describe('NostrPool.queryBatched', () => {
  it('splits keys into batches', async () => {
    const pool = new NostrPool(TEST_RELAYS);
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5'];

    mockQuerySync.mockResolvedValue([]);
    await pool.queryBatched({ kinds: [0] }, keys, 2); // batchSize=2

    // Should be 3 batches: [k1,k2], [k3,k4], [k5]
    expect(mockQuerySync).toHaveBeenCalledTimes(3);
    expect(mockQuerySync.mock.calls[0]![1].authors).toEqual(['k1', 'k2']);
    expect(mockQuerySync.mock.calls[1]![1].authors).toEqual(['k3', 'k4']);
    expect(mockQuerySync.mock.calls[2]![1].authors).toEqual(['k5']);
  });

  it('merges results from all batches', async () => {
    const pool = new NostrPool(TEST_RELAYS);
    const e1 = { id: '1' } as Event;
    const e2 = { id: '2' } as Event;

    mockQuerySync.mockResolvedValueOnce([e1]).mockResolvedValueOnce([e2]);

    const result = await pool.queryBatched({ kinds: [0] }, ['k1', 'k2'], 1);
    expect(result).toEqual([e1, e2]);
  });
});

// --- queryBatchedByTag ---

describe('NostrPool.queryBatchedByTag', () => {
  it('splits tag values into batches', async () => {
    const pool = new NostrPool(TEST_RELAYS);
    mockQuerySync.mockResolvedValue([]);

    await pool.queryBatchedByTag({ kinds: [7000] } as Filter, 'e', ['v1', 'v2', 'v3'], 2);

    expect(mockQuerySync).toHaveBeenCalledTimes(2);
    expect(mockQuerySync.mock.calls[0]![1]['#e']).toEqual(['v1', 'v2']);
    expect(mockQuerySync.mock.calls[1]![1]['#e']).toEqual(['v3']);
  });
});

// --- publish ---

describe('NostrPool.publish', () => {
  it('succeeds if any relay accepts', async () => {
    mockPublish.mockReturnValue([Promise.reject(new Error('relay1 down')), Promise.resolve('ok')]);

    const pool = new NostrPool(TEST_RELAYS);
    await expect(pool.publish({ id: 'e1' } as Event)).resolves.toBeUndefined();
  });

  it('throws if all relays reject', async () => {
    mockPublish.mockReturnValue([
      Promise.reject(new Error('relay1 down')),
      Promise.reject(new Error('relay2 down')),
    ]);

    const pool = new NostrPool(TEST_RELAYS);
    await expect(pool.publish({ id: 'e1' } as Event)).rejects.toThrow('Failed to publish');
  });
});

// --- publishAll ---

describe('NostrPool.publishAll', () => {
  it('succeeds if at least one relay accepts', async () => {
    mockPublish.mockReturnValue([Promise.reject(new Error('relay1 down')), Promise.resolve('ok')]);

    const pool = new NostrPool(TEST_RELAYS);
    await expect(pool.publishAll({ id: 'e1' } as Event)).resolves.toBeUndefined();
  });

  it('throws if no relay accepts', async () => {
    mockPublish.mockReturnValue([
      Promise.reject(new Error('fail1')),
      Promise.reject(new Error('fail2')),
    ]);

    const pool = new NostrPool(TEST_RELAYS);
    await expect(pool.publishAll({ id: 'e1' } as Event)).rejects.toThrow('Failed to publish');
  });
});

// --- subscribe ---

describe('NostrPool.subscribe', () => {
  it('returns closable subscription', () => {
    const rawClose = vi.fn();
    mockSubscribeMany.mockReturnValue({ close: rawClose });

    const pool = new NostrPool(TEST_RELAYS);
    const onEvent = vi.fn();
    const sub = pool.subscribe({ kinds: [1] } as Filter, onEvent);

    expect(mockSubscribeMany).toHaveBeenCalledTimes(1);
    sub.close();
    expect(rawClose).toHaveBeenCalled();
  });

  it('forwards oneose callback to subscribeMany', () => {
    mockSubscribeMany.mockReturnValue({ close: vi.fn() });

    const pool = new NostrPool(TEST_RELAYS);
    const onEvent = vi.fn();
    const oneose = vi.fn();
    pool.subscribe({ kinds: [1] } as Filter, onEvent, { oneose });

    const params = mockSubscribeMany.mock.calls[0]![2];
    expect(params.onevent).toBe(onEvent);
    expect(params.oneose).toBe(oneose);

    // Simulate relay sending EOSE - the wrapped callback should fire ours.
    params.oneose();
    expect(oneose).toHaveBeenCalledTimes(1);
  });
});

// --- close ---

describe('NostrPool.close', () => {
  it('closes pool and cleans up', () => {
    const pool = new NostrPool(TEST_RELAYS);
    pool.close();
    expect(mockClose).toHaveBeenCalledWith(TEST_RELAYS);
  });

  it('closes active subscriptions on close', () => {
    const rawClose = vi.fn();
    mockSubscribeMany.mockReturnValue({ close: rawClose });

    const pool = new NostrPool(TEST_RELAYS);
    pool.subscribe({ kinds: [1] } as Filter, vi.fn());
    pool.subscribe({ kinds: [2] } as Filter, vi.fn());
    pool.close();

    // Both subscriptions should be closed
    expect(rawClose).toHaveBeenCalledTimes(2);
  });
});

// --- reset ---

describe('NostrPool.reset', () => {
  it('closes existing pool and creates new one', () => {
    const pool = new NostrPool(TEST_RELAYS);
    pool.reset();
    expect(mockClose).toHaveBeenCalledWith(TEST_RELAYS);
  });

  it('invokes registered onReset listeners after recreating the pool', () => {
    const pool = new NostrPool(TEST_RELAYS);
    const listener = vi.fn();
    pool.onReset(listener);

    pool.reset();
    expect(listener).toHaveBeenCalledTimes(1);

    pool.reset();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops further listener calls', () => {
    const pool = new NostrPool(TEST_RELAYS);
    const listener = vi.fn();
    const unsubscribe = pool.onReset(listener);

    pool.reset();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    pool.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates listener errors - one bad listener does not block others', () => {
    const pool = new NostrPool(TEST_RELAYS);
    const bad = vi.fn(() => {
      throw new Error('listener boom');
    });
    const good = vi.fn();
    pool.onReset(bad);
    pool.onReset(good);

    expect(() => pool.reset()).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

// --- getRelays ---

describe('NostrPool.getRelays', () => {
  it('returns configured relays', () => {
    const pool = new NostrPool(TEST_RELAYS);
    expect(pool.getRelays()).toEqual(TEST_RELAYS);
  });
});

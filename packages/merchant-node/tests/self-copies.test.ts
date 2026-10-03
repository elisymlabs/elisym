import type { NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  SELF_COPY_CONCURRENCY,
  SELF_COPY_QUEUE_MAX,
  SELF_COPY_RETRY_DELAYS_MS,
} from '../src/constants';
import { SelfCopies } from '../src/self-copies';

function copy(id: string): NostrEvent {
  return { id, pubkey: 'p', created_at: 0, kind: 1059, tags: [], content: '', sig: 's' };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await Promise.resolve();
  }
}

function harness(answer: (wrap: NostrEvent) => Promise<string[]>) {
  const published: string[] = [];
  const logs: string[] = [];
  const timers: { ms: number; task: () => void }[] = [];
  const copies = new SelfCopies({
    publish: (wrap) => {
      published.push(wrap.id);
      return answer(wrap);
    },
    log: (message) => logs.push(message),
    later: (ms, task) => {
      timers.push({ ms, task });
    },
  });
  return { copies, published, logs, timers };
}

describe('the store copy queue', () => {
  it('publishes a copy once when a relay takes it', async () => {
    const { copies, published, logs, timers } = harness(async () => ['wss://a']);
    copies.add(copy('c1'), 'k1');
    await settle();
    expect(published).toEqual(['c1']);
    expect(logs).toEqual([]);
    expect(copies.pending).toBe(0);
    // One relay is enough: no retry is scheduled.
    expect(timers).toEqual([]);
  });

  it('tries a copy no relay took three times in all, then logs it lost', async () => {
    const { copies, published, logs, timers } = harness(async () => []);
    copies.add(copy('c1'), 'k1');
    await settle();
    // Waiting out a retry pause still counts: it would be lost on exit.
    expect(copies.pending).toBe(1);
    for (const delay of SELF_COPY_RETRY_DELAYS_MS) {
      const timer = timers.shift();
      expect(timer?.ms).toBe(delay);
      timer?.task();
      await settle();
    }
    expect(published).toEqual(['c1', 'c1', 'c1']);
    expect(timers).toEqual([]);
    expect(copies.pending).toBe(0);
    expect(logs).toEqual(['copy for k1 lost: taken by 0 relays']);
  });

  it('counts a publish that throws as taken by no relay', async () => {
    const { copies, timers } = harness(async () => {
      throw new Error('relay down');
    });
    copies.add(copy('c1'), 'k1');
    await settle();
    expect(timers).toHaveLength(1);
  });

  it('holds the drain while paused, and sends what waited on resume', async () => {
    const { copies, published } = harness(async () => ['wss://a']);
    copies.pause();
    copies.pause();
    copies.add(copy('c1'), 'k1');
    await settle();
    expect(published).toEqual([]);
    copies.resume();
    await settle();
    expect(published).toEqual([]);
    copies.resume();
    await settle();
    expect(published).toEqual(['c1']);
  });

  it('publishes a few at a time', async () => {
    const releases: (() => void)[] = [];
    const { copies, published } = harness(
      () =>
        new Promise<string[]>((resolve) => {
          releases.push(() => resolve(['wss://a']));
        }),
    );
    for (let index = 0; index < SELF_COPY_CONCURRENCY + 3; index += 1) {
      copies.add(copy(`c${index}`), `k${index}`);
    }
    await settle();
    expect(published).toHaveLength(SELF_COPY_CONCURRENCY);
    releases.shift()?.();
    await settle();
    expect(published).toHaveLength(SELF_COPY_CONCURRENCY + 1);
    expect(copies.pending).toBe(SELF_COPY_CONCURRENCY + 2);
  });

  it('drops, and logs, only what overflows the queue', async () => {
    const { copies, logs } = harness(async () => ['wss://a']);
    copies.pause();
    for (let index = 0; index < SELF_COPY_QUEUE_MAX + 2; index += 1) {
      copies.add(copy(`c${index}`), `k${index}`);
    }
    expect(copies.pending).toBe(SELF_COPY_QUEUE_MAX);
    expect(logs).toEqual([
      `copy for k${SELF_COPY_QUEUE_MAX} lost: the copy queue is full`,
      `copy for k${SELF_COPY_QUEUE_MAX + 1} lost: the copy queue is full`,
    ]);
  });
});

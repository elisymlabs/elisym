import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUESTS_CHANNEL } from '../src/db/db';
import { REQUEST_POLL_MS, RequestPump } from '../src/node/request-pump';
import { settle } from './helpers/node-store';

afterEach(() => {
  vi.useRealTimers();
});

function fakes() {
  const listeners = new Map<string, () => void>();
  const calls = { drains: 0, ticks: 0, unlistened: false };
  let release: (() => void) | undefined;
  /** What each round's drains are (default: done at once). */
  let drained: Promise<void> = Promise.resolve();
  const db = {
    listen: async (channel: string, onNotify: () => void) => {
      listeners.set(channel, onNotify);
      return async () => {
        calls.unlistened = true;
      };
    },
  };
  const holder = {
    kickAll: async () => {
      calls.drains += 1;
      if (release !== undefined) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { drained };
    },
    tick: async () => {
      calls.ticks += 1;
    },
  };
  return {
    db,
    holder,
    calls,
    listeners,
    /** Hold the next drains until `free` is called. */
    hold: () => {
      release = () => undefined;
    },
    free: () => {
      const done = release;
      release = undefined;
      done?.();
    },
    /** The drains the next rounds start run until the returned function is called. */
    slowDrains: () => {
      let finish: () => void = () => undefined;
      drained = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return finish;
    },
  };
}

describe('RequestPump', () => {
  it('drains on a notify, drains and ticks on the poll and at start, never two rounds at once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const world = fakes();
    const pump = new RequestPump({ db: world.db, holder: world.holder, log: () => undefined });
    await pump.start();
    await settle();
    expect(world.calls).toMatchObject({ drains: 1, ticks: 1 });

    world.listeners.get(REQUESTS_CHANNEL)?.();
    await settle();
    expect(world.calls).toMatchObject({ drains: 2, ticks: 1 });

    world.hold();
    world.listeners.get(REQUESTS_CHANNEL)?.();
    await settle();
    expect(world.calls.drains).toBe(3);
    world.listeners.get(REQUESTS_CHANNEL)?.();
    vi.advanceTimersByTime(REQUEST_POLL_MS);
    await settle();
    expect(world.calls.drains).toBe(3);
    world.free();
    await settle();
    // The notify and the poll during the round: one more round, with the tick.
    expect(world.calls).toMatchObject({ drains: 4, ticks: 2 });

    await pump.stop();
    expect(world.calls.unlistened).toBe(true);
    vi.advanceTimersByTime(REQUEST_POLL_MS * 3);
    await settle();
    expect(world.calls.drains).toBe(4);
  });

  it('keeps the tick of a poll during a round when a notify follows it (R3)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const world = fakes();
    const pump = new RequestPump({ db: world.db, holder: world.holder, log: () => undefined });
    await pump.start();
    await settle();
    expect(world.calls).toMatchObject({ drains: 1, ticks: 1 });
    world.hold();
    world.listeners.get(REQUESTS_CHANNEL)?.();
    await settle();
    vi.advanceTimersByTime(REQUEST_POLL_MS);
    world.listeners.get(REQUESTS_CHANNEL)?.();
    world.free();
    await settle();
    expect(world.calls).toMatchObject({ drains: 3, ticks: 2 });
    await pump.stop();
  });

  it('keeps going after a round that throws', async () => {
    const world = fakes();
    let fail = true;
    const logs: string[] = [];
    const pump = new RequestPump({
      db: world.db,
      holder: {
        kickAll: async () => {
          if (fail) {
            fail = false;
            throw new Error('db down');
          }
          return world.holder.kickAll();
        },
        tick: world.holder.tick,
      },
      log: (line) => logs.push(line),
    });
    await pump.kick(true);
    await pump.kick(false);
    expect(logs).toEqual(['request round failed: db down']);
    expect(world.calls).toMatchObject({ drains: 1, ticks: 1 });
  });

  it('resolves stop only once the drains its rounds started are done', async () => {
    const world = fakes();
    const finish = world.slowDrains();
    const pump = new RequestPump({ db: world.db, holder: world.holder, log: () => undefined });
    await pump.start();
    await settle();
    // The round is over: it only started the drains.
    expect(world.calls.drains).toBe(1);
    let stopped = false;
    void pump.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    finish();
    await settle();
    expect(stopped).toBe(true);
  });
});

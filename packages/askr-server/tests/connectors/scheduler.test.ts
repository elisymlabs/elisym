import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectorSyncResult } from '../../src/connectors/runner';
import { ConnectorScheduler, type SchedulerTimers } from '../../src/connectors/scheduler';

const OK: ConnectorSyncResult = {
  status: 'ok',
  diff: { created: [], updated: [], hidden: [], unchanged: [] },
  truncated: [],
  skipped: [],
};
const FAILED: ConnectorSyncResult = { status: 'error', message: 'boom' };

interface Store {
  storeId: string;
  intervalMs: number;
}

/** Manual timers on a manual clock. */
class FakeClock implements SchedulerTimers {
  now = 0;
  private nextId = 0;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    this.nextId += 1;
    this.pending.set(this.nextId, { at: this.now + ms, callback });
    return this.nextId;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      this.pending.delete(handle);
    }
  }

  get timerCount(): number {
    return this.pending.size;
  }

  /** Advance, firing due timers in time order and letting their async work settle. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.pending) {
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) {
          next = entry;
        }
      }
      if (!next) {
        break;
      }
      this.pending.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
      await settle();
    }
    this.now = end;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface Harness {
  clock: FakeClock;
  scheduler: ConnectorScheduler<Store>;
  runs: Array<{ storeId: string; at: number }>;
  saved: Array<{ storeId: string; status: string; at: number; nextRunAt: number }>;
  stores: Store[];
  outcomes: Map<string, ConnectorSyncResult[]>;
}

const running: Array<ConnectorScheduler<Store>> = [];

afterEach(() => {
  for (const scheduler of running.splice(0)) {
    scheduler.stop();
  }
});

function harness(stores: Store[], overrides: { maxConcurrent?: number } = {}): Harness {
  const clock = new FakeClock();
  const runs: Harness['runs'] = [];
  const saved: Harness['saved'] = [];
  const outcomes = new Map<string, ConnectorSyncResult[]>();
  const state: Harness = {
    clock,
    runs,
    saved,
    stores,
    outcomes,
    scheduler: new ConnectorScheduler<Store>({
      loadStores: async () => state.stores,
      sync: async (store) => {
        runs.push({ storeId: store.storeId, at: clock.now });
        const result = outcomes.get(store.storeId)?.shift() ?? OK;
        if (result === FAILED && store.storeId.startsWith('throw')) {
          throw new Error('thrown');
        }
        return result;
      },
      saveStatus: async (store, result, at, nextRunAt) => {
        saved.push({ storeId: store.storeId, status: result.status, at, nextRunAt });
      },
      timers: clock,
      now: () => clock.now,
      random: () => 0,
      maxBackoffMs: 8_000,
      ...overrides,
    }),
  };
  running.push(state.scheduler);
  return state;
}

describe('ConnectorScheduler', () => {
  it('polls each store at its own interval', async () => {
    const test = harness([
      { storeId: 'a', intervalMs: 1_000 },
      { storeId: 'b', intervalMs: 3_000 },
    ]);
    await test.scheduler.start();
    await test.clock.advance(6_000);
    expect(test.runs.filter((run) => run.storeId === 'a').map((run) => run.at)).toEqual([
      0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000,
    ]);
    expect(test.runs.filter((run) => run.storeId === 'b').map((run) => run.at)).toEqual([
      0, 3_000, 6_000,
    ]);
    expect(test.saved[0]).toEqual({ storeId: 'a', status: 'ok', at: 0, nextRunAt: 1_000 });
  });

  it('backs off exponentially on failure, capped, and resets after a success', async () => {
    const test = harness([{ storeId: 'a', intervalMs: 1_000 }]);
    test.outcomes.set('a', [FAILED, FAILED, FAILED, FAILED, OK]);
    await test.scheduler.start();
    await test.clock.advance(40_000);
    const times = test.runs.map((run) => run.at);
    // Failures wait 2s, 4s, 8s, then the 8s cap; the success at 22s goes back to 1s.
    expect(times.slice(0, 7)).toEqual([0, 2_000, 6_000, 14_000, 22_000, 23_000, 24_000]);
    expect(test.saved.slice(0, 5).map((entry) => entry.status)).toEqual([
      'error',
      'error',
      'error',
      'error',
      'ok',
    ]);
  });

  it('treats a thrown sync as a failure', async () => {
    const test = harness([{ storeId: 'throw-1', intervalMs: 1_000 }]);
    test.outcomes.set('throw-1', [FAILED]);
    await test.scheduler.start();
    await test.clock.advance(0);
    expect(test.saved[0]).toMatchObject({ status: 'error', nextRunAt: 2_000 });
  });

  it('backs off on a failed verification or a closed source too', async () => {
    const test = harness([{ storeId: 'a', intervalMs: 1_000 }]);
    test.outcomes.set('a', [
      {
        status: 'verification_failed',
        failures: [{ origin: 'https://a.example', reason: 'not_found' }],
      },
      { status: 'source_closed', url: 'https://a.example', reason: 'HTTP 401', httpStatus: 401 },
    ]);
    await test.scheduler.start();
    await test.clock.advance(6_000);
    expect(test.runs.map((run) => run.at)).toEqual([0, 2_000, 6_000]);
  });

  it('runs at most maxConcurrent syncs at once', async () => {
    const clock = new FakeClock();
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const scheduler = new ConnectorScheduler<Store>({
      loadStores: async () => [
        { storeId: 'a', intervalMs: 1_000 },
        { storeId: 'b', intervalMs: 1_000 },
        { storeId: 'c', intervalMs: 1_000 },
      ],
      sync: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return OK;
      },
      saveStatus: async () => undefined,
      timers: clock,
      now: () => clock.now,
      random: () => 0,
      maxConcurrent: 2,
    });
    running.push(scheduler);
    await scheduler.start();
    await clock.advance(0);
    expect(active).toBe(2);
    releases.shift()?.();
    await settle();
    expect(active).toBe(2);
    releases.splice(0).forEach((release) => release());
    await settle();
    expect(peak).toBe(2);
  });

  it('never syncs one store twice at once, even when it is removed and re-added mid-sync', async () => {
    const clock = new FakeClock();
    let active = 0;
    let peak = 0;
    let starts = 0;
    const releases: Array<() => void> = [];
    let stores: Store[] = [{ storeId: 'a', intervalMs: 1_000 }];
    const saved: string[] = [];
    const scheduler = new ConnectorScheduler<Store>({
      loadStores: async () => stores,
      sync: async () => {
        starts += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return OK;
      },
      saveStatus: async (store) => {
        saved.push(store.storeId);
      },
      timers: clock,
      now: () => clock.now,
      random: () => 0,
      maxConcurrent: 2,
    });
    running.push(scheduler);
    await scheduler.start();
    await clock.advance(0);
    expect(active).toBe(1);
    stores = [];
    await scheduler.refresh();
    stores = [{ storeId: 'a', intervalMs: 1_000 }];
    await scheduler.refresh();
    scheduler.runNow('a');
    await clock.advance(0);
    expect(active).toBe(1);
    expect(starts).toBe(1);
    // The first sync ends: the re-added store's due run starts then, not before.
    releases.shift()?.();
    await settle();
    expect(starts).toBe(2);
    expect(peak).toBe(1);
    releases.shift()?.();
    await settle();
    expect(saved).toEqual(['a']);
    expect(clock.timerCount).toBe(1);
  });

  it('a stop and start while a store syncs does not start a second sync of it', async () => {
    const clock = new FakeClock();
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const scheduler = new ConnectorScheduler<Store>({
      loadStores: async () => [{ storeId: 'a', intervalMs: 1_000 }],
      sync: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return OK;
      },
      saveStatus: async () => undefined,
      timers: clock,
      now: () => clock.now,
      random: () => 0,
      maxConcurrent: 2,
    });
    running.push(scheduler);
    await scheduler.start();
    await clock.advance(0);
    scheduler.stop();
    await scheduler.start();
    await clock.advance(0);
    expect(peak).toBe(1);
    releases.splice(0).forEach((release) => release());
    await settle();
    releases.splice(0).forEach((release) => release());
    await settle();
    expect(peak).toBe(1);
  });

  it('picks up added stores, drops removed ones and applies a new interval', async () => {
    const test = harness([{ storeId: 'a', intervalMs: 1_000 }]);
    await test.scheduler.start();
    await test.clock.advance(1_000);
    test.stores = [
      { storeId: 'a', intervalMs: 5_000 },
      { storeId: 'b', intervalMs: 1_000 },
    ];
    await test.scheduler.refresh();
    await test.clock.advance(5_000);
    expect(test.runs.filter((run) => run.storeId === 'a').map((run) => run.at)).toEqual([
      0, 1_000, 6_000,
    ]);
    expect(test.runs.filter((run) => run.storeId === 'b').map((run) => run.at)).toEqual([
      1_000, 2_000, 3_000, 4_000, 5_000, 6_000,
    ]);
    test.stores = [{ storeId: 'a', intervalMs: 5_000 }];
    await test.scheduler.refresh();
    const before = test.runs.length;
    await test.clock.advance(3_000);
    expect(test.runs.slice(before).some((run) => run.storeId === 'b')).toBe(false);
  });

  it('spreads first runs over one interval', async () => {
    const clock = new FakeClock();
    const runs: number[] = [];
    const scheduler = new ConnectorScheduler<Store>({
      loadStores: async () => [{ storeId: 'a', intervalMs: 10_000 }],
      sync: async () => {
        runs.push(clock.now);
        return OK;
      },
      saveStatus: async () => undefined,
      timers: clock,
      now: () => clock.now,
      random: () => 0.25,
    });
    running.push(scheduler);
    await scheduler.start();
    await clock.advance(12_500);
    expect(runs).toEqual([2_500, 12_500]);
  });

  it('runNow syncs a store at once', async () => {
    const test = harness([{ storeId: 'a', intervalMs: 60_000 }]);
    await test.scheduler.start();
    await test.clock.advance(1);
    test.scheduler.runNow('a');
    await test.clock.advance(0);
    expect(test.runs.map((run) => run.at)).toEqual([0, 1]);
  });

  it('stop() clears every timer and no run is scheduled after it', async () => {
    const test = harness([{ storeId: 'a', intervalMs: 1_000 }]);
    await test.scheduler.start();
    await test.clock.advance(1_000);
    test.scheduler.stop();
    expect(test.clock.timerCount).toBe(0);
    const before = test.runs.length;
    await test.clock.advance(10_000);
    expect(test.runs).toHaveLength(before);
  });

  it('keeps polling when saving the status fails', async () => {
    const clock = new FakeClock();
    const errors: unknown[] = [];
    let runs = 0;
    const scheduler = new ConnectorScheduler<Store>({
      loadStores: async () => [{ storeId: 'a', intervalMs: 1_000 }],
      sync: async () => {
        runs += 1;
        return OK;
      },
      saveStatus: async () => {
        throw new Error('db down');
      },
      timers: clock,
      now: () => clock.now,
      random: () => 0,
      onError: (error) => errors.push(error),
    });
    running.push(scheduler);
    await scheduler.start();
    await clock.advance(2_000);
    expect(runs).toBe(3);
    expect(errors).toHaveLength(3);
  });
});

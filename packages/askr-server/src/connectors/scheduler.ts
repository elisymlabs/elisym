import { DEFAULT_MAX_CONCURRENT_SYNCS, MAX_SYNC_BACKOFF_MS } from './constants';
import type { ConnectorSyncResult } from './runner';

/** What the scheduler needs of a connected store; persistence adds the rest. */
export interface ScheduledStore {
  storeId: string;
  /** Poll interval for this store's tier, in milliseconds. */
  intervalMs: number;
}

export interface SchedulerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ConnectorSchedulerDeps<Store extends ScheduledStore> {
  /** Every store with an active connector (the first import already confirmed). */
  loadStores(): Promise<Store[]>;
  /** One sync of one store, e.g. `syncConnector` with its settings. */
  sync(store: Store): Promise<ConnectorSyncResult>;
  /** Persist the outcome; `nextRunAt` is when the scheduler will try again (ms). */
  saveStatus(
    store: Store,
    result: ConnectorSyncResult,
    at: number,
    nextRunAt: number,
  ): Promise<void>;
  timers?: SchedulerTimers;
  now?: () => number;
  /** In [0, 1): spreads the first runs over one interval so a restart is no burst. */
  random?: () => number;
  maxConcurrent?: number;
  maxBackoffMs?: number;
  onError?: (error: unknown) => void;
}

interface Entry<Store> {
  store: Store;
  timer: unknown;
  failures: number;
  running: boolean;
}

/** Real timers behind numeric handles, so the interface needs no platform timer type. */
function realTimers(): SchedulerTimers {
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 0;
  return {
    setTimeout: (callback, ms) => {
      nextId += 1;
      const id = nextId;
      handles.set(
        id,
        setTimeout(() => {
          handles.delete(id);
          callback();
        }, ms),
      );
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') {
        clearTimeout(handles.get(handle));
        handles.delete(handle);
      }
    },
  };
}

/**
 * Polls each connected store every `intervalMs` (7.4 "polling every N minutes
 * by tier"). A run that is not `ok` (including a failed verification, which
 * pauses publishing) backs off exponentially: interval times 2^failures, at
 * most `maxBackoffMs`; the next `ok` resets it. Runs across stores are limited
 * to `maxConcurrent` at a time.
 */
export class ConnectorScheduler<Store extends ScheduledStore> {
  private readonly entries = new Map<string, Entry<Store>>();
  private readonly waiting: string[] = [];
  private readonly timers: SchedulerTimers;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxConcurrent: number;
  private readonly maxBackoffMs: number;
  private active = 0;
  private stopped = false;

  constructor(private readonly deps: ConnectorSchedulerDeps<Store>) {
    this.timers = deps.timers ?? realTimers();
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SYNCS);
    this.maxBackoffMs = deps.maxBackoffMs ?? MAX_SYNC_BACKOFF_MS;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
  }

  /** Reload the store list: schedule new stores, drop removed ones, apply new intervals. */
  async refresh(): Promise<void> {
    const stores = await this.deps.loadStores();
    if (this.stopped) {
      return;
    }
    const ids = new Set(stores.map((store) => store.storeId));
    for (const [storeId, entry] of this.entries) {
      if (!ids.has(storeId)) {
        this.timers.clearTimeout(entry.timer);
        this.entries.delete(storeId);
      }
    }
    for (const store of stores) {
      const entry = this.entries.get(store.storeId);
      if (!entry) {
        const fresh: Entry<Store> = {
          store,
          timer: undefined,
          failures: 0,
          running: false,
        };
        this.entries.set(store.storeId, fresh);
        this.schedule(fresh, Math.floor(this.random() * store.intervalMs));
      } else if (entry.store.intervalMs !== store.intervalMs) {
        entry.store = store;
        if (!entry.running) {
          this.schedule(entry, this.delayFor(entry));
        }
      } else {
        entry.store = store;
      }
    }
  }

  /** Sync one store as soon as a slot is free (e.g. after the merchant fixed verification). */
  runNow(storeId: string): void {
    const entry = this.entries.get(storeId);
    if (entry && !entry.running) {
      this.schedule(entry, 0);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      this.timers.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    this.entries.clear();
    this.waiting.length = 0;
  }

  private delayFor(entry: Entry<Store>): number {
    if (entry.failures === 0) {
      return entry.store.intervalMs;
    }
    return Math.min(this.maxBackoffMs, entry.store.intervalMs * 2 ** Math.min(entry.failures, 30));
  }

  private schedule(entry: Entry<Store>, delayMs: number): void {
    this.timers.clearTimeout(entry.timer);
    entry.timer = this.timers.setTimeout(() => {
      entry.timer = undefined;
      this.enqueue(entry.store.storeId);
    }, delayMs);
  }

  private enqueue(storeId: string): void {
    if (this.stopped || this.waiting.includes(storeId)) {
      return;
    }
    this.waiting.push(storeId);
    this.drain();
  }

  private drain(): void {
    while (!this.stopped && this.active < this.maxConcurrent) {
      const storeId = this.waiting.shift();
      if (storeId === undefined) {
        return;
      }
      const entry = this.entries.get(storeId);
      if (!entry || entry.running) {
        continue;
      }
      void this.run(entry);
    }
  }

  private async run(entry: Entry<Store>): Promise<void> {
    this.active += 1;
    entry.running = true;
    let result: ConnectorSyncResult;
    try {
      result = await this.deps.sync(entry.store);
    } catch (error) {
      result = {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    entry.running = false;
    this.active -= 1;
    if (this.stopped || this.entries.get(entry.store.storeId) !== entry) {
      this.drain();
      return;
    }
    entry.failures = result.status === 'ok' ? 0 : entry.failures + 1;
    const delay = this.delayFor(entry);
    const at = this.now();
    this.schedule(entry, delay);
    try {
      await this.deps.saveStatus(entry.store, result, at, at + delay);
    } catch (error) {
      this.deps.onError?.(error);
    }
    this.drain();
  }
}

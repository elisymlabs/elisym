import type { CatalogItemInput, SyncDiff } from '@elisym/askr';
import { SYNC_POLL_MS } from '../constants';
import { ApiError } from './api';
import { changesOf, importItems } from './catalog';
import type { AdminClient } from './deps';
import { errorMessage, invalidItemIssues } from './errors';
import type { StoreView } from './types';

/** How many polls, `SYNC_POLL_MS` apart (30 s in all), a store being set up or a running sync is waited out. */
export const WAIT_MAX_POLLS = 10;

/** A failed `store()` poll after a 202 is retried this many times before the result is unknown. */
const STORE_POLL_RETRIES = 2;

/** Said with a setting-up refusal while one of the store's signed events failed a publish. */
export const WAITING_TO_PUBLISH =
  'A change is still waiting to be published (see Waiting to publish in Overview). It may clear by itself; Retry in a moment.';

const EMPTY_DIFF: SyncDiff = { created: [], updated: [], hidden: [], unchanged: [] };

/**
 * A sleep that Cancel or an unmount ends at once: once stopped, every sleep
 * returns at once and `stopped` tells the waiting code to send nothing more.
 */
export class Pause {
  private stoppedNow = false;
  private wake: (() => void) | undefined;

  get stopped(): boolean {
    return this.stoppedNow;
  }

  sleep(ms: number): Promise<void> {
    if (this.stoppedNow) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }

  stop(): void {
    this.stoppedNow = true;
    this.wake?.();
  }
}

/** A refusal still standing once the store's setting up was waited out, in the merchant's words. */
export class SettingUpRefusal extends Error {
  constructor(refusal: unknown, waiting: boolean) {
    super(waiting ? `${errorMessage(refusal)} ${WAITING_TO_PUBLISH}` : errorMessage(refusal), {
      cause: refusal,
    });
    this.name = 'SettingUpRefusal';
  }
}

export type Settled<T> = { kind: 'done'; value: T } | { kind: 'cancelled' };

export interface SettingUpInput<T> {
  /** The request: sent first, with no check before it. */
  attempt: () => Promise<T>;
  /** The refusal code that means the server's key is not authorized on the relay yet. */
  refusal: 'sync_refused' | 'publish_refused';
  store: () => Promise<StoreView>;
  sleep: (ms: number) => Promise<void>;
  /** True once Cancel or an unmount stopped the wait: nothing more is sent. */
  cancelled: () => boolean;
  /** A setting-up sleep starts (no request is open, so it may be cancelled). */
  onWait?: () => void;
  pollMs?: number;
  maxPolls?: number;
}

/**
 * Right after a plan is chosen the store's signed events (its settings, the
 * server key's authorization) are still on their way to the relay, which
 * refuses what the server key publishes until they are there. Such a refusal
 * is retried while the store has events waiting and none failing, and once
 * more on the first read with none waiting, for at most `maxPolls` polls.
 */
export async function whileSettingUp<T>(input: SettingUpInput<T>): Promise<Settled<T>> {
  const pollMs = input.pollMs ?? SYNC_POLL_MS;
  const maxPolls = input.maxPolls ?? WAIT_MAX_POLLS;
  let polls = 0;
  let lastChance = false;
  for (;;) {
    if (input.cancelled()) {
      return { kind: 'cancelled' };
    }
    try {
      return { kind: 'done', value: await input.attempt() };
    } catch (error) {
      if (!(error instanceof ApiError && error.code === input.refusal)) {
        throw error;
      }
      if (lastChance || polls >= maxPolls) {
        throw new SettingUpRefusal(error, false);
      }
      if (input.cancelled()) {
        return { kind: 'cancelled' };
      }
      let view: StoreView;
      try {
        view = await input.store();
      } catch {
        throw new SettingUpRefusal(error, false);
      }
      // One failed attempt lists an event: the server retries it, so it is not final, but the
      // merchant is pointed at it rather than kept waiting.
      if (view.events.failing.length > 0) {
        throw new SettingUpRefusal(error, true);
      }
      // None waiting: the relay may have just taken the last one, so one more try.
      if (view.events.pending === 0) {
        lastChance = true;
      }
      polls += 1;
      input.onWait?.();
      await input.sleep(pollMs);
    }
  }
}

/** A change to the catalog: products to publish and product IDs to delete. */
export interface CatalogChangeInput {
  items: readonly CatalogItemInput[];
  hide: readonly string[];
}

/** What the server K lists on the relay: readable products and every listed product ID. */
export interface CatalogRead {
  listings: CatalogItemInput[];
  ids: string[];
}

export type WriteState = 'queued' | 'waiting-sync' | 'setting-up' | 'sending' | 'publishing';

export interface WriteProgress {
  state: WriteState;
  /** Only while no request is open: one in flight may already have been accepted. */
  cancellable: boolean;
  /** The planned counts, once the server accepted the write. */
  diff?: SyncDiff;
  /** The id the accepted write's sync shows under in `GET /store`. */
  syncId?: string;
}

export type Outcome =
  | { kind: 'ok'; diff: SyncDiff }
  | { kind: 'failed'; message: string; issues: string[] }
  /** Sent, but whether it went through could not be read. */
  | { kind: 'unknown' }
  | { kind: 'cancelled' }
  /** A replace whose count of removed products changed while it waited: asked again, not sent. */
  | { kind: 'recount'; hidden: number; fresh: CatalogRead };

const CANCELLED: Outcome = { kind: 'cancelled' };
const UNKNOWN: Outcome = { kind: 'unknown' };

export type CatalogApi = Pick<AdminClient, 'catalog' | 'store'>;

export interface BuildContext {
  /** 0 first, then one more after each wait for a running sync. */
  attempt: number;
  api: CatalogApi;
  sleep: (ms: number) => Promise<void>;
  cancelled: () => boolean;
  onState: (progress: WriteProgress) => void;
  pollMs: number;
}

export type Built =
  | { kind: 'send'; change: CatalogChangeInput }
  | { kind: 'stop'; outcome: Outcome };

export interface WriteInput {
  api: CatalogApi;
  /** The change to send, built again after every wait for a running sync. */
  build: (context: BuildContext) => Promise<Built>;
  sleep: (ms: number) => Promise<void>;
  cancelled: () => boolean;
  onState: (progress: WriteProgress) => void;
  pollMs?: number;
  maxSettingUpPolls?: number;
}

/**
 * An error the server may have acted on: no answer, a gateway or server
 * failure (a proxy timing out while the server went on), or a 2xx whose body
 * could not be read.
 */
function mayHaveArrived(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'network' || error.status >= 500 || (error.status >= 200 && error.status < 300))
  );
}

function failedOf(error: unknown): Outcome {
  return { kind: 'failed', message: errorMessage(error), issues: invalidItemIssues(error) };
}

/** Follow an accepted write to its end in `GET /store`, by the `syncId` its 202 gave. */
async function follow(
  input: WriteInput,
  pollMs: number,
  answer: { diff: SyncDiff; syncId?: string },
): Promise<Outcome> {
  const syncId = answer.syncId;
  input.onState({
    state: 'publishing',
    cancellable: false,
    diff: answer.diff,
    ...(typeof syncId === 'string' ? { syncId } : {}),
  });
  // An older server names no sync: its end cannot be told from another's.
  if (typeof syncId !== 'string') {
    return UNKNOWN;
  }
  let failures = 0;
  for (;;) {
    // Stopped only by the session ending: the server finishes the sync anyway.
    if (input.cancelled()) {
      return UNKNOWN;
    }
    let view: StoreView;
    try {
      view = await input.api.store();
      failures = 0;
    } catch {
      failures += 1;
      if (failures > STORE_POLL_RETRIES) {
        return UNKNOWN;
      }
      await input.sleep(pollMs);
      continue;
    }
    const sync = view.catalogSync;
    // Another sync recorded since (another tab, the SDK): this one ended unseen.
    if (sync === null || typeof sync.syncId !== 'string' || sync.syncId !== syncId) {
      return UNKNOWN;
    }
    if (sync.state === 'done') {
      return { kind: 'ok', diff: sync.diff };
    }
    if (sync.state === 'failed') {
      return { kind: 'failed', message: `Publishing failed: ${sync.error}`, issues: [] };
    }
    await input.sleep(pollMs);
  }
}

/**
 * One catalog write (2.1): sent at once, with no dry run first (the server runs
 * one and refuses before publishing anything). A running sync is waited out and
 * the change built again; a store being set up is waited out too. Cancel works
 * only while no request is open.
 */
export async function writeCatalog(input: WriteInput): Promise<Outcome> {
  const pollMs = input.pollMs ?? SYNC_POLL_MS;
  for (let attempt = 0; ; attempt += 1) {
    if (input.cancelled()) {
      return CANCELLED;
    }
    let built: Built;
    try {
      built = await input.build({
        attempt,
        api: input.api,
        sleep: input.sleep,
        cancelled: input.cancelled,
        onState: input.onState,
        pollMs,
      });
    } catch (error) {
      return failedOf(error);
    }
    if (built.kind === 'stop') {
      return built.outcome;
    }
    if (input.cancelled()) {
      return CANCELLED;
    }
    const { change } = built;
    let settled: Settled<{ diff: SyncDiff; syncId?: string }>;
    try {
      settled = await whileSettingUp({
        attempt: () => {
          input.onState({ state: 'sending', cancellable: false });
          return input.api.catalog(change, false);
        },
        refusal: 'sync_refused',
        store: () => input.api.store(),
        sleep: input.sleep,
        cancelled: input.cancelled,
        onWait: () => input.onState({ state: 'setting-up', cancellable: true }),
        pollMs,
        ...(input.maxSettingUpPolls === undefined ? {} : { maxPolls: input.maxSettingUpPolls }),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'sync_running') {
        input.onState({ state: 'waiting-sync', cancellable: true });
        await input.sleep(pollMs);
        continue;
      }
      if (error instanceof SettingUpRefusal) {
        return { kind: 'failed', message: error.message, issues: [] };
      }
      return mayHaveArrived(error) ? UNKNOWN : failedOf(error);
    }
    if (settled.kind === 'cancelled') {
      return CANCELLED;
    }
    return follow(input, pollMs, settled.value);
  }
}

/** One write the queue holds: a product saved or removed, or a CSV import. */
export type CatalogOp =
  | { kind: 'save'; item: CatalogItemInput; isNew: boolean }
  /**
   * `label` names what goes: a product's title, or a count of unreadable ones; `unreadable` marks
   * the removal of listed products the admin cannot read.
   */
  | { kind: 'remove'; ids: string[]; label: string; unreadable?: boolean }
  | { kind: 'merge'; items: CatalogItemInput[] }
  /** `fresh` is the read the merchant confirmed `hidden` removals against. */
  | { kind: 'replace'; items: CatalogItemInput[]; fresh: CatalogRead; hidden: number };

export interface QueueEntry {
  id: number;
  op: CatalogOp;
  progress: WriteProgress;
  /** Set once the write ended; a finished entry stays until dismissed. */
  outcome: Outcome | undefined;
}

export interface CatalogQueueOptions {
  api: CatalogApi;
  /** Read the store again: on each 202, and once each write ends. */
  reload: () => Promise<unknown>;
  /** The catalog as the relay has it now, for an import built from a fresh read. */
  readProducts: () => Promise<CatalogRead>;
  pollMs?: number;
  maxSettingUpPolls?: number;
}

/** Wait until no catalog sync runs: a connector sync can still hold the guard unseen. */
async function untilNoSync(context: BuildContext): Promise<boolean> {
  for (;;) {
    if (context.cancelled()) {
      return false;
    }
    context.onState({ state: 'sending', cancellable: false });
    const view = await context.api.store();
    if (view.catalogSync?.state !== 'running') {
      return true;
    }
    context.onState({ state: 'waiting-sync', cancellable: true });
    await context.sleep(context.pollMs);
  }
}

function sentOrDone(change: CatalogChangeInput & { untouched: string[] }): Built {
  if (change.items.length === 0 && change.hide.length === 0) {
    return {
      kind: 'stop',
      outcome: { kind: 'ok', diff: { ...EMPTY_DIFF, unchanged: change.untouched } },
    };
  }
  return { kind: 'send', change: { items: change.items, hide: change.hide } };
}

/**
 * The session's catalog writes, one at a time in order (2.1). It lives as long
 * as the signed-in session, so switching tabs neither drops a write nor loses
 * its outcome; `dispose` cancels whatever was not accepted yet.
 */
export class CatalogQueue {
  readonly pollMs: number;
  private readonly options: CatalogQueueOptions;
  private list: readonly QueueEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly pauses = new Map<number, Pause>();
  private readonly resolvers = new Map<number, (outcome: Outcome) => void>();
  private readonly ownSyncs = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private nextId = 1;
  private disposed = false;

  constructor(options: CatalogQueueOptions) {
    this.options = options;
    this.pollMs = options.pollMs ?? SYNC_POLL_MS;
  }

  /** Every entry, in order; a new array on each change. */
  entries(): readonly QueueEntry[] {
    return this.list;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Whether a sync with this id is one of this session's writes. */
  ownsSync(syncId: string): boolean {
    return this.ownSyncs.has(syncId);
  }

  enqueue(op: CatalogOp): { id: number; done: Promise<Outcome> } {
    const id = this.nextId;
    this.nextId += 1;
    const done = new Promise<Outcome>((resolve) => {
      this.resolvers.set(id, resolve);
    });
    if (this.disposed) {
      this.resolvers.get(id)?.(CANCELLED);
      this.resolvers.delete(id);
      return { id, done };
    }
    this.change([
      ...this.list,
      { id, op, progress: { state: 'queued', cancellable: true }, outcome: undefined },
    ]);
    this.tail = this.tail.then(() => this.run(id));
    return { id, done };
  }

  /** Cancel a write not sent yet, or one sleeping between requests; one in flight goes on. */
  cancel(id: number): void {
    const entry = this.list.find((candidate) => candidate.id === id);
    if (entry === undefined || entry.outcome !== undefined || !entry.progress.cancellable) {
      return;
    }
    const pause = this.pauses.get(id);
    if (pause === undefined) {
      this.finish(id, CANCELLED);
      return;
    }
    pause.stop();
  }

  /** Forget a finished entry once its outcome was shown or acted on. */
  dismiss(id: number): void {
    const entry = this.list.find((candidate) => candidate.id === id);
    if (entry === undefined || entry.outcome === undefined) {
      return;
    }
    this.change(this.list.filter((candidate) => candidate.id !== id));
  }

  /** The session ended: every write not accepted is cancelled, every sleep and poll stops. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of this.list) {
      if (entry.outcome !== undefined) {
        continue;
      }
      const pause = this.pauses.get(entry.id);
      if (pause === undefined) {
        this.finish(entry.id, CANCELLED);
      } else {
        pause.stop();
      }
    }
  }

  private change(next: readonly QueueEntry[]): void {
    this.list = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private update(id: number, progress: WriteProgress): void {
    this.change(
      this.list.map((entry) =>
        entry.id === id && entry.outcome === undefined ? { ...entry, progress } : entry,
      ),
    );
  }

  private finish(id: number, outcome: Outcome): void {
    // A cancelled write leaves nothing to show.
    this.change(
      outcome.kind === 'cancelled'
        ? this.list.filter((entry) => entry.id !== id)
        : this.list.map((entry) => (entry.id === id ? { ...entry, outcome } : entry)),
    );
    this.resolvers.get(id)?.(outcome);
    this.resolvers.delete(id);
  }

  private reloadQuietly(): void {
    if (this.disposed) {
      return;
    }
    this.options.reload().catch(() => undefined);
  }

  private build(op: CatalogOp, context: BuildContext): Promise<Built> {
    if (op.kind === 'save') {
      return Promise.resolve({ kind: 'send', change: { items: [op.item], hide: [] } });
    }
    if (op.kind === 'remove') {
      return Promise.resolve({ kind: 'send', change: { items: [], hide: op.ids } });
    }
    return op.kind === 'merge'
      ? this.buildMerge(op.items, context)
      : this.buildReplace(op, context);
  }

  private async buildMerge(items: CatalogItemInput[], context: BuildContext): Promise<Built> {
    // Before the first read and after every wait for a running sync: never a half-written relay.
    if (!(await untilNoSync(context))) {
      return { kind: 'stop', outcome: CANCELLED };
    }
    context.onState({ state: 'sending', cancellable: false });
    const fresh = await this.options.readProducts();
    // Only new and changed products go, which keeps a large file under the request limit.
    return sentOrDone(changesOf(fresh.listings, importItems(fresh.listings, items, 'merge'), []));
  }

  private async buildReplace(
    op: Extract<CatalogOp, { kind: 'replace' }>,
    context: BuildContext,
  ): Promise<Built> {
    let fresh = op.fresh;
    if (context.attempt > 0) {
      if (!(await untilNoSync(context))) {
        return { kind: 'stop', outcome: CANCELLED };
      }
      context.onState({ state: 'sending', cancellable: false });
      fresh = await this.options.readProducts();
    }
    const change = changesOf(fresh.listings, op.items, fresh.ids);
    // The catalog changed while it waited: the merchant confirms the new count first.
    if (change.hide.length !== op.hidden) {
      return { kind: 'stop', outcome: { kind: 'recount', hidden: change.hide.length, fresh } };
    }
    return sentOrDone(change);
  }

  private async run(id: number): Promise<void> {
    const entry = this.list.find((candidate) => candidate.id === id);
    if (entry === undefined || entry.outcome !== undefined) {
      return;
    }
    const pause = new Pause();
    this.pauses.set(id, pause);
    let accepted = false;
    const outcome = await writeCatalog({
      api: this.options.api,
      build: (context) => this.build(entry.op, context),
      sleep: (ms) => pause.sleep(ms),
      cancelled: () => pause.stopped,
      onState: (progress) => {
        if (progress.syncId !== undefined) {
          this.ownSyncs.add(progress.syncId);
        }
        this.update(id, progress);
        if (progress.state === 'publishing' && !accepted) {
          accepted = true;
          this.reloadQuietly();
        }
      },
      pollMs: this.pollMs,
      ...(this.options.maxSettingUpPolls === undefined
        ? {}
        : { maxSettingUpPolls: this.options.maxSettingUpPolls }),
    }).catch((error: unknown) => failedOf(error));
    this.pauses.delete(id);
    this.finish(id, outcome);
    this.reloadQuietly();
  }
}

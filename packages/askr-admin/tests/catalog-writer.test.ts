import type { CatalogItemInput, SyncDiff } from '@elisym/askr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import {
  type Built,
  type CatalogApi,
  type CatalogRead,
  CatalogQueue,
  type Outcome,
  Pause,
  WAITING_TO_PUBLISH,
  type WriteProgress,
  whileSettingUp,
  writeCatalog,
} from '../src/lib/catalog-writer';
import type { StoreView } from '../src/lib/types';
import { catalogSyncOf, failedSyncOf, fakeApi, storeView } from './fakes';

const DIFF: SyncDiff = { created: ['mug'], updated: [], hidden: [], unchanged: [] };
const MUG: CatalogItemInput = { d: 'mug', title: 'Mug', price: { amount: '12', currency: 'USD' } };
const TEA: CatalogItemInput = { d: 'tea', title: 'Tea', price: { amount: '4', currency: 'USD' } };
const SAVE_MUG = { items: [MUG], hide: [] };

afterEach(() => {
  vi.useRealTimers();
});

const accepted = (syncId = 'sync-1'): { diff: SyncDiff; started: boolean; syncId?: string } => ({
  diff: DIFF,
  started: true,
  syncId,
});
const doneView = (syncId = 'sync-1') =>
  storeView({ catalogSync: catalogSyncOf('done', { syncId, diff: DIFF }) });
const settingUp = (pending: number, failing: StoreView['events']['failing'] = []) =>
  storeView({ events: { pending, failing } });
const refused = () => new ApiError(409, 'sync_refused', { message: 'K is not authorized yet' });
const syncRunning = () => new ApiError(409, 'sync_running');

/** An API whose `catalog` and `store` answer in order, the last answer repeated. */
function scripted(
  catalog: readonly (Error | ReturnType<typeof accepted>)[],
  store: readonly (Error | StoreView)[],
): CatalogApi {
  let catalogCalls = 0;
  let storeCalls = 0;
  return {
    catalog: vi.fn(async () => {
      const answer = catalog[Math.min(catalogCalls, catalog.length - 1)];
      catalogCalls += 1;
      if (answer === undefined || answer instanceof Error) {
        throw answer ?? new Error('no answer scripted');
      }
      return answer;
    }),
    store: vi.fn(async () => {
      const answer = store[Math.min(storeCalls, store.length - 1)];
      storeCalls += 1;
      if (answer === undefined || answer instanceof Error) {
        throw answer ?? new Error('no answer scripted');
      }
      return answer;
    }),
  };
}

function write(api: CatalogApi, cancelled: () => boolean = () => false) {
  const states: WriteProgress[] = [];
  const sleep = vi.fn(async () => undefined);
  const outcome = writeCatalog({
    api,
    build: async (): Promise<Built> => ({ kind: 'send', change: SAVE_MUG }),
    sleep,
    cancelled,
    onState: (progress) => states.push(progress),
    pollMs: 1,
  });
  return { outcome, states, sleep };
}

describe('one catalog write', () => {
  it('sends first, with no check of the store before it', async () => {
    const api = scripted([accepted()], [doneView()]);
    const { outcome } = write(api);
    expect(await outcome).toEqual({ kind: 'ok', diff: DIFF });
    expect(vi.mocked(api.catalog).mock.calls).toEqual([[SAVE_MUG, false]]);
    expect(vi.mocked(api.catalog).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.store).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('waits out a running sync without an error, then sends again', async () => {
    const api = scripted([syncRunning(), syncRunning(), accepted()], [doneView()]);
    const { outcome, states } = write(api);
    expect(await outcome).toEqual({ kind: 'ok', diff: DIFF });
    expect(api.catalog).toHaveBeenCalledTimes(3);
    expect(states.filter((state) => state.state === 'waiting-sync')).toHaveLength(2);
    expect(states.find((state) => state.state === 'waiting-sync')?.cancellable).toBe(true);
  });

  it('retries a setting-up refusal while events wait, and once more when none do', async () => {
    const api = scripted(
      [refused(), refused(), refused(), accepted()],
      [settingUp(2), settingUp(1), settingUp(0), doneView()],
    );
    const { outcome, states } = write(api);
    expect(await outcome).toEqual({ kind: 'ok', diff: DIFF });
    expect(api.catalog).toHaveBeenCalledTimes(4);
    expect(states.some((state) => state.state === 'setting-up' && state.cancellable)).toBe(true);
  });

  it('gives up once none wait and the relay still refuses, with the server reason', async () => {
    const api = scripted([refused()], [settingUp(0)]);
    const { outcome } = write(api);
    expect(await outcome).toEqual({
      kind: 'failed',
      message: 'The product sync could not start: K is not authorized yet',
      issues: [],
    });
    expect(api.catalog).toHaveBeenCalledTimes(2);
  });

  it('stops after its 30 s bound with the server reason', async () => {
    const api = scripted([refused()], [settingUp(1)]);
    const { outcome, sleep } = write(api);
    expect(await outcome).toMatchObject({
      kind: 'failed',
      message: 'The product sync could not start: K is not authorized yet',
    });
    expect(sleep).toHaveBeenCalledTimes(10);
    expect(api.catalog).toHaveBeenCalledTimes(11);
  });

  it('fails at once while a signed event is failing, pointing at Waiting to publish', async () => {
    const failing = [{ id: 'e', kind: 30497, failures: 1, attempts: 1, stopped: false }];
    const api = scripted([refused()], [settingUp(1, failing)]);
    const { outcome } = write(api);
    expect(await outcome).toEqual({
      kind: 'failed',
      message: `The product sync could not start: K is not authorized yet ${WAITING_TO_PUBLISH}`,
      issues: [],
    });
    expect(api.catalog).toHaveBeenCalledTimes(1);
  });

  it('follows only its own sync: another one recorded since means its end is unknown', async () => {
    const running = storeView({ catalogSync: catalogSyncOf('running', { syncId: 'sync-1' }) });
    const api = scripted([accepted()], [running, doneView('sync-2')]);
    expect(await write(api).outcome).toEqual({ kind: 'unknown' });
  });

  it('retries a failed store poll twice, then calls the result unknown', async () => {
    const lost = new ApiError(0, 'network');
    expect(await write(scripted([accepted()], [lost, lost, doneView()])).outcome).toEqual({
      kind: 'ok',
      diff: DIFF,
    });
    expect(await write(scripted([accepted()], [lost, lost, lost, doneView()])).outcome).toEqual({
      kind: 'unknown',
    });
  });

  it('ends with the sync: done, or failed with its error', async () => {
    const running = storeView({ catalogSync: catalogSyncOf('running', { syncId: 'sync-1' }) });
    const { outcome, states } = write(scripted([accepted()], [running, running, doneView()]));
    expect(await outcome).toEqual({ kind: 'ok', diff: DIFF });
    expect(states.find((state) => state.state === 'publishing')).toEqual({
      state: 'publishing',
      cancellable: false,
      diff: DIFF,
      syncId: 'sync-1',
    });
    const failed = storeView({ catalogSync: failedSyncOf('relay down', 'sync-1') });
    expect(await write(scripted([accepted()], [failed])).outcome).toEqual({
      kind: 'failed',
      message: 'Publishing failed: relay down',
      issues: [],
    });
  });

  it('shows the rows an invalid_items refusal names, and the plan size', async () => {
    const invalid = new ApiError(400, 'invalid_items', {
      issues: [{ path: [0, 'price', 'amount'], message: 'not a number' }],
    });
    expect(await write(scripted([invalid], [])).outcome).toEqual({
      kind: 'failed',
      message: 'Some products are not valid. Fix the rows shown and retry.',
      issues: ['item 1: price.amount: not a number'],
    });
    const tooMany = new ApiError(400, 'too_many_products', { max: 100 });
    expect(await write(scripted([tooMany], [])).outcome).toMatchObject({
      kind: 'failed',
      message: 'Your plan allows at most 100 products. Remove some and retry.',
    });
  });

  it('a 202 or a view with no sync id (an older server) is unknown, never matched', async () => {
    expect(await write(scripted([{ diff: DIFF, started: true }], [doneView()])).outcome).toEqual({
      kind: 'unknown',
    });
    const noId = storeView({ catalogSync: catalogSyncOf('done', { syncId: null }) });
    expect(await write(scripted([accepted()], [noId])).outcome).toEqual({ kind: 'unknown' });
  });

  it('an error the server may have acted on is unknown; a refusal stays failed', async () => {
    for (const error of [
      new ApiError(0, 'network'),
      new ApiError(502, 'unexpected'),
      new ApiError(504, 'unexpected'),
      new ApiError(200, 'unexpected'),
    ]) {
      expect(await write(scripted([error], [])).outcome).toEqual({ kind: 'unknown' });
    }
    for (const error of [new ApiError(400, 'bad_request'), new ApiError(409, 'inactive')]) {
      expect(await write(scripted([error], [])).outcome).toMatchObject({ kind: 'failed' });
    }
  });
});

describe('a policy save while the store is set up', () => {
  it('retries publish_refused while events wait, then saves', async () => {
    const putPolicy = vi
      .fn<() => Promise<{ id: string }>>()
      .mockRejectedValueOnce(new ApiError(409, 'publish_refused', { message: 'not yet' }))
      .mockRejectedValueOnce(new ApiError(409, 'publish_refused', { message: 'not yet' }))
      .mockResolvedValue({ id: 'p' });
    const store = vi.fn(async () => settingUp(1));
    const settled = await whileSettingUp({
      attempt: putPolicy,
      refusal: 'publish_refused',
      store,
      sleep: async () => undefined,
      cancelled: () => false,
    });
    expect(settled).toEqual({ kind: 'done', value: { id: 'p' } });
    expect(putPolicy).toHaveBeenCalledTimes(3);
  });

  it('passes any other refusal on at once', async () => {
    await expect(
      whileSettingUp({
        attempt: async () => {
          throw new ApiError(409, 'inactive');
        },
        refusal: 'publish_refused',
        store: async () => settingUp(1),
        sleep: async () => undefined,
        cancelled: () => false,
      }),
    ).rejects.toMatchObject({ code: 'inactive' });
  });
});

/** A queue over `api`, polling every millisecond, with its reloads counted. */
function queueOver(
  api: CatalogApi,
  readProducts: () => Promise<CatalogRead> = async () => EMPTY_READ,
) {
  const reload = vi.fn(async () => undefined);
  const queue = new CatalogQueue({ api, reload, readProducts, pollMs: 1 });
  return { queue, reload };
}
const EMPTY_READ: CatalogRead = { listings: [], ids: [] };

/** Resolves once `until` holds, checking every few milliseconds. */
async function waitFor(until: () => boolean): Promise<void> {
  for (let round = 0; round < 400 && !until(); round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!until()) {
    throw new Error('did not happen');
  }
}

describe('the catalog queue', () => {
  it('writes one at a time, in order, and reloads the store on each 202 and each end', async () => {
    const api = fakeApi();
    const { queue, reload } = queueOver(api);
    const first = queue.enqueue({ kind: 'save', item: MUG, isNew: true });
    const second = queue.enqueue({ kind: 'remove', ids: ['old'], label: 'Old' });
    expect(queue.entries().map((entry) => entry.progress.state)).toEqual(['queued', 'queued']);
    expect((await first.done).kind).toBe('ok');
    expect((await second.done).kind).toBe('ok');
    expect(vi.mocked(api.catalog).mock.calls.map((call) => call[0])).toEqual([
      { items: [MUG], hide: [] },
      { items: [], hide: ['old'] },
    ]);
    // A reload on each 202 and one when each write ends, with no page listening.
    expect(reload).toHaveBeenCalledTimes(4);
    expect(queue.ownsSync('sync-1')).toBe(true);
    expect(queue.ownsSync('sync-2')).toBe(true);
    expect(queue.ownsSync('sync-other')).toBe(false);
  });

  it('a write cancelled while queued is never sent', async () => {
    let letGo: () => void = () => undefined;
    const api = fakeApi();
    const catalog = vi.mocked(api.catalog).getMockImplementation();
    vi.mocked(api.catalog).mockImplementationOnce(async (change, dryRun) => {
      await new Promise<void>((resolve) => {
        letGo = resolve;
      });
      if (catalog === undefined) {
        throw new Error('no catalog');
      }
      return catalog(change, dryRun);
    });
    const { queue } = queueOver(api);
    const first = queue.enqueue({ kind: 'save', item: MUG, isNew: true });
    const second = queue.enqueue({ kind: 'save', item: TEA, isNew: true });
    await waitFor(() => vi.mocked(api.catalog).mock.calls.length === 1);
    // The first is in flight: its Cancel does nothing, and its 202 is followed to the end.
    expect(queue.entries()[0]?.progress).toEqual({ state: 'sending', cancellable: false });
    queue.cancel(first.id);
    queue.cancel(second.id);
    expect(await second.done).toEqual({ kind: 'cancelled' });
    letGo();
    expect((await first.done).kind).toBe('ok');
    expect(api.catalog).toHaveBeenCalledTimes(1);
    expect(queue.entries().map((entry) => entry.id)).toEqual([first.id]);
  });

  it('a write cancelled while it waits for a running sync sends nothing more', async () => {
    const api = scripted([syncRunning()], []);
    const queue = new CatalogQueue({
      api,
      reload: async () => undefined,
      readProducts: async () => EMPTY_READ,
      pollMs: 60_000,
    });
    const { id, done } = queue.enqueue({ kind: 'save', item: MUG, isNew: true });
    await waitFor(() => queue.entries()[0]?.progress.state === 'waiting-sync');
    queue.cancel(id);
    expect(await done).toEqual({ kind: 'cancelled' });
    expect(api.catalog).toHaveBeenCalledTimes(1);
    expect(queue.entries()).toEqual([]);
  });

  it('a write cancelled while the store is set up sends nothing more', async () => {
    const api = scripted([refused()], [settingUp(1)]);
    const queue = new CatalogQueue({
      api,
      reload: async () => undefined,
      readProducts: async () => EMPTY_READ,
      pollMs: 60_000,
    });
    const { id, done } = queue.enqueue({ kind: 'save', item: MUG, isNew: true });
    await waitFor(() => queue.entries()[0]?.progress.state === 'setting-up');
    queue.cancel(id);
    expect(await done).toEqual({ kind: 'cancelled' });
    expect(api.catalog).toHaveBeenCalledTimes(1);
    expect(api.store).toHaveBeenCalledTimes(1);
  });

  it('dispose while waiting on a running sync: no further call, no timer left', async () => {
    vi.useFakeTimers();
    const api = scripted([syncRunning()], []);
    const reload = vi.fn(async () => undefined);
    const queue = new CatalogQueue({
      api,
      reload,
      readProducts: async () => EMPTY_READ,
    });
    const { done } = queue.enqueue({ kind: 'save', item: MUG, isNew: true });
    queue.enqueue({ kind: 'remove', ids: ['old'], label: 'Old' });
    await vi.advanceTimersByTimeAsync(10);
    expect(api.catalog).toHaveBeenCalledTimes(1);
    queue.dispose();
    expect(await done).toEqual({ kind: 'cancelled' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.catalog).toHaveBeenCalledTimes(1);
    expect(api.store).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a CSV merge waits for a sync held unseen (a connector), then reads again and resends', async () => {
    const api = scripted([syncRunning(), accepted()], [storeView(), doneView()]);
    const reads: CatalogRead[] = [
      { listings: [MUG], ids: ['mug'] },
      { listings: [{ ...MUG, title: 'Big mug' }, TEA], ids: ['mug', 'tea'] },
    ];
    let read = 0;
    const readProducts = vi.fn(async () => {
      const next = reads[Math.min(read, reads.length - 1)] ?? EMPTY_READ;
      read += 1;
      return next;
    });
    const { queue } = queueOver(api, readProducts);
    const { done } = queue.enqueue({ kind: 'merge', items: [MUG, TEA] });
    expect((await done).kind).toBe('ok');
    expect(readProducts).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.catalog).mock.calls.map((call) => call[0])).toEqual([
      // Against the first read: only the new product goes.
      { items: [TEA], hide: [] },
      // Against the second: the relay's mug changed, the file's goes back; tea is there already.
      { items: [MUG], hide: [] },
    ]);
  });

  it('a CSV merge waits while a catalog sync shows running before it reads', async () => {
    const running = storeView({ catalogSync: catalogSyncOf('running') });
    const api = scripted([accepted()], [running, running, storeView(), doneView()]);
    const readProducts = vi.fn(async () => EMPTY_READ);
    const { queue } = queueOver(api, readProducts);
    const { done } = queue.enqueue({ kind: 'merge', items: [MUG] });
    expect((await done).kind).toBe('ok');
    expect(api.store).toHaveBeenCalledTimes(4);
    expect(vi.mocked(api.store).mock.invocationCallOrder[2]).toBeLessThan(
      readProducts.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('a replace whose removals changed while it waited asks again; an unchanged one is sent', async () => {
    const confirmed: CatalogRead = { listings: [MUG], ids: ['mug'] };
    const gained: CatalogRead = { listings: [MUG, TEA], ids: ['mug', 'tea'] };
    const changedApi = scripted([syncRunning(), accepted()], [doneView()]);
    const changed = queueOver(changedApi, async () => gained).queue.enqueue({
      kind: 'replace',
      items: [{ ...MUG, title: 'Big mug' }],
      fresh: confirmed,
      hidden: 0,
    });
    const outcome: Outcome = await changed.done;
    expect(outcome).toEqual({ kind: 'recount', hidden: 1, fresh: gained });
    expect(changedApi.catalog).toHaveBeenCalledTimes(1);

    const sameApi = scripted([syncRunning(), accepted()], [doneView()]);
    const same = queueOver(sameApi, async () => confirmed).queue.enqueue({
      kind: 'replace',
      items: [{ ...MUG, title: 'Big mug' }],
      fresh: confirmed,
      hidden: 0,
    });
    expect((await same.done).kind).toBe('ok');
    expect(vi.mocked(sameApi.catalog).mock.calls.map((call) => call[0])).toEqual([
      { items: [{ ...MUG, title: 'Big mug' }], hide: [] },
      { items: [{ ...MUG, title: 'Big mug' }], hide: [] },
    ]);
  });
});

describe('the writer and queue, edge cases', () => {
  it('a good poll between failed ones starts the count of failures again', async () => {
    const lost = new ApiError(0, 'network');
    const running = storeView({ catalogSync: catalogSyncOf('running', { syncId: 'sync-1' }) });
    expect(
      await write(scripted([accepted()], [lost, running, lost, lost, doneView()])).outcome,
    ).toEqual({ kind: 'ok', diff: DIFF });
  });

  it('dispose while publishing stops following the sync: no more store reads', async () => {
    const running = storeView({ catalogSync: catalogSyncOf('running', { syncId: 'sync-1' }) });
    const api = scripted([accepted()], [running]);
    const { queue } = queueOver(api);
    const { done } = queue.enqueue({ kind: 'save', item: MUG, isNew: true });
    await waitFor(() => vi.mocked(api.store).mock.calls.length >= 3);
    queue.dispose();
    expect(await done).toEqual({ kind: 'unknown' });
    const reads = vi.mocked(api.store).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.store).toHaveBeenCalledTimes(reads);
  });

  it('dispose during a failed poll stops at once too', async () => {
    const api = scripted([accepted()], [new ApiError(0, 'network')]);
    const queue = new CatalogQueue({
      api,
      reload: async () => undefined,
      readProducts: async () => EMPTY_READ,
      pollMs: 60_000,
    });
    const { done } = queue.enqueue({ kind: 'save', item: MUG, isNew: true });
    await waitFor(() => vi.mocked(api.store).mock.calls.length === 1);
    queue.dispose();
    expect(await done).toEqual({ kind: 'unknown' });
    expect(api.store).toHaveBeenCalledTimes(1);
  });

  it('a CSV merge the catalog already holds sends nothing', async () => {
    const api = fakeApi();
    const { queue } = queueOver(api, async () => ({ listings: [MUG], ids: ['mug'] }));
    expect((await queue.enqueue({ kind: 'merge', items: [MUG] }).done).kind).toBe('ok');
    expect(api.catalog).not.toHaveBeenCalled();
  });

  it('a write enqueued after dispose is cancelled and never sent', async () => {
    const api = fakeApi();
    const { queue } = queueOver(api);
    queue.dispose();
    expect(await queue.enqueue({ kind: 'save', item: MUG, isNew: true }).done).toEqual({
      kind: 'cancelled',
    });
    expect(queue.entries()).toEqual([]);
    expect(api.catalog).not.toHaveBeenCalled();
  });

  it('a wait cancelled while the refusal was in flight reads nothing more', async () => {
    let cancelled = false;
    const store = vi.fn(async () => settingUp(1));
    const settled = await whileSettingUp({
      attempt: async () => {
        cancelled = true;
        throw new ApiError(409, 'publish_refused');
      },
      refusal: 'publish_refused',
      store,
      sleep: async () => undefined,
      cancelled: () => cancelled,
    });
    expect(settled).toEqual({ kind: 'cancelled' });
    expect(store).not.toHaveBeenCalled();
  });

  it('a merge checks again that no sync shows running before it rebuilds after a wait', async () => {
    const running = storeView({ catalogSync: catalogSyncOf('running') });
    const api = scripted(
      [syncRunning(), accepted()],
      [storeView(), running, storeView(), doneView()],
    );
    const readProducts = vi.fn(async () => EMPTY_READ);
    const { queue } = queueOver(api, readProducts);
    expect((await queue.enqueue({ kind: 'merge', items: [MUG] }).done).kind).toBe('ok');
    expect(readProducts).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.store).mock.invocationCallOrder[2]).toBeLessThan(
      readProducts.mock.invocationCallOrder[1] ?? 0,
    );
  });

  it('a replace checks that no sync shows running before it reads again after a wait', async () => {
    const running = storeView({ catalogSync: catalogSyncOf('running') });
    const api = scripted([syncRunning(), accepted()], [running, storeView(), doneView()]);
    const confirmed: CatalogRead = { listings: [MUG], ids: ['mug'] };
    const readProducts = vi.fn(async () => confirmed);
    const { queue } = queueOver(api, readProducts);
    const { done } = queue.enqueue({ kind: 'replace', items: [TEA], fresh: confirmed, hidden: 1 });
    expect((await done).kind).toBe('ok');
    expect(readProducts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.store).mock.invocationCallOrder[1]).toBeLessThan(
      readProducts.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe('a merge waiting before it reads', () => {
  it('Cancel while a sync shows running ends it: no more store reads, no read of the catalog', async () => {
    const running = storeView({ catalogSync: catalogSyncOf('running') });
    const api = scripted([accepted()], [running]);
    const readProducts = vi.fn(async () => EMPTY_READ);
    const queue = new CatalogQueue({ api, reload: async () => undefined, readProducts, pollMs: 5 });
    const { id, done } = queue.enqueue({ kind: 'merge', items: [MUG] });
    await waitFor(() => queue.entries()[0]?.progress.state === 'waiting-sync');
    expect(queue.entries()[0]?.progress.cancellable).toBe(true);
    queue.cancel(id);
    expect(await done).toEqual({ kind: 'cancelled' });
    const reads = vi.mocked(api.store).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(api.store).toHaveBeenCalledTimes(reads);
    expect(readProducts).not.toHaveBeenCalled();
    expect(api.catalog).not.toHaveBeenCalled();
    expect(queue.entries()).toEqual([]);
  });
});

describe('a replace asked again', () => {
  it('also when fewer products would go after the wait', async () => {
    const confirmed: CatalogRead = { listings: [MUG], ids: ['mug'] };
    const shrunk: CatalogRead = { listings: [], ids: [] };
    const api = scripted([syncRunning(), accepted()], [storeView(), doneView()]);
    const { queue } = queueOver(api, async () => shrunk);
    const outcome = await queue.enqueue({
      kind: 'replace',
      items: [TEA],
      fresh: confirmed,
      hidden: 1,
    }).done;
    expect(outcome).toEqual({ kind: 'recount', hidden: 0, fresh: shrunk });
    expect(api.catalog).toHaveBeenCalledTimes(1);
  });
});

describe('a setting-up refusal whose store read fails', () => {
  it('fails with the server reason alone', async () => {
    const api = scripted([refused()], [new ApiError(0, 'network')]);
    expect(await write(api).outcome).toEqual({
      kind: 'failed',
      message: 'The product sync could not start: K is not authorized yet',
      issues: [],
    });
    expect(api.catalog).toHaveBeenCalledTimes(1);
  });
});

describe('the sweep: writer edges', () => {
  it('a stopped pause sleeps no more', async () => {
    vi.useFakeTimers();
    const pause = new Pause();
    pause.stop();
    let woke = false;
    void pause.sleep(60_000).then(() => {
      woke = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(woke).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose while a store poll is in flight leaves no timer', async () => {
    vi.useFakeTimers();
    let answer: (view: StoreView) => void = () => undefined;
    const api: CatalogApi = {
      catalog: vi.fn(async () => accepted()),
      store: vi.fn(
        () =>
          new Promise<StoreView>((resolve) => {
            answer = resolve;
          }),
      ),
    };
    const queue = new CatalogQueue({
      api,
      reload: async () => undefined,
      readProducts: async () => EMPTY_READ,
    });
    const { done } = queue.enqueue({ kind: 'save', item: MUG, isNew: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(api.store).toHaveBeenCalledTimes(1);
    queue.dispose();
    answer(storeView({ catalogSync: catalogSyncOf('running', { syncId: 'sync-1' }) }));
    expect(await done).toEqual({ kind: 'unknown' });
    expect(vi.getTimerCount()).toBe(0);
    expect(api.store).toHaveBeenCalledTimes(1);
  });

  it('a 500 answer is unknown', async () => {
    expect(await write(scripted([new ApiError(500, 'unexpected')], [])).outcome).toEqual({
      kind: 'unknown',
    });
  });

  it('a merge whose store read or catalog read fails before it sends says why', async () => {
    const storeDown = scripted([accepted()], [new ApiError(0, 'network')]);
    const first = queueOver(storeDown).queue.enqueue({ kind: 'merge', items: [MUG] });
    expect(await first.done).toEqual({
      kind: 'failed',
      message: 'The server could not be reached. Check your connection and retry.',
      issues: [],
    });
    const relayDown = scripted([accepted()], [storeView()]);
    const second = queueOver(relayDown, async () => {
      throw new Error('The relay did not answer');
    }).queue.enqueue({ kind: 'merge', items: [MUG] });
    expect(await second.done).toEqual({
      kind: 'failed',
      message: 'The relay did not answer',
      issues: [],
    });
    expect(storeDown.catalog).not.toHaveBeenCalled();
    expect(relayDown.catalog).not.toHaveBeenCalled();
  });
});

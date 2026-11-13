import { buildCatalogAuth, buildConfigEvent } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { CATALOG_PAGE_LIMIT } from '../src/constants';
import { StoreEventPublisher } from '../src/publisher';
import type { RelayLike, ServerPool } from '../src/relay/pool';
import { readAllPages } from '../src/relay/read-all';
import { poolSyncClient } from '../src/relay/sync-client';
import {
  MAX_PUBLISH_ATTEMPTS,
  PUBLISH_BACKOFF_BASE_SECS,
  PUBLISH_BACKOFF_MAX_SECS,
} from '../src/state/stores';
import { FakePool } from './fake-pool';
import {
  HOLDER,
  NOW,
  ORIGIN,
  type SyntheticStore,
  leaseEpoch,
  stateWith,
  storeRecord,
  syntheticStore,
} from './fixtures';

const VISITOR = 'b'.repeat(64);
const ASK_ID = 'a'.repeat(32);
const RELAY = 'wss://relay.test';
const WRAP: NostrEvent = {
  id: 'f'.repeat(64),
  pubkey: 'e'.repeat(64),
  created_at: NOW,
  kind: 1059,
  tags: [],
  content: '',
  sig: '0'.repeat(128),
};

function configAt(store: SyntheticStore, createdAt: number, assistant = store.assistant) {
  return finalizeEvent(
    buildConfigEvent(
      {
        assistant,
        origins: [ORIGIN],
        name: 'Example Shop',
        language: 'en',
        currency: 'USD',
        source: { kind: 'catalog' },
        catalogKey: store.catalogKey,
        createdAt,
      },
      store.ownerSecret,
    ),
    store.ownerSecret,
  );
}

type RelayMode = 'answer' | 'refuse' | 'unreachable' | 'dropped' | 'silent';

/** A relay whose answer to a publish the test sets: accepted, refused (OK false) or none at all. */
function scriptedRelay() {
  const control: { mode: RelayMode } = { mode: 'answer' };
  const published: string[] = [];
  const pool: Pick<ServerPool, 'ensureRelay'> = {
    async ensureRelay(): Promise<RelayLike> {
      if (control.mode === 'unreachable') {
        throw new Error('connection failed');
      }
      let connected = true;
      return {
        get connected() {
          return connected;
        },
        subscribe() {
          throw new Error('not used');
        },
        async publish(event: NostrEvent) {
          if (control.mode === 'dropped') {
            connected = false;
            throw new Error('relay connection closed');
          }
          if (control.mode === 'silent') {
            throw new Error('publish timed out');
          }
          if (control.mode === 'refuse') {
            throw new Error('blocked: no');
          }
          published.push(event.id);
          return '';
        },
      };
    },
  };
  return { pool, control, published };
}

describe('server core review 2: stored events and the relay (7.3)', () => {
  it('an outage of hours never stops an event; it is published once the relay is back', async () => {
    const store = syntheticStore();
    const { directory } = await stateWith([storeRecord(store)]);
    const [config] = store.events;
    if (!config) {
      throw new Error('fixture events missing');
    }
    await directory.addEvents(store.owner, [config]);
    const { pool, control, published } = scriptedRelay();
    const logs: string[] = [];
    const clock = { now: NOW };
    const publisher = new StoreEventPublisher({
      directory,
      pool,
      relayUrl: RELAY,
      log: (message) => logs.push(message),
      now: () => clock.now,
    });
    const modes: RelayMode[] = ['unreachable', 'dropped', 'silent'];
    const runs = MAX_PUBLISH_ATTEMPTS + 4;
    for (let attempt = 0; attempt < runs; attempt += 1) {
      control.mode = modes[attempt % modes.length] ?? 'unreachable';
      await publisher.run();
      clock.now += PUBLISH_BACKOFF_MAX_SECS;
    }
    expect(await directory.eventStatus(store.owner)).toEqual({
      pending: 1,
      failing: [{ id: config.id, kind: 30496, failures: 0, attempts: runs, stopped: false }],
    });
    expect(logs.every((message) => message.startsWith('relay unreachable for store event'))).toBe(
      true,
    );
    control.mode = 'answer';
    await publisher.run();
    expect(published).toEqual([config.id]);
    expect((await directory.eventStatus(store.owner)).pending).toBe(0);
  });

  it('a run ends at the first unreachable publish: the next events wait, untouched', async () => {
    const store = syntheticStore();
    const { directory } = await stateWith([storeRecord(store)]);
    const [config, auth] = store.events;
    if (!config || !auth) {
      throw new Error('fixture events missing');
    }
    await directory.addEvents(store.owner, [config, auth]);
    const { pool, control } = scriptedRelay();
    const publisher = new StoreEventPublisher({
      directory,
      pool,
      relayUrl: RELAY,
      log: () => undefined,
      now: () => NOW,
    });
    control.mode = 'unreachable';
    await publisher.run();
    const status = await directory.eventStatus(store.owner);
    expect(status.pending).toBe(2);
    expect(status.failing.map((event) => event.attempts)).toEqual([1]);
  });

  it('explicit refusals stop an event even after unreachable attempts', async () => {
    const store = syntheticStore();
    const { directory } = await stateWith([storeRecord(store)]);
    const [config] = store.events;
    if (!config) {
      throw new Error('fixture events missing');
    }
    await directory.addEvents(store.owner, [config]);
    const { pool, control } = scriptedRelay();
    const clock = { now: NOW };
    const publisher = new StoreEventPublisher({
      directory,
      pool,
      relayUrl: RELAY,
      log: () => undefined,
      now: () => clock.now,
    });
    control.mode = 'unreachable';
    await publisher.run();
    control.mode = 'refuse';
    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS + 2; attempt += 1) {
      clock.now += PUBLISH_BACKOFF_MAX_SECS;
      await publisher.run();
    }
    expect(await directory.eventStatus(store.owner)).toEqual({
      pending: 1,
      failing: [
        {
          id: config.id,
          kind: 30496,
          failures: MAX_PUBLISH_ATTEMPTS,
          attempts: MAX_PUBLISH_ATTEMPTS + 1,
          stopped: true,
        },
      ],
    });
  });

  it('the backoff doubles per failed attempt from the base to the maximum', async () => {
    const store = syntheticStore();
    const { directory, db } = await stateWith([storeRecord(store)]);
    const [config] = store.events;
    if (!config) {
      throw new Error('fixture events missing');
    }
    await directory.addEvents(store.owner, [config]);
    const waits: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await directory.markPublishFailed(config.id, NOW, attempt % 2 === 0);
      const [row] = await db.query<{ next_attempt_at: number }>(
        'select next_attempt_at from store_events where id = $1',
        [config.id],
      );
      waits.push((row?.next_attempt_at ?? 0) - NOW);
    }
    const base = PUBLISH_BACKOFF_BASE_SECS;
    expect(waits).toEqual([
      base,
      2 * base,
      4 * base,
      8 * base,
      16 * base,
      32 * base,
      PUBLISH_BACKOFF_MAX_SECS,
      PUBLISH_BACKOFF_MAX_SECS,
    ]);
  });

  it('a failed publish past 2038 is still backed off', async () => {
    const store = syntheticStore();
    const { directory, db } = await stateWith([storeRecord(store)]);
    const [config] = store.events;
    if (!config) {
      throw new Error('fixture events missing');
    }
    await directory.addEvents(store.owner, [config]);
    const after2038 = 2_200_000_000;
    expect(await directory.markPublishFailed(config.id, after2038, true)).toBe(1);
    const [row] = await db.query<{ next_attempt_at: number }>(
      'select next_attempt_at from store_events where id = $1',
      [config.id],
    );
    expect(row?.next_attempt_at).toBe(after2038 + PUBLISH_BACKOFF_BASE_SECS);
  });

  it('a rotation completes only once the relay accepted the config naming the new A', async () => {
    const store = syntheticStore();
    const { directory, state, db } = await stateWith([storeRecord(store)]);
    const next = await directory.beginRotation(store.owner);
    if (next === undefined) {
      throw new Error('no rotation');
    }
    const rotation = configAt(store, NOW, next);
    expect(await directory.addEvents(store.owner, [rotation])).toEqual({ ok: true });
    const { pool, control } = scriptedRelay();
    const notified: string[] = [];
    const unlisten = await db.listen('askr_stores', () => notified.push('notify'));
    const clock = { now: NOW };
    const publisher = new StoreEventPublisher({
      directory,
      pool,
      relayUrl: RELAY,
      log: () => undefined,
      now: () => clock.now,
    });
    for (const mode of ['unreachable', 'refuse'] as const) {
      control.mode = mode;
      await publisher.run();
      clock.now += PUBLISH_BACKOFF_MAX_SECS;
      // Until the relay has it, the old A stays the store's, leased and served.
      expect((await state.store(store.owner))?.assistant).toBe(store.assistant);
      expect((await state.acquireLeases(HOLDER, clock.now, 60))[0]?.store.assistant).toBe(
        store.assistant,
      );
      expect(await directory.nextAssistant(store.owner)).toBe(next);
    }
    notified.length = 0;
    control.mode = 'answer';
    await publisher.run();
    expect((await state.store(store.owner))?.assistant).toBe(next);
    expect(await directory.nextAssistant(store.owner)).toBeUndefined();
    expect((await state.acquireLeases(HOLDER, clock.now, 60))[0]?.store.assistant).toBe(next);
    await expect.poll(() => notified.length).toBeGreaterThan(0);
    await unlisten();
  });

  it('a duplicate event id within one batch is stored once', async () => {
    const store = syntheticStore();
    const { directory } = await stateWith([storeRecord(store)]);
    const [config, auth] = store.events;
    if (!config || !auth) {
      throw new Error('fixture events missing');
    }
    expect(await directory.addEvents(store.owner, [auth, config, auth])).toEqual({ ok: true });
    expect((await directory.eventStatus(store.owner)).pending).toBe(2);
  });

  it('an out-of-order config batch is refused at the older config, storing nothing', async () => {
    const store = syntheticStore();
    const { directory } = await stateWith([storeRecord(store)]);
    const newer = configAt(store, NOW - 100);
    const older = configAt(store, NOW - 150);
    expect(await directory.addEvents(store.owner, [newer, older])).toEqual({
      ok: false,
      reason: 'stale_config',
      id: older.id,
    });
    expect((await directory.eventStatus(store.owner)).pending).toBe(0);
    expect(await directory.addEvents(store.owner, [newer])).toEqual({ ok: true });
    expect((await directory.eventStatus(store.owner)).pending).toBe(1);
  });

  it('a published config is pruned only by a newer published one; a waiting one by any newer one', async () => {
    const store = syntheticStore();
    const { directory, db } = await stateWith([storeRecord(store)]);
    const stored = async () =>
      (
        await db.query<{ id: string }>('select id from store_events where owner = $1 order by id', [
          store.owner,
        ])
      ).map((row) => row.id);
    const first = configAt(store, NOW - 300);
    expect(await directory.addEvents(store.owner, [first])).toEqual({ ok: true });
    await directory.markPublished(first.id);
    const second = configAt(store, NOW - 200);
    expect(await directory.addEvents(store.owner, [second])).toEqual({ ok: true });
    // The newer one is not on the relay yet: the published one it will replace stays.
    expect(await stored()).toEqual([first.id, second.id].sort());
    // A waiting one a newer one replaces is pruned at once: the relay would keep only the newer.
    const third = configAt(store, NOW - 100);
    expect(await directory.addEvents(store.owner, [third])).toEqual({ ok: true });
    expect(await stored()).toEqual([first.id, third.id].sort());
    // Two published configs of the same second replace neither.
    await directory.markPublished(third.id);
    await db.query(
      `update store_events set event = jsonb_set(event, '{created_at}', to_jsonb($2::bigint))
       where id = $1`,
      [first.id, NOW - 100],
    );
    const fourth = configAt(store, NOW - 50);
    expect(await directory.addEvents(store.owner, [fourth])).toEqual({ ok: true });
    expect(await stored()).toEqual([first.id, third.id, fourth.id].sort());
    // Once the newer one is published, the older are pruned on the next store.
    await directory.markPublished(fourth.id);
    const fifth = configAt(store, NOW);
    expect(await directory.addEvents(store.owner, [fifth])).toEqual({ ok: true });
    expect(await stored()).toEqual([fourth.id, fifth.id].sort());
  });

  it('a waiting config whose newer one the relay refused for good stays', async () => {
    const store = syntheticStore();
    const { directory, db } = await stateWith([storeRecord(store)]);
    const older = configAt(store, NOW - 200);
    expect(await directory.addEvents(store.owner, [older])).toEqual({ ok: true });
    const newer = configAt(store, NOW - 100);
    await db.query(
      `insert into store_events (id, owner, event, publish_failures) values ($1, $2, ($3::text)::jsonb, $4)`,
      [newer.id, store.owner, JSON.stringify(newer), MAX_PUBLISH_ATTEMPTS],
    );
    // Any store runs the prune: an authorization of another key.
    const auth = finalizeEvent(
      buildCatalogAuth({
        key: getPublicKey(generateSecretKey()),
        mode: 'self-host',
        createdAt: NOW,
      }),
      store.ownerSecret,
    );
    expect(await directory.addEvents(store.owner, [auth])).toEqual({ ok: true });
    const ids = (
      await db.query<{ id: string }>('select id from store_events where owner = $1', [store.owner])
    ).map((row) => row.id);
    expect(ids).toContain(older.id);
  });
});

describe('server core review 2: ask records (5.8)', () => {
  it('a retry naming an answered attempt is superseded and changes nothing', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const admitted = await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW);
    if (!admitted.admitted) {
      throw new Error('not admitted');
    }
    const { attemptId } = admitted.record;
    // A past deadline: only the answered state keeps the retry out.
    await state.startAsk(session, ASK_ID, attemptId, epoch, NOW * 1000 + 1_000);
    expect(await state.answerAsk(session, ASK_ID, attemptId, epoch, WRAP, '0.01', NOW)).toBe(true);
    expect(await state.retryAsk(session, ASK_ID, attemptId, '0.05', epoch, NOW + 10)).toEqual({
      admitted: false,
      reason: 'superseded',
    });
    expect(await state.askRecord(session, ASK_ID)).toMatchObject({ state: 'answered', attemptId });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.01', reserved: '0' });
  });

  it('a running attempt whose deadline is exactly now is no longer live and is retried', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const admitted = await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW);
    if (!admitted.admitted) {
      throw new Error('not admitted');
    }
    const { attemptId } = admitted.record;
    await state.startAsk(session, ASK_ID, attemptId, epoch, (NOW + 60) * 1000);
    expect(
      (await state.retryAsk(session, ASK_ID, attemptId, '0.05', epoch, NOW + 59)).admitted,
    ).toBe(false);
    expect(
      (await state.retryAsk(session, ASK_ID, attemptId, '0.05', epoch, NOW + 60)).admitted,
    ).toBe(true);
  });

  it('a queued attempt under a lease that expires exactly now is released by the sweep', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    expect((await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW)).admitted).toBe(true);
    // The lease (taken at NOW for 60 s) is still live one second before it expires.
    await state.sweep(NOW + 59);
    expect(await state.askRecord(session, ASK_ID)).toMatchObject({ state: 'queued' });
    await state.sweep(NOW + 60);
    expect(await state.askRecord(session, ASK_ID)).toMatchObject({ state: 'failed' });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0' });
  });

  it('an answer after its session was dropped returns false; the turn settles once', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const admitted = await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW);
    if (!admitted.admitted) {
      throw new Error('not admitted');
    }
    const { attemptId } = admitted.record;
    const deadline = (NOW + 120) * 1000;
    await state.startAsk(session, ASK_ID, attemptId, epoch, deadline);
    // A first message after the session's end replaces (drops) it.
    await state.session(store.owner, store.assistant, VISITOR, session.sessionEnd);
    expect(await state.answerAsk(session, ASK_ID, attemptId, epoch, WRAP, '0.02', NOW)).toBe(false);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0.05' });
    expect(await state.failAsk(session, ASK_ID, attemptId, epoch, '0.02')).toBe(false);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.02', reserved: '0' });
    expect(await state.failAsk(session, ASK_ID, attemptId, epoch, '0.02')).toBe(false);
    await state.sweep(NOW + 600);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.02', reserved: '0' });
  });
});

describe('server core review 2: reading pages (2.4)', () => {
  it('a full page of one second that adds nothing new is not a complete read', async () => {
    const pool = new FakePool();
    const relay = pool.relay(RELAY);
    const author = 'c'.repeat(64);
    for (let index = 0; index <= CATALOG_PAGE_LIMIT; index += 1) {
      relay.accept({
        id: index.toString(16).padStart(64, '0'),
        pubkey: author,
        created_at: NOW,
        kind: 30402,
        tags: [['d', `item-${index}`]],
        content: '',
        sig: '0'.repeat(128),
      });
    }
    const read = await readAllPages(pool, RELAY, [{ kinds: [30402], authors: [author] }], {
      connectionTimeoutMs: 1_000,
    });
    expect(read?.complete).toBe(false);
    expect(read?.events).toHaveLength(CATALOG_PAGE_LIMIT);
    await expect(
      poolSyncClient(pool, RELAY).query([RELAY], { kinds: [30402], authors: [author] }),
    ).rejects.toThrow('Could not read every matching event');
  });

  it('a full page is full by what the relay sent, also events the filter drops', async () => {
    const pool = new FakePool();
    const relay = pool.relay(RELAY);
    const author = 'c'.repeat(64);
    for (let index = 0; index < 700; index += 1) {
      relay.accept({
        id: index.toString(16).padStart(64, '0'),
        pubkey: author,
        created_at: NOW - index,
        kind: 30402,
        tags: [['d', `item-${index}`]],
        content: '',
        sig: '0'.repeat(128),
      });
    }
    // Each page: 490 matching events and 10 another author's: a full page, not the last one.
    relay.pageCap = CATALOG_PAGE_LIMIT - 10;
    relay.stray = () =>
      Array.from({ length: 10 }, (_unused, index) => ({
        id: (90_000 + index).toString(16).padStart(64, '0'),
        pubkey: 'd'.repeat(64),
        created_at: NOW,
        kind: 30402,
        tags: [['d', `stray-${index}`]],
        content: '',
        sig: '0'.repeat(128),
      }));
    const read = await readAllPages(pool, RELAY, [{ kinds: [30402], authors: [author] }], {
      connectionTimeoutMs: 1_000,
    });
    expect(read).toMatchObject({ complete: true });
    expect(read?.events).toHaveLength(700);
  });

  it('a page short of the limit ends a complete read', async () => {
    const pool = new FakePool();
    const relay = pool.relay(RELAY);
    const author = 'c'.repeat(64);
    for (let index = 0; index < 3; index += 1) {
      relay.accept({
        id: index.toString(16).padStart(64, '0'),
        pubkey: author,
        created_at: NOW - index,
        kind: 30402,
        tags: [['d', `item-${index}`]],
        content: '',
        sig: '0'.repeat(128),
      });
    }
    const read = await readAllPages(pool, RELAY, [{ kinds: [30402], authors: [author] }], {
      connectionTimeoutMs: 1_000,
    });
    expect(read).toMatchObject({ complete: true });
    expect(read?.events).toHaveLength(3);
  });
});

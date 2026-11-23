import { OFFER_RELAYS } from '@merchant-node/constants';
import type { NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { OTHER_TREASURY } from '../../merchant-node/tests/fixtures';
import { getRequest } from '../src/admin/requests';
import type { Db } from '../src/db/db';
import type { KeyVault } from '../src/db/keys';
import { TERMS_STAND_SECS, loadStoreBundle } from '../src/node/load';
import { SetupPassFailed, runStoreSetupPass } from '../src/node/setup-pass';
import { OwnerEventPublisher } from '../src/publisher';
import { newHolderId } from '../src/state/leases';
import { PgLedgerStore } from '../src/state/ledger-store';
import { submitRequest } from './helpers/node-requests';
import {
  NOW,
  RELAY,
  RPCS,
  SOLANA_PAYOUTS,
  USDC_DEVNET_CAIP19,
  insertOwnerEvent,
  lease,
  ownerEvents,
  publishedStore,
  seedStore,
  storedLedger,
  testSetupDeps,
  vault,
} from './helpers/node-store';
import { RelayWorld } from './helpers/node-world';
import { freshDb } from './pglite-db';

const NEXT = [{ caip19: USDC_DEVNET_CAIP19, address: OTHER_TREASURY }];

/** A published store seeded in a fresh database, leased, with a handle on its ledger. */
async function published(world = new RelayWorld()) {
  const db = await freshDb();
  const keys = vault();
  const seed = await publishedStore(world);
  await seedStore(db, keys, seed);
  const holder = newHolderId();
  const [leased] = await lease(db, holder);
  const open = () =>
    new PgLedgerStore(db, () => NOW).open(seed.owner.pubkey, leased?.epoch ?? 0, holder);
  return {
    db,
    keys,
    world,
    seed,
    owner: seed.owner.pubkey,
    open,
    holder,
    epoch: leased?.epoch ?? 0,
  };
}

async function ownerEventRow(db: Db, id: string) {
  const [row] = await db.query<{
    recorded: boolean;
    published_at: number | null;
    publish_attempts: number;
    next_attempt_at: number;
  }>(
    'select recorded, published_at, publish_attempts, next_attempt_at from owner_events where id = $1',
    [id],
  );
  return row;
}

async function rowVersion(db: Db, owner: string): Promise<number | undefined> {
  const [row] = await db.query<{ row_version: number }>(
    'select row_version from ledgers where owner = $1',
    [owner],
  );
  return row?.row_version;
}

function pass(db: Db, keys: KeyVault, world: RelayWorld) {
  return testSetupDeps(db, keys, world);
}

describe('the server setup pass', () => {
  it('leaves a committed payout list unrecorded when only the listings went out', async () => {
    const { db, keys, world, seed, owner, open } = await published();
    const next = ownerEvents(seed.owner, seed.store, NEXT, NOW - 60);
    await insertOwnerEvent(db, owner, next.payoutList, JSON.stringify(NEXT), false);
    // The listing changes too (its price), so it is republished.
    await db.query("update products set price_usd = '2' where owner = $1", [owner]);
    world.refuse = (event) => event.id === next.payoutList.id;
    const before = await storedLedger(db, owner);

    const result = await runStoreSetupPass(pass(db, keys, world), owner, await open());

    expect(result).toMatchObject({ kind: 'done', payoutListOut: false });
    expect(result.kind === 'done' && result.outcomes.map((outcome) => outcome.listing)).toEqual([
      'out',
    ]);
    const stored = await storedLedger(db, owner);
    expect(stored.payto).toEqual(before.payto);
    expect(JSON.parse(stored.payto?.payouts ?? '')).toEqual(SOLANA_PAYOUTS);
    expect(stored.listings['course-101']?.eventId).not.toBe(before.listings['course-101']?.eventId);
    expect((await ownerEventRow(db, next.payoutList.id))?.recorded).toBe(false);
    // The new price is payable to the payouts buyers still read: the recorded ones.
    expect(
      stored.terms
        .filter((period) => period.until === undefined)
        .map((period) => [period.terms.amount, period.terms.payout]),
    ).toEqual([['2000000', SOLANA_PAYOUTS[0]?.address]]);
  });

  it('records a committed payout list that went out: the active list switches, published', async () => {
    const { db, keys, world, seed, owner, open } = await published();
    const next = ownerEvents(seed.owner, seed.store, NEXT, NOW - 60);
    await insertOwnerEvent(db, owner, next.payoutList, JSON.stringify(NEXT), false);

    const result = await runStoreSetupPass(pass(db, keys, world), owner, await open());

    expect(result).toMatchObject({ kind: 'done', payoutListOut: true, missedDefaults: [] });
    const stored = await storedLedger(db, owner);
    expect(stored.payto).toEqual({ createdAt: NOW - 60, payouts: JSON.stringify(NEXT) });
    expect(await ownerEventRow(db, next.payoutList.id)).toMatchObject({
      recorded: true,
      published_at: NOW,
    });
  });

  it('keeps the date of an unchanged payout list (payoutListDate)', async () => {
    const { db, keys, world, owner, open } = await published();
    const before = await storedLedger(db, owner);
    const result = await runStoreSetupPass(pass(db, keys, world), owner, await open());
    expect(result).toMatchObject({ kind: 'done', payoutListOut: true });
    expect(result.kind === 'done' && result.outcomes[0]?.listing).toBe('unchanged');
    expect((await storedLedger(db, owner)).payto).toEqual(before.payto);
    expect(before.payto?.createdAt).toBe(NOW - 3600);
  });

  it('leaves the ledger and the owner events untouched when nothing went out', async () => {
    const { db, keys, world, seed, owner, open } = await published();
    const next = ownerEvents(seed.owner, seed.store, NEXT, NOW - 60);
    await insertOwnerEvent(db, owner, next.payoutList, JSON.stringify(NEXT), false);
    world.refuse = () => true;
    const before = await storedLedger(db, owner);
    const version = await rowVersion(db, owner);

    await expect(runStoreSetupPass(pass(db, keys, world), owner, await open())).rejects.toThrow(
      SetupPassFailed,
    );

    expect(await rowVersion(db, owner)).toBe(version);
    expect(await storedLedger(db, owner)).toEqual(before);
    expect((await ownerEventRow(db, next.payoutList.id))?.recorded).toBe(false);
  });

  it('republishes only the listing (signed by S) for a price change; no owner event is new', async () => {
    const { db, keys, world, seed, owner, open } = await published();
    await db.query("update products set price_usd = '2' where owner = $1", [owner]);
    const known = new Set(world.events.map((event) => event.id));

    const result = await runStoreSetupPass(pass(db, keys, world), owner, await open());

    expect(result.kind === 'done' && result.outcomes[0]?.listing).toBe('out');
    const fresh = world.events.filter((event) => !known.has(event.id));
    expect(fresh.every((event) => event.pubkey === seed.store.pubkey)).toBe(true);
    expect(fresh.map((event) => event.kind).sort()).toEqual([0, 10050, 30402]);
    const stored = await storedLedger(db, owner);
    expect(
      stored.terms.some(
        (period) => period.terms.amount === '2000000' && period.until === undefined,
      ),
    ).toBe(true);
  });

  it('does nothing without a committed payout list', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const { owner } = await seedStore(db, keys);
    const holder = newHolderId();
    const [leased] = await lease(db, holder);
    const handle = await new PgLedgerStore(db, () => NOW).open(
      owner.pubkey,
      leased?.epoch ?? 0,
      holder,
    );
    const version = await rowVersion(db, owner.pubkey);
    expect(await runStoreSetupPass(pass(db, keys, world), owner.pubkey, handle)).toEqual({
      kind: 'no_payout_list',
    });
    expect(world.events).toEqual([]);
    expect(await rowVersion(db, owner.pubkey)).toBe(version);
  });

  it('records a 30490 that went out; published only once a default relay took it', async () => {
    const { db, keys, world, seed, owner, open } = await published();
    const next = ownerEvents(seed.owner, seed.store, SOLANA_PAYOUTS, NOW - 30).authorization;
    await insertOwnerEvent(db, owner, next, undefined, false);
    world.refuse = (event, relay) => event.id === next.id && relay !== RELAY;

    const result = await runStoreSetupPass(pass(db, keys, world), owner, await open());

    expect(result).toMatchObject({ kind: 'done', authorizationOut: true });
    expect(result.kind === 'done' && result.missedDefaults).toEqual(['kind 30490']);
    expect(await ownerEventRow(db, next.id)).toMatchObject({
      recorded: true,
      published_at: null,
    });
  });
});

describe('the setup pass: inbox relays (draft vs active)', () => {
  const NEW_RELAY = 'wss://inbox-two.example.com';
  const ALLOWLIST = [RELAY, NEW_RELAY];

  /** A published store whose merchant moved its inbox to `NEW_RELAY` (the draft). */
  async function moved() {
    const store = await published();
    await store.db.query('update store_config set draft_inbox_relays = $2 where owner = $1', [
      store.owner,
      [NEW_RELAY],
    ]);
    return store;
  }

  async function listening(store: Awaited<ReturnType<typeof published>>): Promise<string[]> {
    const bundle = await loadStoreBundle(store.db, store.keys, store.owner, {
      holder: store.holder,
      epoch: store.epoch,
      rpcs: RPCS,
      inboxRelayAllowlist: ALLOWLIST,
      now: () => NOW,
    });
    return bundle.config.inboxRelays;
  }

  async function activeRelays(db: Db, owner: string): Promise<string[] | undefined> {
    const [row] = await db.query<{ inbox_relays: string[] }>(
      'select inbox_relays from store_config where owner = $1',
      [owner],
    );
    return row?.inbox_relays;
  }

  function newestInboxList(world: RelayWorld, storePubkey: string): string[] | undefined {
    const lists = world.events
      .filter((event) => event.kind === 10050 && event.pubkey === storePubkey)
      .sort((left, right) => right.created_at - left.created_at);
    return lists[0]?.tags.filter((tag) => tag[0] === 'relay').map((tag) => tag[1]);
  }

  it('a restart before the pass listens on the old relays: buyers still read the old 10050', async () => {
    const store = await moved();
    expect(await listening(store)).toEqual([RELAY]);
    expect(newestInboxList(store.world, store.seed.store.pubkey)).toEqual([RELAY]);
  });

  it('switches once the 10050 naming the new relays reached a default relay', async () => {
    const store = await moved();
    const offered: string[] = [];
    store.world.refuse = (event, relay) => {
      if (event.kind === 10050) {
        offered.push(relay);
      }
      return false;
    };
    const deps = testSetupDeps(store.db, store.keys, store.world, {
      inboxRelayAllowlist: ALLOWLIST,
    });
    const result = await runStoreSetupPass(deps, store.owner, await store.open());
    // The old inbox hears of the move too: buyers who read the store's list there.
    expect([...new Set(offered)].sort()).toEqual([...OFFER_RELAYS, RELAY, NEW_RELAY].sort());
    expect(result).toMatchObject({
      kind: 'done',
      inboxRelaysSwitched: true,
      inboxRelaysPending: false,
    });
    expect(newestInboxList(store.world, store.seed.store.pubkey)).toEqual([NEW_RELAY]);
    expect(await activeRelays(store.db, store.owner)).toEqual([NEW_RELAY]);
    expect(await listening(store)).toEqual([NEW_RELAY]);
    // Nothing left to switch on the next pass.
    const again = await runStoreSetupPass(deps, store.owner, await store.open());
    expect(again).toMatchObject({ inboxRelaysSwitched: false, inboxRelaysPending: false });
  });

  it('keeps the old relays when the 10050 was refused, or reached no default relay', async () => {
    for (const refuse of [
      (event: NostrEvent) => event.kind === 10050,
      (event: NostrEvent, relay: string) => event.kind === 10050 && OFFER_RELAYS.includes(relay),
    ]) {
      const store = await moved();
      store.world.refuse = refuse;
      const deps = testSetupDeps(store.db, store.keys, store.world, {
        inboxRelayAllowlist: ALLOWLIST,
      });
      const result = await runStoreSetupPass(deps, store.owner, await store.open());
      expect(result).toMatchObject({
        kind: 'done',
        payoutListOut: true,
        inboxRelaysSwitched: false,
        inboxRelaysPending: true,
      });
      expect(await activeRelays(store.db, store.owner)).toEqual([RELAY]);
      expect(await listening(store)).toEqual([RELAY]);
    }
  });

  it('records the relays it leaves and when, kept through a second move within their window', async () => {
    const THIRD = 'wss://inbox-three.example.com';
    const store = await moved();
    let clock = NOW;
    const deps = testSetupDeps(store.db, store.keys, store.world, {
      inboxRelayAllowlist: [...ALLOWLIST, THIRD],
      now: () => clock,
    });
    const left = async () =>
      (
        await store.db.query<{ previous: string[] | null; at: number | null }>(
          `select previous_inbox_relays as previous, inbox_switched_at as at
           from store_config where owner = $1`,
          [store.owner],
        )
      )[0];
    const moveTo = async (relays: string[]) => {
      await store.db.query('update store_config set draft_inbox_relays = $2 where owner = $1', [
        store.owner,
        relays,
      ]);
      const result = await runStoreSetupPass(deps, store.owner, await store.open());
      expect(result).toMatchObject({ kind: 'done', inboxRelaysSwitched: true });
    };
    expect(await left()).toEqual({ previous: null, at: null });
    await runStoreSetupPass(deps, store.owner, await store.open());
    expect(await left()).toEqual({ previous: [RELAY], at: NOW });
    // A pass with nothing to switch leaves them alone.
    clock = NOW + 5;
    await runStoreSetupPass(deps, store.owner, await store.open());
    expect(await left()).toEqual({ previous: [RELAY], at: NOW });
    // A second move within the window: buyers may hold either earlier list.
    clock = NOW + 10;
    await moveTo([THIRD]);
    expect(await left()).toEqual({ previous: [NEW_RELAY, RELAY], at: NOW + 10 });
    // Back to a relay still read: it is active again, not left.
    clock = NOW + 20;
    await moveTo([RELAY]);
    expect(await left()).toEqual({ previous: [THIRD, NEW_RELAY], at: NOW + 20 });
    // Past the window the earlier lists are dropped.
    clock = NOW + 20 + TERMS_STAND_SECS;
    await moveTo([NEW_RELAY]);
    expect(await left()).toEqual({ previous: [RELAY], at: NOW + 20 + TERMS_STAND_SECS });
  });

  it('switches when the active list holds a relay the allowlist dropped since', async () => {
    const store = await published();
    const GONE = 'wss://gone.example.com';
    await store.db.query(
      'update store_config set inbox_relays = $2, draft_inbox_relays = $3 where owner = $1',
      [store.owner, [RELAY, GONE], [RELAY]],
    );
    const deps = testSetupDeps(store.db, store.keys, store.world, {
      inboxRelayAllowlist: [RELAY],
    });
    const result = await runStoreSetupPass(deps, store.owner, await store.open());
    expect(result).toMatchObject({ kind: 'done', inboxRelaysSwitched: true });
    expect(await activeRelays(store.db, store.owner)).toEqual([RELAY]);
  });

  it('keeps the old relays when nothing went out', async () => {
    const store = await moved();
    store.world.refuse = () => true;
    const deps = testSetupDeps(store.db, store.keys, store.world, {
      inboxRelayAllowlist: ALLOWLIST,
    });
    await expect(runStoreSetupPass(deps, store.owner, await store.open())).rejects.toThrow(
      SetupPassFailed,
    );
    expect(await activeRelays(store.db, store.owner)).toEqual([RELAY]);
  });
});

describe('the setup pass: what it marks', () => {
  it('marks the request applied when the payout list already recorded did not go out again', async () => {
    const { db, keys, world, owner, open } = await published();
    await db.query("update products set price_usd = '2' where owner = $1", [owner]);
    world.refuse = (event) => event.kind === 10133;
    const id = await submitRequest(db, owner, 'setup', {}, NOW);
    const result = await runStoreSetupPass(pass(db, keys, world), owner, await open(), {
      appliedRequest: id,
    });
    expect(result).toMatchObject({ kind: 'done', payoutListOut: false, payoutListPending: false });
    expect((await getRequest(db, owner, id))?.state).toBe('applied');
  });

  it('keeps a request pending while a committed, never-recorded payout list did not go out', async () => {
    const { db, keys, world, seed, owner, open } = await published();
    const next = ownerEvents(seed.owner, seed.store, NEXT, NOW - 60);
    await insertOwnerEvent(db, owner, next.payoutList, JSON.stringify(NEXT), false);
    await db.query("update products set price_usd = '2' where owner = $1", [owner]);
    world.refuse = (event) => event.id === next.payoutList.id;
    const id = await submitRequest(db, owner, 'record_owner_event', {}, NOW);
    const result = await runStoreSetupPass(pass(db, keys, world), owner, await open(), {
      appliedRequest: id,
    });
    expect(result).toMatchObject({ kind: 'done', payoutListOut: false, payoutListPending: true });
    expect((await getRequest(db, owner, id))?.state).toBe('pending');
  });

  it('leaves a committed 30490 unrecorded when it reached no relay', async () => {
    const { db, keys, world, seed, owner, open } = await published();
    const next = ownerEvents(seed.owner, seed.store, SOLANA_PAYOUTS, NOW - 30).authorization;
    await insertOwnerEvent(db, owner, next, undefined, false);
    await db.query("update products set price_usd = '2' where owner = $1", [owner]);
    world.refuse = (event) => event.id === next.id;
    const result = await runStoreSetupPass(pass(db, keys, world), owner, await open());
    expect(result).toMatchObject({ kind: 'done', authorizationOut: false });
    expect(await ownerEventRow(db, next.id)).toMatchObject({ recorded: false, published_at: null });
  });
});

describe('OwnerEventPublisher', () => {
  /** A published store whose seeded owner events a default relay already took. */
  async function settled() {
    const store = await published();
    await store.db.query('update owner_events set published_at = $1', [NOW - 3600]);
    return store;
  }

  function publisher(db: Db, keys: KeyVault, world: RelayWorld, allowlist = [RELAY]) {
    return new OwnerEventPublisher({
      db,
      vault: keys,
      inboxRelayAllowlist: allowlist,
      makePool: () => world.pool(),
      log: () => undefined,
      now: () => NOW,
    });
  }

  it('never publishes an event the setup pass did not record', async () => {
    const { db, keys, seed, owner } = await settled();
    const world = new RelayWorld();
    const next = ownerEvents(seed.owner, seed.store, NEXT, NOW - 60);
    await insertOwnerEvent(db, owner, next.payoutList, JSON.stringify(NEXT), false);
    expect(await publisher(db, keys, world).runOnce()).toBe(0);
    expect(world.events).toEqual([]);
  });

  it('republishes a recorded event no default relay took, with backoff, until one does', async () => {
    const { db, keys, seed, owner } = await settled();
    const world = new RelayWorld();
    const next = ownerEvents(seed.owner, seed.store, SOLANA_PAYOUTS, NOW - 30).authorization;
    await insertOwnerEvent(db, owner, next, undefined, true);
    const isOut = (event: NostrEvent) => world.events.some((known) => known.id === event.id);
    world.refuse = (_event, relay) => OFFER_RELAYS.includes(relay);
    const events = publisher(db, keys, world);

    expect(await events.runOnce()).toBe(1);
    expect(await ownerEventRow(db, next.id)).toMatchObject({
      published_at: null,
      publish_attempts: 1,
      next_attempt_at: NOW + 30,
    });
    expect(await events.runOnce()).toBe(0);

    await db.query('update owner_events set next_attempt_at = 0 where id = $1', [next.id]);
    world.refuse = () => false;
    expect(await events.runOnce()).toBe(1);
    expect(isOut(next)).toBe(true);
    expect((await ownerEventRow(db, next.id))?.published_at).toBe(NOW);
    expect(await events.runOnce()).toBe(0);
  });

  it('never connects for a store whose stored inbox relay left the allowlist: backs off, alerts', async () => {
    const { db, keys, seed, owner } = await settled();
    const world = new RelayWorld();
    const next = ownerEvents(seed.owner, seed.store, SOLANA_PAYOUTS, NOW - 30).authorization;
    await insertOwnerEvent(db, owner, next, undefined, true);
    const events = publisher(db, keys, world, ['wss://other.example.com']);
    expect(await events.runOnce()).toBe(1);
    expect(world.pools).toEqual([]);
    expect(world.events).toEqual([]);
    expect(await ownerEventRow(db, next.id)).toMatchObject({
      published_at: null,
      publish_attempts: 1,
      next_attempt_at: NOW + 30,
    });
    const alerts = await db.query<{ kind: string; message: string }>(
      'select kind, message from alerts where owner = $1 and cleared_at is null',
      [owner],
    );
    expect(alerts).toEqual([
      { kind: 'inbox_relays_refused', message: `inbox relays outside the allowlist: ${RELAY}` },
    ]);
    // The allowlist takes the relay back: the next republish goes out and clears the alert.
    await db.query('update owner_events set next_attempt_at = 0 where id = $1', [next.id]);
    expect(await publisher(db, keys, world).runOnce()).toBe(1);
    expect((await ownerEventRow(db, next.id))?.published_at).toBe(NOW);
    expect(
      await db.query('select 1 from alerts where owner = $1 and cleared_at is null', [owner]),
    ).toEqual([]);
  });

  it('keeps the alert while republishing still fails', async () => {
    const { db, keys, seed, owner } = await settled();
    const world = new RelayWorld();
    const next = ownerEvents(seed.owner, seed.store, SOLANA_PAYOUTS, NOW - 30).authorization;
    await insertOwnerEvent(db, owner, next, undefined, true);
    await publisher(db, keys, world, ['wss://other.example.com']).runOnce();
    await db.query('update owner_events set next_attempt_at = 0 where id = $1', [next.id]);
    world.refuse = () => true;
    expect(await publisher(db, keys, world).runOnce()).toBe(1);
    expect(
      await db.query<{ kind: string }>(
        'select kind from alerts where owner = $1 and cleared_at is null',
        [owner],
      ),
    ).toEqual([{ kind: 'inbox_relays_refused' }]);
  });

  it('skips a recorded event a newer one of its kind replaced', async () => {
    const { db, keys, seed, owner } = await settled();
    const world = new RelayWorld();
    const older = ownerEvents(seed.owner, seed.store, SOLANA_PAYOUTS, NOW - 300).authorization;
    const newer = ownerEvents(seed.owner, seed.store, SOLANA_PAYOUTS, NOW - 30).authorization;
    await insertOwnerEvent(db, owner, older, undefined, true);
    await insertOwnerEvent(db, owner, newer, undefined, false);
    expect(await publisher(db, keys, world).runOnce()).toBe(0);
    expect(world.events).toEqual([]);
  });
});

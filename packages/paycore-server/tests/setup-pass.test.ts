import { OFFER_RELAYS } from '@merchant-node/constants';
import type { NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { OTHER_TREASURY } from '../../merchant-node/tests/fixtures';
import type { Db } from '../src/db/db';
import type { KeyVault } from '../src/db/keys';
import { SetupPassFailed, runStoreSetupPass } from '../src/node/setup-pass';
import { OwnerEventPublisher } from '../src/publisher';
import { newHolderId } from '../src/state/leases';
import { PgLedgerStore } from '../src/state/ledger-store';
import {
  NOW,
  RELAY,
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
  return { db, keys, world, seed, owner: seed.owner.pubkey, open };
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

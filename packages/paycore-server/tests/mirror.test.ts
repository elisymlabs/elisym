import {
  KIND_DELETION,
  KIND_INBOX_RELAYS,
  KIND_PAYTO,
  KIND_PRODUCT,
  KIND_STORE_AUTH,
  KIND_STORE_PROFILE,
  MAX_FUTURE_SKEW_SECS,
  buildStoreAuthEvent,
  productAddress,
  resolveStoreAuth,
  storeAuthAddress,
} from '@elisym/commerce';
import { LISTING_CHUNK_SIZE } from '@merchant-node/constants';
import { emptyLedger } from '@merchant-node/ledger';
import type { NostrEvent } from 'nostr-tools';
import { type EventTemplate, finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db';
import { KeyVault } from '../src/db/keys';
import {
  MIRROR_SEND_CAP,
  MIRROR_SWEEP_SECS,
  MirrorSweeper,
  payoutListAddress,
} from '../src/relay/mirror';
import { insertLedger } from '../src/state/ledger-store';
import { MirrorRelays } from './helpers/mirror-relays';
import { freshDb } from './pglite-db';
import { MASTER_KEY, NOW, activate, ownerKeys } from './stores-fixtures';

const REQUIRED = 'wss://relay.elisym.network';
const DAMUS = 'wss://relay.damus.io';
const NOS = 'wss://nos.lol';
const DEFAULT_RELAYS = [REQUIRED, DAMUS, NOS];
const T = NOW - 3_600;

type Keys = ReturnType<typeof ownerKeys>;

interface Store {
  owner: Keys;
  store: Keys;
}

async function addStore(
  db: Db,
  vault: KeyVault,
  options: { status?: string; products?: string[]; ledgerListings?: string[] } = {},
): Promise<Store> {
  const owner = ownerKeys();
  const store = ownerKeys();
  await db.query(
    `insert into stores (owner, store_pubkey, status, created_at) values ($1, $2, 'pending', $3)`,
    [owner.pubkey, store.pubkey, NOW],
  );
  if ((options.status ?? 'active') !== 'pending') {
    await activate(db, owner.pubkey, 2, options.status ?? 'active');
  }
  await db.query('insert into store_keys (owner, store_key) values ($1, $2)', [
    owner.pubkey,
    vault.seal(store.secret, owner.pubkey, 'store'),
  ]);
  for (const d of options.products ?? []) {
    await db.query(
      `insert into products (owner, d, title, description, price_usd, on_sale, updated_at)
       values ($1, $2, 'Socks', 'Warm socks.', '5', true, $3)`,
      [owner.pubkey, d, NOW],
    );
  }
  const listings = Object.fromEntries(
    (options.ledgerListings ?? []).map((d) => [d, { hash: 'h', eventId: 'e', createdAt: T }]),
  );
  await insertLedger(db, owner.pubkey, { ...emptyLedger(), listings }, NOW);
  return { owner, store };
}

function sign(keys: Keys, template: Omit<EventTemplate, 'content'> & { content?: string }) {
  return finalizeEvent({ content: '', ...template }, keys.secret);
}

function listing(store: Keys, d: string, createdAt: number): NostrEvent {
  return sign(store, { kind: KIND_PRODUCT, created_at: createdAt, tags: [['d', d]] });
}

function storeAuthorization(owner: Keys, store: Keys, createdAt: number): NostrEvent {
  return finalizeEvent(
    buildStoreAuthEvent({
      storePubkey: store.pubkey,
      mode: 'hosted',
      operator: 'paycore.example',
      createdAt,
    }),
    owner.secret,
  );
}

function deletion(author: Keys, addresses: string[], createdAt: number): NostrEvent {
  return sign(author, {
    kind: KIND_DELETION,
    created_at: createdAt,
    tags: addresses.map((address) => ['a', address]),
  });
}

function setup(
  db: Db,
  overrides: { now?: () => number; readTimeoutMs?: number; defaultRelays?: string[] } = {},
) {
  const relays = new MirrorRelays();
  const vault = new KeyVault(MASTER_KEY);
  const logs: string[] = [];
  const sweeper = (relayWorld: MirrorRelays = relays) =>
    new MirrorSweeper({
      db,
      vault,
      makePool: () => relayWorld.pool(),
      requiredRelay: REQUIRED,
      defaultRelays: overrides.defaultRelays ?? DEFAULT_RELAYS,
      log: (line) => logs.push(line),
      now: overrides.now ?? (() => NOW),
      readTimeoutMs: overrides.readTimeoutMs ?? 1_000,
      deadlineMs: 1_000,
    });
  return { relays, vault, logs, sweeper };
}

/** The ids the required relay was sent, in order. */
function sentIds(relays: MirrorRelays): string[] {
  return relays.sends.map((send) => send.event.id);
}

describe('MirrorSweeper', () => {
  it('copies a listing damus serves and the required relay lacks, the exact signed event, to the required relay only', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { store } = await addStore(db, vault, { products: ['socks'] });
    const socks = listing(store, 'socks', T);
    relays.put(DAMUS, socks);

    const sweeps = await sweeper().runOnce();
    expect(sweeps).toEqual([expect.objectContaining({ outcome: 'swept', sent: 1, refused: 0 })]);
    expect(relays.sends.map((send) => send.url)).toEqual([REQUIRED]);
    expect(relays.on(REQUIRED)).toEqual([socks]);
    expect(relays.destroyed).toBe(relays.pools);
  });

  it('leaves a newer listing served directly alone and never re-sends the older one', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { store } = await addStore(db, vault, { products: ['socks'] });
    relays.put(DAMUS, listing(store, 'socks', T));
    relays.put(REQUIRED, listing(store, 'socks', T + 10));

    expect(await sweeper().runOnce()).toEqual([
      expect.objectContaining({ outcome: 'swept', sent: 0, refused: 0 }),
    ]);
    expect(relays.sends).toEqual([]);
  });

  it("copies a suspended store's sold-out listing and a retired one only its ledger names", async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { store } = await addStore(db, vault, {
      status: 'suspended',
      products: ['socks'],
      ledgerListings: ['socks', 'retired'],
    });
    const soldOut = listing(store, 'socks', T);
    const retired = listing(store, 'retired', T);
    relays.put(DAMUS, soldOut, retired);

    await sweeper().runOnce();
    expect(new Set(sentIds(relays))).toEqual(new Set([soldOut.id, retired.id]));
  });

  it('never copies a forged event: a bad signature, a changed body or another author', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { store } = await addStore(db, vault, { products: ['socks'] });
    const stranger = ownerKeys();
    relays.behaviour.set(DAMUS, { ignoreAuthors: true });
    const genuine = listing(store, 'socks', T + 5);
    relays.put(
      DAMUS,
      // Spread keeps nostr-tools' cached "verified" mark: the sweep must not trust it.
      { ...genuine, sig: 'ab'.repeat(64) },
      { ...genuine, content: 'changed' },
      { ...listing(stranger, 'socks', T + 10), pubkey: store.pubkey },
      listing(stranger, 'socks', T + 20),
    );

    await sweeper().runOnce();
    expect(relays.sends).toEqual([]);
  });

  it('copies the genuine listing when a forged newer one sits beside it', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { store } = await addStore(db, vault, { products: ['socks'] });
    const genuine = listing(store, 'socks', T);
    const forged = { ...listing(store, 'socks', T + 100), sig: 'cd'.repeat(64) };
    relays.put(DAMUS, forged, genuine);
    // The required relay's own forged entry does not hide that it lacks the genuine one either.
    relays.put(REQUIRED, { ...listing(store, 'socks', T + 50), content: 'tampered' });

    await sweeper().runOnce();
    expect(sentIds(relays)).toEqual([genuine.id]);
  });

  it('copies the owner events (30490, 10133) and the store-wide ones the required relay lacks', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { owner, store } = await addStore(db, vault);
    const authorization = storeAuthorization(owner, store, T);
    const payoutList = sign(owner, { kind: KIND_PAYTO, created_at: T, tags: [] });
    const profile = sign(store, { kind: KIND_STORE_PROFILE, created_at: T, tags: [] });
    const inbox = sign(store, { kind: KIND_INBOX_RELAYS, created_at: T, tags: [] });
    // Another store's 30490 by the same owner is not this store's to copy.
    const otherStore = storeAuthorization(owner, ownerKeys(), T);
    relays.put(NOS, authorization, payoutList, otherStore);
    relays.put(DAMUS, profile, inbox);

    await sweeper().runOnce();
    expect(new Set(sentIds(relays))).toEqual(
      new Set([authorization.id, payoutList.id, profile.id, inbox.id]),
    );
  });

  it('sends nothing and skips the store when the required relay does not finish its read', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper, logs } = setup(db, { readTimeoutMs: 30 });
    const { store } = await addStore(db, vault, { products: ['socks'] });
    relays.put(DAMUS, listing(store, 'socks', T));
    relays.behaviour.set(REQUIRED, { silent: true });

    expect(await sweeper().runOnce()).toEqual([
      expect.objectContaining({ outcome: 'skipped', reason: 'no EOSE in time' }),
    ]);
    expect(relays.sends).toEqual([]);
    expect(logs.some((line) => line.includes('skipped this round'))).toBe(true);
  });

  it('sweeps each store once per period across two instances', async () => {
    const db = await freshDb();
    let now = NOW;
    const { relays, vault, sweeper } = setup(db, { now: () => now });
    const first = await addStore(db, vault, { products: ['socks'] });
    const second = await addStore(db, vault, { products: ['hats'] });
    relays.put(DAMUS, listing(first.store, 'socks', T), listing(second.store, 'hats', T));

    const [one, two] = await Promise.all([sweeper().runOnce(), sweeper().runOnce()]);
    const swept = [...(one ?? []), ...(two ?? [])].map((sweep) => sweep.owner).sort();
    expect(swept).toEqual([first.owner.pubkey, second.owner.pubkey].sort());
    expect(relays.sends).toHaveLength(2);

    // Due once more than a period has passed since the claim.
    now += MIRROR_SWEEP_SECS;
    expect(await sweeper().runOnce()).toEqual([]);
    now += 1;
    expect(await sweeper().runOnce()).toHaveLength(2);
    // Both copies are on the required relay now: nothing more to send.
    expect(relays.sends).toHaveLength(2);
  });

  it('no longer sweeps a deleted store', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { owner, store } = await addStore(db, vault, { products: ['socks'] });
    relays.put(DAMUS, listing(store, 'socks', T));
    await db.query('delete from stores where owner = $1', [owner.pubkey]);

    expect(await sweeper().runOnce()).toEqual([]);
    expect(relays.pools).toBe(0);
  });

  it('copies a kind 5 for the 30490 and not the 30490 it covers', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { owner, store } = await addStore(db, vault);
    const authorization = storeAuthorization(owner, store, T);
    const removal = deletion(owner, [storeAuthAddress(owner.pubkey, store.pubkey)], T);
    relays.put(DAMUS, authorization, removal);

    await sweeper().runOnce();
    expect(sentIds(relays)).toEqual([removal.id]);
  });

  it('copies a kind 5 and the newer 30490 after it, deletion first, and the newer one is active', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { owner, store } = await addStore(db, vault);
    const removal = deletion(owner, [storeAuthAddress(owner.pubkey, store.pubkey)], T);
    const reauthorization = storeAuthorization(owner, store, T + 1);
    relays.put(DAMUS, removal, reauthorization);

    await sweeper().runOnce();
    expect(sentIds(relays)).toEqual([removal.id, reauthorization.id]);
    expect(resolveStoreAuth(relays.on(REQUIRED), owner.pubkey, store.pubkey, NOW)).toEqual(
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('copies a newer deletion when the required relay holds only an older one', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { owner, store } = await addStore(db, vault);
    const address = storeAuthAddress(owner.pubkey, store.pubkey);
    const firstRemoval = deletion(owner, [address], T);
    const reauthorization = storeAuthorization(owner, store, T + 5);
    const secondRemoval = deletion(owner, [address], T + 10);
    relays.put(DAMUS, firstRemoval, reauthorization, secondRemoval);
    relays.put(REQUIRED, firstRemoval, reauthorization);

    await sweeper().runOnce();
    expect(sentIds(relays)).toEqual([secondRemoval.id]);
  });

  it("copies the store's deletion of a listing and not the listing it covers", async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { owner, store } = await addStore(db, vault, { products: ['socks'] });
    const socks = listing(store, 'socks', T);
    const unlisted = deletion(
      store,
      [productAddress({ storePubkey: store.pubkey, d: 'socks' })],
      T + 1,
    );
    relays.put(DAMUS, socks, unlisted);
    // A deletion by someone else is neither copied nor covers anything.
    const authorization = storeAuthorization(owner, store, T);
    relays.put(NOS, authorization);
    relays.put(NOS, deletion(ownerKeys(), [storeAuthAddress(owner.pubkey, store.pubkey)], T + 5));

    await sweeper().runOnce();
    expect(sentIds(relays)).toEqual([unlisted.id, authorization.id]);
  });

  it('a deletion only the required relay holds covers what the default relays still serve', async () => {
    const db = await freshDb();
    // The default-relay read does not reach the required relay here (as when that read of it failed).
    const { relays, vault, sweeper } = setup(db, { defaultRelays: [DAMUS, NOS] });
    const { store } = await addStore(db, vault, { products: ['socks'] });
    relays.put(DAMUS, listing(store, 'socks', T));
    relays.put(
      REQUIRED,
      deletion(store, [productAddress({ storePubkey: store.pubkey, d: 'socks' })], T + 1),
    );

    await sweeper().runOnce();
    expect(relays.sends).toEqual([]);
  });

  it("mirrors the owner's deletion of the payout list but still copies the 10133 (the checkout applies no deletion to it)", async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { owner } = await addStore(db, vault);
    const payoutList = sign(owner, { kind: KIND_PAYTO, created_at: T, tags: [] });
    const payoutRemoval = deletion(owner, [payoutListAddress(owner.pubkey)], T + 1);
    relays.put(DAMUS, payoutList, payoutRemoval);

    await sweeper().runOnce();
    expect(sentIds(relays)).toEqual([payoutRemoval.id, payoutList.id]);
  });

  it(`sends at most ${MIRROR_SEND_CAP} events a sweep and does not retry a refusal within it`, async () => {
    const db = await freshDb();
    let now = NOW;
    const { relays, vault, sweeper, logs } = setup(db, { now: () => now });
    const ds = Array.from({ length: MIRROR_SEND_CAP + 10 }, (_unused, index) => `p${index}`);
    const { store } = await addStore(db, vault, { products: ds });
    const events = ds.map((d) => listing(store, d, T));
    relays.put(DAMUS, ...events);
    const refusedId = events[0]?.id;
    relays.refuse = (event) => event.id === refusedId;

    expect(await sweeper().runOnce()).toEqual([
      expect.objectContaining({ outcome: 'swept', sent: MIRROR_SEND_CAP - 1, refused: 1 }),
    ]);
    expect(relays.sends).toHaveLength(MIRROR_SEND_CAP);
    expect(sentIds(relays).filter((id) => id === refusedId)).toHaveLength(1);
    expect(logs.some((line) => line.includes('refused'))).toBe(true);

    // The next period sends the rest and tries the refused one again.
    relays.refuse = () => false;
    now += MIRROR_SWEEP_SECS + 1;
    expect(await sweeper().runOnce()).toEqual([
      expect.objectContaining({ outcome: 'swept', sent: 11, refused: 0 }),
    ]);
    expect(relays.on(REQUIRED)).toHaveLength(ds.length);
  });

  it('reads listings with chunked #d filters, never an unfiltered author query', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const ds = Array.from({ length: LISTING_CHUNK_SIZE * 2 + 5 }, (_unused, index) => `p${index}`);
    await addStore(db, vault, { products: ds });

    await sweeper().runOnce();
    const listingReads = relays.reads.filter((read) => read.filter.kinds?.includes(KIND_PRODUCT));
    expect(listingReads.length).toBeGreaterThan(0);
    for (const read of listingReads) {
      expect(read.filter['#d']?.length).toBeGreaterThan(0);
      expect(read.filter['#d']?.length).toBeLessThanOrEqual(LISTING_CHUNK_SIZE);
    }
    const readDs = new Set(
      listingReads
        .filter((read) => read.url === REQUIRED)
        .flatMap((read) => read.filter['#d'] ?? []),
    );
    expect(readDs).toEqual(new Set(ds));
    for (const read of relays.reads.filter((entry) =>
      entry.filter.kinds?.includes(KIND_DELETION),
    )) {
      expect(read.filter['#a']?.length).toBeGreaterThan(0);
    }
    expect(
      relays.reads.every(
        (read) =>
          read.filter.kinds?.includes(KIND_STORE_AUTH) !== true || read.filter['#d'] !== undefined,
      ),
    ).toBe(true);
  });

  it('authenticates as the store key when the required relay asks before a write', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { store } = await addStore(db, vault, { products: ['socks'] });
    const socks = listing(store, 'socks', T);
    relays.put(DAMUS, socks);
    relays.behaviour.set(REQUIRED, { authForWrites: true });

    await sweeper().runOnce();
    expect(relays.auths).toEqual([{ url: REQUIRED, pubkey: store.pubkey }]);
    expect(relays.on(REQUIRED)).toEqual([socks]);
  });
  it('of two events in the same second copies the one with the lowest id, as readers pick', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { store } = await addStore(db, vault, { products: ['socks'] });
    const [lower, higher] = [
      sign(store, { kind: KIND_PRODUCT, created_at: T, tags: [['d', 'socks']], content: 'a' }),
      sign(store, { kind: KIND_PRODUCT, created_at: T, tags: [['d', 'socks']], content: 'b' }),
    ].sort((left, right) => (left.id < right.id ? -1 : 1));
    if (lower === undefined || higher === undefined) {
      throw new Error('two events expected');
    }
    relays.put(DAMUS, lower);
    relays.put(REQUIRED, higher);
    await sweeper().runOnce();
    expect(sentIds(relays)).toEqual([lower.id]);

    // The other way round, the required relay already holds the one readers pick.
    const other = await freshDb();
    const second = setup(other);
    const otherStore = await addStore(other, second.vault, { products: ['socks'] });
    const [low, high] = [
      sign(otherStore.store, {
        kind: KIND_PRODUCT,
        created_at: T,
        tags: [['d', 'socks']],
        content: 'a',
      }),
      sign(otherStore.store, {
        kind: KIND_PRODUCT,
        created_at: T,
        tags: [['d', 'socks']],
        content: 'b',
      }),
    ].sort((left, right) => (left.id < right.id ? -1 : 1));
    if (low === undefined || high === undefined) {
      throw new Error('two events expected');
    }
    second.relays.put(DAMUS, high);
    second.relays.put(REQUIRED, low);
    await second.sweeper().runOnce();
    expect(second.relays.sends).toEqual([]);

    // Read apart: the default relays exclude the required one, so the source picks the higher id.
    const apart = await freshDb();
    const third = setup(apart, { defaultRelays: [DAMUS, NOS] });
    const thirdStore = await addStore(apart, third.vault, { products: ['socks'] });
    const [lowest, highest] = [
      sign(thirdStore.store, {
        kind: KIND_PRODUCT,
        created_at: T,
        tags: [['d', 'socks']],
        content: 'a',
      }),
      sign(thirdStore.store, {
        kind: KIND_PRODUCT,
        created_at: T,
        tags: [['d', 'socks']],
        content: 'b',
      }),
    ].sort((left, right) => (left.id < right.id ? -1 : 1));
    if (lowest === undefined || highest === undefined) {
      throw new Error('two events expected');
    }
    third.relays.put(DAMUS, highest);
    third.relays.put(REQUIRED, lowest);
    await third.sweeper().runOnce();
    expect(third.relays.sends).toEqual([]);
  });

  it('two deletions of the same second already held are not sent again', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { store } = await addStore(db, vault, { products: ['socks'] });
    const socks = listing(store, 'socks', T);
    const address = `${KIND_PRODUCT}:${store.pubkey}:socks`;
    const first = deletion(store, [address], T + 1);
    const second = deletion(store, [address, `${KIND_PRODUCT}:${store.pubkey}:other`], T + 1);
    relays.put(DAMUS, socks, first, second);
    relays.put(REQUIRED, first, second);
    await sweeper().runOnce();
    expect(relays.sends).toEqual([]);
  });

  it('never copies a source event dated past the future-skew window', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { store } = await addStore(db, vault, { products: ['socks'] });
    const current = listing(store, 'socks', T);
    relays.put(DAMUS, current, listing(store, 'socks', NOW + MAX_FUTURE_SKEW_SECS + 100));

    await sweeper().runOnce();
    expect(sentIds(relays)).toEqual([current.id]);
  });

  it('a far-future event the required relay holds stops an older one being copied', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { store } = await addStore(db, vault, { products: ['socks'] });
    relays.put(DAMUS, listing(store, 'socks', T));
    relays.put(REQUIRED, listing(store, 'socks', NOW + 10 * MAX_FUTURE_SKEW_SECS));

    await sweeper().runOnce();
    expect(relays.sends).toEqual([]);
  });

  it('a default-relay read that fails costs only that read', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { owner, store } = await addStore(db, vault, { products: ['socks'] });
    const socks = listing(store, 'socks', T);
    relays.put(DAMUS, socks, sign(owner, { kind: KIND_PAYTO, created_at: T, tags: [] }));
    relays.failQuery = (filter) => filter.kinds?.includes(KIND_PAYTO) === true;

    expect(await sweeper().runOnce()).toEqual([
      expect.objectContaining({ outcome: 'swept', sent: 1 }),
    ]);
    expect(sentIds(relays)).toEqual([socks.id]);
  });

  it('authenticates as the store key when the required relay closes a read with auth-required, then reads again', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { store } = await addStore(db, vault, { products: ['socks'] });
    const socks = listing(store, 'socks', T);
    relays.put(DAMUS, socks);
    relays.behaviour.set(REQUIRED, { authForReads: true });

    expect(await sweeper().runOnce()).toEqual([
      expect.objectContaining({ outcome: 'swept', sent: 1 }),
    ]);
    expect(relays.auths).toEqual([{ url: REQUIRED, pubkey: store.pubkey }]);
    expect(relays.on(REQUIRED)).toEqual([socks]);
  });

  it('skips the store when the required relay closes a read for another reason, without authenticating', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db);
    const { store } = await addStore(db, vault, { products: ['socks'] });
    relays.put(DAMUS, listing(store, 'socks', T));
    relays.behaviour.set(REQUIRED, { closeReads: 'error: shutting down' });

    expect(await sweeper().runOnce()).toEqual([
      expect.objectContaining({ outcome: 'skipped', reason: 'error: shutting down' }),
    ]);
    expect(relays.auths).toEqual([]);
    expect(relays.subscribes).toBe(1);
    expect(relays.sends).toEqual([]);
  });

  it('a CLOSED arriving after the read timed out changes nothing: still not read', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db, { readTimeoutMs: 20 });
    const { store } = await addStore(db, vault, { products: ['socks'] });
    relays.put(DAMUS, listing(store, 'socks', T));
    relays.behaviour.set(REQUIRED, {
      closeReads: 'auth-required: too late',
      closeAfterMs: 200,
    });

    expect(await sweeper().runOnce()).toEqual([
      expect.objectContaining({ outcome: 'skipped', reason: 'no EOSE in time' }),
    ]);
    expect(relays.auths).toEqual([]);
    expect(relays.sends).toEqual([]);
  });

  it('closes every subscription, including one answered before `subscribe` returned', async () => {
    for (const synchronous of [false, true]) {
      const db = await freshDb();
      const { relays, vault, sweeper } = setup(db);
      const { store } = await addStore(db, vault, { products: ['socks'] });
      const socks = listing(store, 'socks', T);
      relays.put(DAMUS, socks);
      relays.behaviour.set(REQUIRED, { synchronous });

      await sweeper().runOnce();
      expect(relays.subscribes).toBeGreaterThan(0);
      expect(relays.closes).toBe(relays.subscribes);
      expect(sentIds(relays)).toEqual([socks.id]);
    }
  });

  it('stop during a tick returns after the store in progress and claims no further store', async () => {
    const db = await freshDb();
    const { relays, vault, sweeper } = setup(db, { readTimeoutMs: 60_000 });
    for (const d of ['a', 'b', 'c']) {
      await addStore(db, vault, { products: [d] });
    }
    relays.behaviour.set(REQUIRED, { silent: true });
    const running = sweeper();
    const tick = running.runOnce();
    while (relays.subscribes === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const startedAt = Date.now();
    await running.stop();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await tick).toEqual([]);
    const claimed = await db.query('select owner from stores where mirror_swept_at is not null');
    expect(claimed).toHaveLength(1);
    expect(relays.destroyed).toBe(relays.pools);
    expect(relays.pools).toBe(1);
    // Stopped for good: a later tick does nothing, not even a database read.
    let queries = 0;
    const counted: Db = {
      ...db,
      query: (sql, params) => {
        queries += 1;
        return db.query(sql, params);
      },
    };
    const stopped = new MirrorSweeper({
      db: counted,
      vault,
      makePool: () => relays.pool(),
      requiredRelay: REQUIRED,
      now: () => NOW + 10 * MIRROR_SWEEP_SECS,
    });
    await stopped.stop();
    expect(await stopped.runOnce()).toEqual([]);
    expect(queries).toBe(0);
    expect(relays.pools).toBe(1);
  });

  for (const [moment, pattern] of [
    ['its claim', /^update stores set mirror_swept_at/],
    ['its first ledger read', /^select d from products/],
    ['its second ledger read', /^select state from ledgers/],
  ] as const) {
    it(`a stop during ${moment} runs no further query, opens no pool and reports nothing; the claim stands`, async () => {
      const db = await freshDb();
      const { relays, vault } = setup(db);
      await addStore(db, vault, { products: ['socks'] });
      let sweeper: MirrorSweeper | undefined;
      let stopping: Promise<void> | undefined;
      const after: string[] = [];
      const watched: Db = {
        ...db,
        query: async <Row extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ): Promise<Row[]> => {
          const text = sql.trim();
          if (stopping !== undefined) {
            after.push(text);
          }
          const rows = await db.query<Row>(sql, params);
          if (stopping === undefined && pattern.test(text)) {
            stopping = sweeper?.stop();
          }
          return rows;
        },
      };
      sweeper = new MirrorSweeper({
        db: watched,
        vault,
        makePool: () => relays.pool(),
        requiredRelay: REQUIRED,
        defaultRelays: DEFAULT_RELAYS,
        now: () => NOW,
      });
      expect(await sweeper.runOnce()).toEqual([]);
      await stopping;
      expect(stopping).toBeDefined();
      expect(after).toEqual([]);
      expect(relays.pools).toBe(0);
      const claimed = await db.query('select owner from stores where mirror_swept_at is not null');
      expect(claimed).toHaveLength(1);
    });
  }
});

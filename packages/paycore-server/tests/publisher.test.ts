import { KIND_STORE_AUTH } from '@elisym/commerce';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db';
import { OwnerEventPublisher } from '../src/publisher';
import { RelayWorld } from './helpers/node-world';
import { VAULT, latestMoveRow, movableStore, moveDeps, moved, testClock } from './move-fixtures';
import { freshDb } from './pglite-db';
import { NOW, RELAY, ownerKeys } from './stores-fixtures';

function publisher(db: Db, world: RelayWorld, now: () => number) {
  return new OwnerEventPublisher({
    db,
    vault: VAULT,
    inboxRelayAllowlist: [RELAY],
    makePool: () => world.pool(),
    log: () => undefined,
    now,
  });
}

async function revocationRows(db: Db) {
  return db.query<{
    from_owner: string;
    revocation_published_at: number | null;
    publish_attempts: number;
    next_attempt_at: number;
  }>(
    `select from_owner, revocation_published_at, publish_attempts, next_attempt_at
     from store_moves where revocation is not null order by id`,
  );
}

describe('OwnerEventPublisher: a moved store', () => {
  it("holds the former owner's revocation until the move switched, then publishes it with backoff", async () => {
    const db = await freshDb();
    const clock = testClock();
    const store = await movableStore(db);
    const to = ownerKeys();
    expect((await moved(moveDeps(db, store.directory), store, to)).result.ok).toBe(true);
    const revocation = (await latestMoveRow(db, store.storePubkey))?.revocation;
    if (revocation === null || revocation === undefined) {
      throw new Error('no revocation');
    }
    const world = new RelayWorld();

    expect(await publisher(db, world, clock.now).runOnce()).toBe(0);
    expect(world.events).toEqual([]);

    await db.query('update store_moves set switched_at = $1', [NOW]);
    world.refuse = () => true;
    expect(await publisher(db, world, clock.now).runOnce()).toBe(1);
    expect(await revocationRows(db)).toEqual([
      {
        from_owner: store.owner.pubkey,
        revocation_published_at: null,
        publish_attempts: 1,
        next_attempt_at: NOW + 30,
      },
    ]);
    world.refuse = () => false;
    // Not due before its backoff.
    expect(await publisher(db, world, clock.now).runOnce()).toBe(0);
    clock.set(NOW + 30);
    expect(await publisher(db, world, clock.now).runOnce()).toBe(1);
    expect(world.events.map((event) => event.id)).toEqual([revocation.id]);
    expect(world.events[0]).toMatchObject({ pubkey: store.owner.pubkey, kind: KIND_STORE_AUTH });
    expect(await revocationRows(db)).toMatchObject([{ revocation_published_at: NOW + 30 }]);
    // Published once: never again.
    clock.set(NOW + 3600);
    expect(await publisher(db, world, clock.now).runOnce()).toBe(0);
  });

  it("chained moves: every revocation waits for the store's latest move to switch", async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const deps = moveDeps(db, store.directory);
    const next = ownerKeys();
    const last = ownerKeys();
    expect((await moved(deps, store, next)).result.ok).toBe(true);
    await db.query('update store_moves set switched_at = $1', [NOW]);
    await db.query("update admin_requests set state = 'applied'");
    // O''s authorization went out before the next move: it is revoked too.
    await db.query('update owner_events set recorded = true, published_at = $2 where owner = $1', [
      next.pubkey,
      NOW,
    ]);
    expect((await moved(deps, { owner: next, wallet: store.wallet }, last)).result.ok).toBe(true);
    const world = new RelayWorld();

    expect(await publisher(db, world, () => NOW).runOnce()).toBe(0);
    expect(world.events).toEqual([]);

    await db.query('update store_moves set switched_at = $1 where switched_at is null', [NOW + 5]);
    expect(await publisher(db, world, () => NOW).runOnce()).toBe(2);
    expect(world.events.map((event) => event.pubkey)).toEqual([store.owner.pubkey, next.pubkey]);
    expect((await revocationRows(db)).map((row) => row.revocation_published_at)).toEqual([
      NOW,
      NOW,
    ]);
  });
});

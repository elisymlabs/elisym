import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db';
import {
  LEASE_TTL_SECS,
  type StoreStatus,
  acquireLeases,
  newHolderId,
  releaseLeases,
} from '../src/state/leases';
import { freshDb } from './pglite-db';

const NOW = 1_790_000_000;
const TTL = LEASE_TTL_SECS;

function ownerOf(fill: string): string {
  return fill.repeat(64);
}

async function seed(db: Db, stores: Record<string, StoreStatus>): Promise<void> {
  await db.query("insert into tiers (name, max_products) values ('basic', 10)");
  let index = 0;
  for (const [owner, status] of Object.entries(stores)) {
    index += 1;
    await db.query(
      `insert into stores (owner, store_pubkey, status, tier, created_at)
       values ($1, $2, $3, 'basic', $4)`,
      [owner, `${index}`.padStart(64, '0'), status, NOW],
    );
  }
}

/** The leases as compared below: the store pubkey is checked once, in the first test. */
async function leasesOf(...args: Parameters<typeof acquireLeases>) {
  return (await acquireLeases(...args)).map(({ storePubkey: _storePubkey, ...lease }) => lease);
}

async function setStatus(db: Db, owner: string, status: StoreStatus): Promise<void> {
  await db.query('update stores set status = $2 where owner = $1', [owner, status]);
}

async function leaseRow(db: Db, owner: string) {
  const [row] = await db.query<{ holder: string; epoch: number; expires_at: number }>(
    'select holder, epoch, expires_at from leases where owner = $1',
    [owner],
  );
  return row;
}

describe('leases', () => {
  it('leases active, degraded, halted and suspending stores; never pending or suspended', async () => {
    const db = await freshDb();
    await seed(db, {
      [ownerOf('1')]: 'active',
      [ownerOf('2')]: 'degraded',
      [ownerOf('3')]: 'halted',
      [ownerOf('4')]: 'suspending',
      [ownerOf('5')]: 'pending',
      [ownerOf('6')]: 'suspended',
    });
    const leased = await acquireLeases(db, 'h1', NOW, TTL);
    const storeOf = (index: number) => `${index}`.padStart(64, '0');
    expect(leased).toEqual([
      { owner: ownerOf('1'), storePubkey: storeOf(1), epoch: 1, status: 'active' },
      { owner: ownerOf('2'), storePubkey: storeOf(2), epoch: 1, status: 'degraded' },
      { owner: ownerOf('3'), storePubkey: storeOf(3), epoch: 1, status: 'halted' },
      { owner: ownerOf('4'), storePubkey: storeOf(4), epoch: 1, status: 'suspending' },
    ]);
    expect(await leaseRow(db, ownerOf('5'))).toBeUndefined();
    expect(await leaseRow(db, ownerOf('6'))).toBeUndefined();
  });

  it('a renewal keeps the epoch; another holder cannot take an unexpired lease', async () => {
    const db = await freshDb();
    const owner = ownerOf('1');
    await seed(db, { [owner]: 'active' });
    await acquireLeases(db, 'h1', NOW, TTL);
    expect(await leasesOf(db, 'h1', NOW + 20, TTL)).toEqual([
      { owner, epoch: 1, status: 'active' },
    ]);
    expect(await leaseRow(db, owner)).toEqual({
      holder: 'h1',
      epoch: 1,
      expires_at: NOW + 20 + TTL,
    });
    expect(await leasesOf(db, 'h2', NOW + 21, TTL)).toEqual([]);
    expect((await leaseRow(db, owner))?.holder).toBe('h1');
  });

  it('a takeover after expiry bumps the epoch, and the old holder loses the store', async () => {
    const db = await freshDb();
    const owner = ownerOf('1');
    await seed(db, { [owner]: 'active' });
    await acquireLeases(db, 'h1', NOW, TTL);
    expect(await leasesOf(db, 'h2', NOW + TTL, TTL)).toEqual([
      { owner, epoch: 2, status: 'active' },
    ]);
    expect(await leasesOf(db, 'h1', NOW + TTL + 1, TTL)).toEqual([]);
    expect((await leaseRow(db, owner))?.holder).toBe('h2');
  });

  it('the same holder coming back after its lease expired gets a new epoch', async () => {
    const db = await freshDb();
    const owner = ownerOf('1');
    await seed(db, { [owner]: 'active' });
    await acquireLeases(db, 'h1', NOW, TTL);
    expect(await leasesOf(db, 'h1', NOW + TTL, TTL)).toEqual([
      { owner, epoch: 2, status: 'active' },
    ]);
  });

  it('a degraded, halted or suspending store keeps its lease and epoch', async () => {
    const db = await freshDb();
    const owner = ownerOf('1');
    await seed(db, { [owner]: 'active' });
    await acquireLeases(db, 'h1', NOW, TTL);
    let at = NOW;
    for (const status of ['degraded', 'halted', 'suspending'] as const) {
      await setStatus(db, owner, status);
      at += 10;
      expect(await leasesOf(db, 'h1', at, TTL)).toEqual([{ owner, epoch: 1, status }]);
    }
  });

  it('a store turned pending or suspended is let go, and its next lease has a new epoch', async () => {
    const db = await freshDb();
    const owner = ownerOf('1');
    await seed(db, { [owner]: 'active' });
    for (const [step, status] of (['suspended', 'pending'] as const).entries()) {
      const at = NOW + step * 100;
      await setStatus(db, owner, 'active');
      expect(await leasesOf(db, 'h1', at, TTL)).toHaveLength(1);
      await setStatus(db, owner, status);
      expect(await leasesOf(db, 'h1', at + 1, TTL)).toEqual([]);
      expect((await leaseRow(db, owner))?.expires_at).toBe(0);
      // Free at once for anyone.
      await setStatus(db, owner, 'active');
      expect(await leasesOf(db, 'h2', at + 2, TTL)).toEqual([
        { owner, epoch: 2 * (step + 1), status: 'active' },
      ]);
      await releaseLeases(db, 'h2');
    }
  });

  it('releaseLeases frees every lease of the holder only', async () => {
    const db = await freshDb();
    const mine = ownerOf('1');
    const theirs = ownerOf('2');
    await seed(db, { [mine]: 'active' });
    await acquireLeases(db, 'h1', NOW, TTL);
    await db.query(
      `insert into stores (owner, store_pubkey, status, tier, created_at) values ($1, $2, 'active', 'basic', $3)`,
      [theirs, 'f'.repeat(64), NOW],
    );
    await db.query('insert into leases (owner, holder, epoch, expires_at) values ($1, $2, 1, $3)', [
      theirs,
      'h2',
      NOW + TTL,
    ]);
    await releaseLeases(db, 'h1');
    expect((await leaseRow(db, mine))?.expires_at).toBe(0);
    expect((await leaseRow(db, theirs))?.expires_at).toBe(NOW + TTL);
    expect(await leasesOf(db, 'h3', NOW + 1, TTL)).toEqual([
      { owner: mine, epoch: 2, status: 'active' },
    ]);
  });

  it('holder ids are random per process', () => {
    expect(newHolderId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newHolderId()).not.toBe(newHolderId());
  });
});

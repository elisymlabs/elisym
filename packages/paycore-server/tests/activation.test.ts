import { describe, expect, it } from 'vitest';
import { pendingRequests } from '../src/admin/requests';
import type { Db } from '../src/db/db';
import { activateStore } from '../src/state/activation';
import { freshDb } from './pglite-db';
import { NOW, activate, directoryFor, ownerKeys } from './stores-fixtures';

async function pendingStore(db: Db): Promise<string> {
  const owner = ownerKeys().pubkey;
  await directoryFor(db).createStore(owner, { name: 'Shop', network: 'devnet' });
  await db.query("insert into tiers (name, max_products) values ('basic', 5)");
  return owner;
}

async function storeRow(db: Db, owner: string) {
  const [row] = await db.query<{ status: string; tier: string | null; plan_source: string | null }>(
    'select status, tier, plan_source from stores where owner = $1',
    [owner],
  );
  return row;
}

describe('activateStore', () => {
  it('makes a pending store active on a tier and queues its setup in one transaction', async () => {
    const db = await freshDb();
    const owner = await pendingStore(db);
    const result = await activateStore(db, owner, { tier: 'basic', now: NOW });
    expect(result.ok).toBe(true);
    expect(await storeRow(db, owner)).toEqual({
      status: 'active',
      tier: 'basic',
      plan_source: 'operator',
    });
    expect((await pendingRequests(db, owner)).map((request) => [request.id, request.kind])).toEqual(
      [[result.ok ? result.requestId : '', 'setup']],
    );
  });

  it('refuses a store that is not pending, changing nothing', async () => {
    const db = await freshDb();
    const owner = await pendingStore(db);
    await activate(db, owner, 2, 'suspended');
    expect(await activateStore(db, owner, { tier: 'basic', now: NOW })).toEqual({
      ok: false,
      error: 'not_pending',
    });
    expect(await storeRow(db, owner)).toMatchObject({ status: 'suspended', tier: 'tier-2' });
    expect(await pendingRequests(db, owner)).toEqual([]);
  });

  it('refuses an unknown tier, and no tier at all', async () => {
    const db = await freshDb();
    const owner = await pendingStore(db);
    expect(await activateStore(db, owner, { tier: 'gold', now: NOW })).toEqual({
      ok: false,
      error: 'no_tier',
    });
    expect(await activateStore(db, owner, { now: NOW })).toEqual({ ok: false, error: 'no_tier' });
    expect(await storeRow(db, owner)).toEqual({ status: 'pending', tier: null, plan_source: null });
    expect(await pendingRequests(db, owner)).toEqual([]);
    expect(await activateStore(db, ownerKeys().pubkey, { tier: 'basic', now: NOW })).toEqual({
      ok: false,
      error: 'no_store',
    });
  });

  it('takes the tier the store already has when none is given', async () => {
    const db = await freshDb();
    const owner = await pendingStore(db);
    await db.query("update stores set tier = 'basic' where owner = $1", [owner]);
    expect((await activateStore(db, owner, { now: NOW })).ok).toBe(true);
    expect(await storeRow(db, owner)).toMatchObject({ status: 'active', tier: 'basic' });
  });
});

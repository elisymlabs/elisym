import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db';
import { MIGRATIONS, migrate } from '../src/db/migrations';
import { freshDb } from './pglite-db';

const OWNER = 'a'.repeat(64);
const STORE = 'b'.repeat(64);
const NOW = 1_790_000_000;

async function seedStore(db: Db, status = 'active'): Promise<void> {
  await db.query("insert into tiers (name, max_products) values ('basic', 10)");
  await db.query(
    `insert into stores (owner, store_pubkey, status, tier, plan_source, created_at)
     values ($1, $2, $3, 'basic', 'operator', $4)`,
    [OWNER, STORE, status, NOW],
  );
}

async function rejects(db: Db, sql: string, params: unknown[] = []): Promise<void> {
  await expect(db.query(sql, params)).rejects.toThrow();
}

describe('migrations', () => {
  it('a second migrate is a no-op', async () => {
    const db = await freshDb();
    const before = await db.query<{ id: string }>('select id from migrations order by id');
    expect(before.map((row) => row.id)).toEqual(MIGRATIONS.map((migration) => migration.id));
    await migrate(db);
    await migrate(db);
    const after = await db.query<{ id: string }>('select id from migrations order by id');
    expect(after).toEqual(before);
  });
});

describe('0001_init check constraints', () => {
  it('tiers: max_products must be positive', async () => {
    const db = await freshDb();
    await rejects(db, "insert into tiers (name, max_products) values ('zero', 0)");
  });

  it('stores: unknown status, unknown plan source, and a non-pending store without a tier', async () => {
    const db = await freshDb();
    await seedStore(db);
    const insert = (status: string, tier: string | null, planSource: string | null) =>
      db.query(
        `insert into stores (owner, store_pubkey, status, tier, plan_source, created_at)
         values ($1, $2, $3, $4, $5, $6)`,
        ['c'.repeat(64), 'd'.repeat(64), status, tier, planSource, NOW],
      );
    await expect(insert('running', 'basic', 'operator')).rejects.toThrow();
    await expect(insert('active', 'basic', 'stripe')).rejects.toThrow();
    await expect(insert('active', null, null)).rejects.toThrow();
    await expect(insert('halted', null, null)).rejects.toThrow();
    // A store key is one store's only.
    await rejects(
      db,
      `insert into stores (owner, store_pubkey, status, created_at) values ($1, $2, 'pending', $3)`,
      ['e'.repeat(64), STORE, NOW],
    );
    await insert('pending', null, null);
  });

  it('store_config: network and evm_credit', async () => {
    const db = await freshDb();
    await seedStore(db);
    const insert = (network: string, evmCredit: string) =>
      db.query(
        `insert into store_config (owner, name, network, evm_credit, inbox_relays, updated_at)
         values ($1, 'Shop', $2, $3, $4, $5)`,
        [OWNER, network, evmCredit, ['wss://relay.elisym.network'], NOW],
      );
    await expect(insert('testnet', 'fast')).rejects.toThrow();
    await expect(insert('mainnet', 'slow')).rejects.toThrow();
    await insert('devnet', 'safe');
    const [row] = await db.query<{ draft_payouts: unknown; revision: number }>(
      'select draft_payouts, revision from store_config where owner = $1',
      [OWNER],
    );
    expect(row).toEqual({ draft_payouts: [], revision: 1 });
  });

  it('owner_event_drafts: kind, and a 10133 without its payouts string', async () => {
    const db = await freshDb();
    await seedStore(db);
    const insert = (kind: number, payouts: string | null) =>
      db.query(
        `insert into owner_event_drafts (owner, kind, template, payouts_string, expires_at)
         values ($1, $2, '{}', $3, $4)`,
        [OWNER, kind, payouts, NOW],
      );
    await expect(insert(1, null)).rejects.toThrow();
    await expect(insert(10133, null)).rejects.toThrow();
    await insert(30490, null);
    await insert(10133, '[]');
  });

  it('owner_events: kind, and a 10133 without its payouts string', async () => {
    const db = await freshDb();
    await seedStore(db);
    const insert = (id: string, kind: number, payouts: string | null) =>
      db.query(
        `insert into owner_events (id, owner, kind, event, payouts_string, committed_at)
         values ($1, $2, $3, '{}', $4, $5)`,
        [id, OWNER, kind, payouts, NOW],
      );
    await expect(insert('e1', 0, null)).rejects.toThrow();
    await expect(insert('e2', 10133, null)).rejects.toThrow();
    await insert('e3', 30490, null);
    await insert('e4', 10133, '[]');
    const [row] = await db.query<{ recorded: boolean; publish_attempts: number }>(
      "select recorded, publish_attempts from owner_events where id = 'e4'",
    );
    expect(row).toEqual({ recorded: false, publish_attempts: 0 });
  });

  it('admin_requests: kind and state', async () => {
    const db = await freshDb();
    await seedStore(db);
    const insert = (id: string, kind: string, state: string) =>
      db.query(
        `insert into admin_requests (id, owner, kind, payload, state, created_at)
         values ($1, $2, $3, '{}', $4, $5)`,
        [id, OWNER, kind, state, NOW],
      );
    await expect(insert('r1', 'delete', 'pending')).rejects.toThrow();
    await expect(insert('r2', 'restart', 'done')).rejects.toThrow();
    for (const kind of ['setup', 'record_owner_event', 'hand_answer', 'restart', 'suspend']) {
      await insert(`ok-${kind}`, kind, 'pending');
    }
  });

  it('alerts: one open alert per (owner, kind), a cleared one does not count', async () => {
    const db = await freshDb();
    const insert = (owner: string | null) =>
      db.query(
        `insert into alerts (owner, kind, message, created_at, last_seen_at)
         values ($1, 'drift', 'm', $2, $2)`,
        [owner, NOW],
      );
    await insert(null);
    await expect(insert(null)).rejects.toThrow();
    await insert(OWNER);
    await expect(insert(OWNER)).rejects.toThrow();
    await db.query('update alerts set cleared_at = $1 where owner = $2', [NOW, OWNER]);
    await insert(OWNER);
  });

  it('a store row deleted takes its dependent rows with it', async () => {
    const db = await freshDb();
    await seedStore(db);
    await db.query(
      `insert into ledgers (owner, row_version, lease_epoch, state, updated_at) values ($1, 1, 0, '{}', $2)`,
      [OWNER, NOW],
    );
    await db.query('insert into leases (owner, holder, epoch, expires_at) values ($1, $2, 1, $3)', [
      OWNER,
      'h',
      NOW,
    ]);
    await db.query('delete from stores where owner = $1', [OWNER]);
    expect(await db.query('select 1 from ledgers')).toEqual([]);
    expect(await db.query('select 1 from leases')).toEqual([]);
  });
});

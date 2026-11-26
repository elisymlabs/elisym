import { describe, expect, it } from 'vitest';
import { clearAlert, raiseAlert } from '../src/alerts';
import { movableStore, moveDeps, moved } from './move-fixtures';
import { freshDb } from './pglite-db';
import { ownerKeys } from './stores-fixtures';

const OWNER = 'a'.repeat(64);
const NOW = 1_790_000_000;

async function withStore() {
  const db = await freshDb();
  await db.query(
    `insert into stores (owner, store_pubkey, status, created_at) values ($1, $2, 'pending', $3)`,
    [OWNER, 'b'.repeat(64), NOW],
  );
  return db;
}

describe('alerts', () => {
  it('opens one row per owner and kind, and a repeat refreshes it', async () => {
    const db = await withStore();
    const lines: string[] = [];
    await raiseAlert(db, OWNER, 'start_failed', 'first', {
      now: NOW,
      log: (line) => lines.push(line),
    });
    await raiseAlert(db, OWNER, 'start_failed', 'second', { now: NOW + 5, log: () => undefined });
    await raiseAlert(db, OWNER, 'offer_mismatch', 'other', { now: NOW, log: () => undefined });
    const rows = await db.query<{
      kind: string;
      message: string;
      count: number;
      created_at: number;
      last_seen_at: number;
    }>('select kind, message, count, created_at, last_seen_at from alerts order by kind');
    expect(rows).toEqual([
      { kind: 'offer_mismatch', message: 'other', count: 1, created_at: NOW, last_seen_at: NOW },
      { kind: 'start_failed', message: 'second', count: 2, created_at: NOW, last_seen_at: NOW + 5 },
    ]);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      alert: 'start_failed',
      owner: OWNER,
      message: 'first',
    });
  });

  it('keeps server-wide alerts apart from store alerts, and clears only the one named', async () => {
    const db = await withStore();
    await raiseAlert(db, undefined, 'rpc', 'down', { now: NOW, log: () => undefined });
    await raiseAlert(db, undefined, 'rpc', 'still down', { now: NOW, log: () => undefined });
    await raiseAlert(db, OWNER, 'rpc', 'store', { now: NOW, log: () => undefined });
    expect(await clearAlert(db, undefined, 'rpc', { now: NOW + 1 })).toBe(true);
    expect(await clearAlert(db, undefined, 'rpc', { now: NOW + 1 })).toBe(false);
    const open = await db.query<{ owner: string | null; count: number }>(
      'select owner, count from alerts where cleared_at is null',
    );
    expect(open).toEqual([{ owner: OWNER, count: 1 }]);
  });

  it('opens a new row after a clear', async () => {
    const db = await withStore();
    await raiseAlert(db, OWNER, 'x', 'one', { now: NOW, log: () => undefined });
    await clearAlert(db, OWNER, 'x', { now: NOW + 1 });
    await raiseAlert(db, OWNER, 'x', 'two', { now: NOW + 2, log: () => undefined });
    const rows = await db.query<{ message: string; cleared_at: number | null }>(
      'select message, cleared_at from alerts order by id',
    );
    expect(rows).toEqual([
      { message: 'one', cleared_at: NOW + 1 },
      { message: 'two', cleared_at: null },
    ]);
  });
});

describe('alerts of a moved store', () => {
  it("drops (and logs) a stale run's raise and clear for the former owner; the new owner's are untouched", async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const former = store.owner.pubkey;
    const to = ownerKeys();
    expect((await moved(moveDeps(db, store.directory), store, to)).result.ok).toBe(true);
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    await raiseAlert(db, former, 'start_failed', 'stale run', { now: NOW, log });
    expect(await clearAlert(db, former, 'moved', { now: NOW, log })).toBe(false);
    const open = await db.query<{ owner: string; kind: string }>(
      'select owner, kind from alerts where cleared_at is null order by owner, kind',
    );
    expect(open).toEqual([{ owner: former, kind: 'moved' }]);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { alert: 'start_failed', owner: former, message: 'stale run', dropped: 'moved' },
      { clear: 'moved', owner: former, dropped: 'moved' },
    ]);

    // The new owner's alerts behave as any store's.
    await raiseAlert(db, to.pubkey, 'start_failed', 'new run', { now: NOW, log: () => undefined });
    expect(await store.directory.openAlertKinds(to.pubkey)).toEqual(['start_failed']);
    expect(await clearAlert(db, to.pubkey, 'start_failed', { now: NOW })).toBe(true);
    expect(await store.directory.openAlertKinds(to.pubkey)).toEqual([]);
  });

  it('an owner key that never had a store (or the whole server) still opens alerts', async () => {
    const db = await freshDb();
    const unknown = 'e'.repeat(64);
    await raiseAlert(db, unknown, 'drift', 'x', { now: NOW, log: () => undefined });
    await raiseAlert(db, undefined, 'drift', 'y', { now: NOW, log: () => undefined });
    expect(
      await db.query('select owner, kind from alerts where cleared_at is null order by id'),
    ).toEqual([
      { owner: unknown, kind: 'drift' },
      { owner: null, kind: 'drift' },
    ]);
    expect(await clearAlert(db, unknown, 'drift', { now: NOW })).toBe(true);
  });
});

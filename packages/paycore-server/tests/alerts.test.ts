import { describe, expect, it } from 'vitest';
import { clearAlert, raiseAlert } from '../src/alerts';
import { freshDb } from './pglite-db';

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

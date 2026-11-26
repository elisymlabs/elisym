import type { Queryable } from '../db/db';
import { AUTH_WINDOW_SECS } from './nip98';

/**
 * How long an authorization id is kept: past the last second it is valid in
 * (created_at + window), with one more window of slack for a sweeping instance
 * whose clock runs ahead, so it is never accepted twice.
 */
export function authIdExpiry(createdAt: number, now: number): number {
  return Math.max(createdAt, now) + 2 * AUTH_WINDOW_SECS + 1;
}

/** Record an admin authorization id until it expires; false when it was already used (replay). */
export async function recordAuthId(db: Queryable, id: string, expiresAt: number): Promise<boolean> {
  const rows = await db.query(
    `insert into admin_auth_ids (id, expires_at) values ($1, $2)
     on conflict (id) do nothing returning 1`,
    [id, expiresAt],
  );
  return rows.length > 0;
}

/** Forget authorization ids past their expiry (they would be refused as stale anyway). */
export async function sweepAuthIds(db: Queryable, now: number): Promise<void> {
  await db.query('delete from admin_auth_ids where expires_at <= $1', [now]);
}

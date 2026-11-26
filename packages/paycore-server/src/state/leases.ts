import { randomBytes } from 'node:crypto';
import type { Db } from '../db/db';

/** A lease lives this long past its last renewal: a crashed holder's stores move after it. */
export const LEASE_TTL_SECS = 60;
/** How often a holder renews its leases (well inside the TTL). */
export const LEASE_RENEW_MS = 20_000;

export type StoreStatus = 'pending' | 'active' | 'degraded' | 'halted' | 'suspending' | 'suspended';

/** Statuses whose store is served (or retried, `halted`) by the lease holder. */
export const LEASED_STATUSES: readonly StoreStatus[] = [
  'active',
  'degraded',
  'halted',
  'suspending',
];
/** Statuses whose lease the holder lets go: nothing runs for them. */
export const RELEASED_STATUSES: readonly StoreStatus[] = ['pending', 'suspended'];

export interface LeasedStore {
  owner: string;
  epoch: number;
  status: StoreStatus;
}

/** A holder id, random per process: a restarted process takes its stores over with a new epoch. */
export function newHolderId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Take or renew the lease of every store in a leased status whose lease is
 * free, expired or already ours, and let go of ours on stores now `pending` /
 * `suspended`. The epoch stays while the same holder renews an unexpired
 * lease, and grows on every takeover, including the same holder coming back
 * after its lease expired (its old runs may have saved nothing since, but a
 * new holder may have). Returns the stores this holder now leases.
 */
export async function acquireLeases(
  db: Db,
  holder: string,
  now: number,
  ttlSecs: number = LEASE_TTL_SECS,
): Promise<LeasedStore[]> {
  return db.transaction(async (tx) => {
    await tx.query(
      `update leases set expires_at = 0
       where holder = $1 and owner in (select owner from stores where status = any($2::text[]))`,
      [holder, RELEASED_STATUSES],
    );
    await tx.query(
      `insert into leases (owner, holder, epoch, expires_at)
       select owner, $1, 1, $3 from stores where status = any($4::text[])
       on conflict (owner) do update set
         epoch = case when leases.holder = $1 and leases.expires_at > $2
           then leases.epoch else leases.epoch + 1 end,
         holder = $1,
         expires_at = $3
       where leases.holder = $1 or leases.expires_at <= $2`,
      [holder, now, now + ttlSecs, LEASED_STATUSES],
    );
    return tx.query<{ owner: string; epoch: number; status: StoreStatus }>(
      `select s.owner, l.epoch, s.status from stores s join leases l on l.owner = s.owner
       where l.holder = $1 and l.expires_at > $2 and s.status = any($3::text[])
       order by s.owner`,
      [holder, now, LEASED_STATUSES],
    );
  });
}

/** Let go of every lease this holder has (shutdown): another process takes them at once. */
export async function releaseLeases(db: Db, holder: string): Promise<void> {
  await db.query('update leases set expires_at = 0 where holder = $1', [holder]);
}

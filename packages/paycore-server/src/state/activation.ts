/**
 * A pending store's activation (the operator's `store activate`, step 16):
 * it gets a tier and becomes `active`, and a `setup` request is queued in the
 * same transaction. The holder that leases it next applies that request: the
 * setup pass publishes the store with its committed owner events. Requests
 * queued while it was pending (owner events committed before activation) stay
 * pending until then and are applied after it.
 */
import { insertRequest } from '../admin/requests';
import { type Db, STORES_CHANNEL } from '../db/db';

export type ActivationResult =
  | { ok: true; requestId: string }
  | { ok: false; error: 'no_store' | 'not_pending' | 'no_tier' };

export async function activateStore(
  db: Db,
  owner: string,
  options: { tier?: string; now: number },
): Promise<ActivationResult> {
  return db.transaction(async (tx): Promise<ActivationResult> => {
    const [store] = await tx.query<{ status: string; tier: string | null }>(
      'select status, tier from stores where owner = $1 for update',
      [owner],
    );
    if (store === undefined) {
      return { ok: false, error: 'no_store' };
    }
    if (store.status !== 'pending') {
      return { ok: false, error: 'not_pending' };
    }
    // Lock order: the store (above), then the tier (the foreign key's share
    // lock on the tier row at the update), as `tier set` and `store tier`.
    const tier = options.tier ?? store.tier;
    const [known] =
      tier === null ? [] : await tx.query('select 1 from tiers where name = $1', [tier]);
    if (known === undefined) {
      return { ok: false, error: 'no_tier' };
    }
    await tx.query(
      `update stores set status = 'active', status_reason = null, tier = $2, plan_source = 'operator'
       where owner = $1`,
      [owner, tier],
    );
    const requestId = await insertRequest(tx, owner, 'setup', { activation: true }, options.now);
    await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
    return { ok: true, requestId };
  });
}

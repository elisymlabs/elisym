import { KIND_STORE_PROFILE, parseStoreProfile } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import type { Db } from '../../src/db/db';
import type { KeyVault } from '../../src/db/keys';
import { solanaWallet } from '../stores-fixtures';
import {
  type Key,
  NOW,
  USDC_DEVNET_CAIP19,
  insertOwnerEvent,
  key,
  ownerEvents,
} from './node-store';
import type { RelayWorld } from './node-world';

/** The new owner's payout list: a wallet proven for the new key. */
export function movedPayouts(
  next: string,
): { caip19: string; address: string; signature: string }[] {
  const wallet = solanaWallet();
  return [
    {
      caip19: USDC_DEVNET_CAIP19,
      address: wallet.address,
      signature: wallet.prove(next, USDC_DEVNET_CAIP19),
    },
  ];
}

export interface SimulatedMove {
  next: Key;
  payouts: { caip19: string; address: string; signature: string }[];
  events: { payoutList: NostrEvent; authorization: NostrEvent };
  moveId: number;
}

/**
 * The rows a committed move leaves (`moveStore` without its checks): the
 * store rekeyed to a new key, its key resealed, the new owner's 10133 and
 * 30490 committed unrecorded (the 10133 dated `paytoAt`), the move row.
 */
export async function simulateMove(
  db: Db,
  keys: KeyVault,
  seed: { owner: Key; store: Key },
  options: { paytoAt?: number; switchedAt?: number | null; movedAt?: number } = {},
): Promise<SimulatedMove> {
  const next = key();
  const payouts = movedPayouts(next.pubkey);
  const events = ownerEvents(next, seed.store, payouts, options.paytoAt ?? NOW - 30);
  const from = seed.owner.pubkey;
  await db.transaction(async (tx) => {
    await tx.query('update store_keys set store_key = $2 where owner = $1', [
      from,
      keys.seal(seed.store.secretKey, next.pubkey, 'store'),
    ]);
    await tx.query('delete from owner_events where owner = $1', [from]);
    await tx.query('update stores set owner = $2 where owner = $1', [from, next.pubkey]);
    await tx.query('update alerts set owner = $2 where owner = $1', [from, next.pubkey]);
  });
  await insertOwnerEvent(db, next.pubkey, events.payoutList, JSON.stringify(payouts), false);
  await insertOwnerEvent(db, next.pubkey, events.authorization, undefined, false);
  const movedAt = options.movedAt ?? NOW - 20;
  const [row] = await db.query<{ id: number }>(
    `insert into store_moves (from_owner, to_owner, store_pubkey, moved_at, switched_at, old_events)
     values ($1, $2, $3, $4, $5, '[]') returning id`,
    [from, next.pubkey, seed.store.pubkey, movedAt, options.switchedAt ?? null],
  );
  return { next, payouts, events, moveId: row?.id ?? 0 };
}

/** The store profiles on `world`, newest first, as (owner named, date). */
export function profilesOn(world: RelayWorld, store: Key): { owner: string; createdAt: number }[] {
  return world.events
    .filter((event) => event.kind === KIND_STORE_PROFILE && event.pubkey === store.pubkey)
    .map((event) => ({
      owner: parseStoreProfile(event)?.ownerPubkey ?? '',
      createdAt: event.created_at,
    }))
    .sort((left, right) => right.createdAt - left.createdAt);
}

export async function switchedAt(db: Db, moveId: number): Promise<number | null | undefined> {
  const [row] = await db.query<{ switched_at: number | null }>(
    'select switched_at from store_moves where id = $1',
    [moveId],
  );
  return row?.switched_at;
}

import { KIND_PAYTO } from '@elisym/commerce';
import { emptyLedger } from '@merchant-node/ledger';
import { ownerEventTemplates } from '@merchant-node/store-events';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { expect } from 'vitest';
import type { Db, Queryable } from '../src/db/db';
import { KeyVault } from '../src/db/keys';
import type { StoreStatus } from '../src/state/leases';
import { serializeLedger } from '../src/state/ledger-store';
import {
  type MoveDeps,
  type MoveRelayFacts,
  type MoveTemplates,
  moveStore,
  prepareMove,
} from '../src/state/moves';
import { type StoreDirectory, canonicalPayouts } from '../src/state/stores';
import {
  MASTER_KEY,
  NOW,
  OPERATOR,
  PRODUCT,
  RELAY,
  USDC_DEVNET,
  activate,
  directoryFor,
  ownerKeys,
  solanaWallet,
} from './stores-fixtures';

export type Keys = ReturnType<typeof ownerKeys>;
export type Wallet = ReturnType<typeof solanaWallet>;

export const VAULT = new KeyVault(MASTER_KEY);

/** A clock the tests move. */
export function testClock(start = NOW): { now: () => number; set: (value: number) => void } {
  let current = start;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
  };
}

export interface StoreOptions {
  status?: StoreStatus;
  /** A webhook secret sealed for O. */
  webhook?: boolean;
  /** The ledger's active payout list (`state.payto`), as published an hour ago. */
  payto?: boolean;
  /** O's committed 10133: recorded (and published), unrecorded, or none. */
  paytoEvent?: 'recorded' | 'unrecorded' | 'none';
  /** O's committed 30490: recorded (and published), unrecorded, or none. */
  authEvent?: 'recorded' | 'unrecorded' | 'none';
  /** The draft payouts: O's proven wallet (default), or none. */
  draft?: 'proven' | 'none';
}

export interface MovableStore {
  owner: Keys;
  wallet: Wallet;
  storePubkey: string;
  directory: StoreDirectory;
  /** O's committed events, as inserted. */
  events: { payto?: NostrEvent; auth?: NostrEvent };
}

/** The payout list of `wallet` proven for `owner`. */
export function provenPayouts(
  wallet: Wallet,
  owner: string,
): { caip19: string; address: string; signature: string }[] {
  return [
    { caip19: USDC_DEVNET, address: wallet.address, signature: wallet.prove(owner, USDC_DEVNET) },
  ];
}

/**
 * A store made as the admin makes one, then put in `status`: the draft
 * payouts proven for O, a product, and as asked O's committed owner events
 * and the ledger's active payout list. Defaults: active, published.
 */
export async function movableStore(
  db: Db,
  options: StoreOptions = {},
  now: () => number = () => NOW,
): Promise<MovableStore> {
  const directory = directoryFor(db, { now });
  const owner = ownerKeys();
  const wallet = solanaWallet();
  const created = await directory.createStore(owner.pubkey, { name: 'Shop', network: 'devnet' });
  const storePubkey = created.store.storePubkey;
  const payouts = provenPayouts(wallet, owner.pubkey);
  if (options.draft !== 'none') {
    const put = await directory.putConfig(owner.pubkey, {
      name: 'Shop',
      payouts,
      inboxRelays: [RELAY],
    });
    expect(put.ok).toBe(true);
  }
  const product = await directory.putProduct(owner.pubkey, 'socks', PRODUCT);
  expect(product.ok).toBe(true);
  if (options.webhook === true) {
    const rotated = await directory.rotateWebhookSecret(owner.pubkey);
    expect(rotated.ok).toBe(true);
  }
  const status = options.status ?? 'active';
  if (status !== 'pending') {
    await activate(db, owner.pubkey, 5, status);
  }
  const text = canonicalPayouts(payouts)?.text ?? '';
  if (options.payto ?? status !== 'pending') {
    await db.query('update ledgers set state = $2 where owner = $1', [
      owner.pubkey,
      serializeLedger({ ...emptyLedger(), payto: { createdAt: NOW - 3600, payouts: text } }),
    ]);
  }
  const templates = ownerEventTemplates(
    { payouts },
    owner.pubkey,
    storePubkey,
    NOW - 3600,
    NOW - 3600,
    {
      mode: 'hosted',
      operator: OPERATOR,
    },
  );
  const events: MovableStore['events'] = {};
  const published = status === 'pending' ? 'unrecorded' : 'recorded';
  const paytoEvent = options.paytoEvent ?? published;
  const authEvent = options.authEvent ?? published;
  if (paytoEvent !== 'none') {
    events.payto = finalizeEvent({ ...templates.payoutList }, owner.secret);
    await insertOwnerEvent(db, owner.pubkey, events.payto, text, paytoEvent === 'recorded');
  }
  if (authEvent !== 'none') {
    events.auth = finalizeEvent({ ...templates.authorization }, owner.secret);
    await insertOwnerEvent(db, owner.pubkey, events.auth, undefined, authEvent === 'recorded');
  }
  return { owner, wallet, storePubkey, directory, events };
}

export async function insertOwnerEvent(
  db: Queryable,
  owner: string,
  event: NostrEvent,
  payoutsString: string | undefined,
  recorded: boolean,
): Promise<void> {
  await db.query(
    `insert into owner_events (id, owner, kind, event, payouts_string, committed_at, recorded,
       published_at)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      event.id,
      owner,
      event.kind,
      JSON.stringify(event),
      event.kind === KIND_PAYTO ? (payoutsString ?? '[]') : null,
      NOW - 3600,
      recorded,
      recorded ? NOW - 3600 : null,
    ],
  );
}

export function moveDeps(
  db: Db,
  directory: StoreDirectory,
  now: () => number = () => NOW,
): MoveDeps {
  return { db, directory, operator: OPERATOR, now, log: () => undefined };
}

/** The templates signed: O''s two by `to`, the revocation by O. */
export function signMove(
  templates: Pick<MoveTemplates, 'payto' | 'auth' | 'revocation'>,
  owner: Keys,
  to: Keys,
): { payto: NostrEvent; auth: NostrEvent; revocation?: NostrEvent } {
  return {
    payto: finalizeEvent({ ...templates.payto }, to.secret),
    auth: finalizeEvent({ ...templates.auth }, to.secret),
    ...(templates.revocation === null
      ? {}
      : { revocation: finalizeEvent({ ...templates.revocation }, owner.secret) }),
  };
}

/** Prepare the move of `store` to `to` with its wallet proven for `to`; throws when refused. */
export async function preparedMove(
  deps: MoveDeps,
  store: Pick<MovableStore, 'owner' | 'wallet'>,
  to: Keys,
  relays: MoveRelayFacts = {},
): Promise<MoveTemplates> {
  const prepared = await prepareMove(
    deps,
    store.owner.pubkey,
    { to: to.pubkey, payouts: provenPayouts(store.wallet, to.pubkey) },
    relays,
  );
  if (!prepared.ok) {
    throw new Error(
      `prepare refused: ${prepared.error} ${JSON.stringify(prepared.problems ?? [])}`,
    );
  }
  return prepared;
}

/** Prepare, sign with both keys and commit the move of `store` to `to`. */
export async function moved(
  deps: MoveDeps,
  store: Pick<MovableStore, 'owner' | 'wallet'>,
  to: Keys,
  relays: MoveRelayFacts = {},
) {
  const templates = await preparedMove(deps, store, to, relays);
  const result = await moveStore(
    deps,
    store.owner.pubkey,
    { to: to.pubkey, ...signMove(templates, store.owner, to) },
    relays,
  );
  return { templates, result };
}

/** The store's latest move row. */
export async function latestMoveRow(db: Queryable, storePubkey: string) {
  const [row] = await db.query<{
    id: number;
    from_owner: string;
    to_owner: string;
    moved_at: number;
    switched_at: number | null;
    revocation: NostrEvent | null;
    revocation_published_at: number | null;
    publish_attempts: number;
    next_attempt_at: number;
    old_events: { id: string }[];
  }>('select * from store_moves where store_pubkey = $1 order by id desc limit 1', [storePubkey]);
  return row;
}

/**
 * The server's setup pass (sub-plan step 11): merchant-node's `runSetupPass`
 * over a store's rows, run on its control queue (the node stopped, a fresh
 * ledger handle). The store key signs the profile and the inbox list (10050)
 * at the pass's start; the payout list (10133) and the authorization (30490)
 * are the newest the owner signed and the server committed, never re-signed.
 * It is the only path that publishes an owner event the first time, and the
 * only one that marks it `recorded`: a 10133 when its payout list went out
 * (the ledger's `state.payto` then holds its payouts string, P9), a 30490
 * when it went out. A store winding down (step 15) publishes every listing
 * sold out. The 10050 names the merchant's draft inbox relays; the store
 * switches to them (`store_config.inbox_relays`, what its node listens on)
 * only in the save of a pass whose 10050 a default relay took, where buyers
 * read it - before that, orders still come to the relays buyers know.
 */
import { KIND_INBOX_RELAYS, KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import type { Network } from '@elisym/pay-core';
import { OFFER_RELAYS } from '@merchant-node/constants';
import { feeDeclaration } from '@merchant-node/fee';
import { setupPublisher } from '@merchant-node/publish';
import { type ListingOutcome, runSetupPass } from '@merchant-node/setup-ledger';
import { buildStoreSignedEvents } from '@merchant-node/store-events';
import { storeAuth } from '@merchant-node/store-node';
import type { NostrEvent } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import type { NetworkTreasuries } from '../chain/treasuries';
import type { Db, Queryable } from '../db/db';
import type { KeyVault } from '../db/keys';
import type { StorePools } from '../relay/pools';
import type { StoreStatus } from '../state/leases';
import type { LedgerHandle } from '../state/ledger-store';
import { canonicalPayouts } from '../state/stores';
import { StartRefused, allowedInboxRelays, readProducts } from './load';

export interface SetupPassDeps {
  db: Db;
  vault: KeyVault;
  /** The store's relay pools: its node is stopped while the pass runs, so its pool is free. */
  pools: Pick<StorePools, 'open' | 'close'>;
  treasuries: Pick<NetworkTreasuries, 'refreshFor'>;
  /** `PAYCORE_INBOX_RELAYS` (P7). */
  inboxRelayAllowlist: readonly string[];
  /** Where offers go besides the inbox relays (default: merchant-node's `OFFER_RELAYS`). */
  offerRelays?: readonly string[];
  log?: (message: string) => void;
  /** Seconds. */
  now: () => number;
}

export interface SetupPassOptions {
  /**
   * An `admin_requests` id marked applied in the pass's save - unless the
   * committed payout list was never recorded and did not go out this time
   * (`payoutListPending`): the request then stays pending, retried.
   */
  appliedRequest?: string;
}

export type SetupPassResult =
  | {
      kind: 'done';
      /** The committed payout list went out (and is now the active one). */
      payoutListOut: boolean;
      /** The committed payout list was never recorded and did not go out now: it still waits. */
      payoutListPending: boolean;
      /** The committed authorization went out (undefined: none committed). */
      authorizationOut: boolean | undefined;
      /** The draft inbox relays are now the active ones (their 10050 reached a default relay). */
      inboxRelaysSwitched: boolean;
      /** The draft inbox relays differ from the active ones and their 10050 reached no default relay. */
      inboxRelaysPending: boolean;
      outcomes: { d: string; onSale: boolean; listing: ListingOutcome['listing'] }[];
      /** Events no default relay took: buyers may not read them yet. */
      missedDefaults: string[];
    }
  /** No payout list committed yet: nothing can be published (the ledger is untouched). */
  | { kind: 'no_payout_list' };

/** The pass published nothing, or was refused before publishing: the ledger is left as it was. */
export class SetupPassFailed extends Error {
  constructor(
    readonly owner: string,
    problem: string,
  ) {
    super(problem);
    this.name = 'SetupPassFailed';
  }
}

interface StoreRow extends Record<string, unknown> {
  status: StoreStatus;
  store_pubkey: string;
  store_key: Uint8Array | null;
  name: string | null;
  nip05: string | null;
  network: Network | null;
  inbox_relays: string[] | null;
  draft_inbox_relays: string[] | null;
}

interface CommittedRow extends Record<string, unknown> {
  id: string;
  event: NostrEvent | string;
  payouts_string: string | null;
  recorded: boolean;
}

function eventOf(row: CommittedRow): NostrEvent {
  return typeof row.event === 'string' ? (JSON.parse(row.event) as NostrEvent) : row.event;
}

/** The newest owner event of `kind` the server committed for `owner`, by its date. */
export async function newestCommitted(
  db: Db,
  owner: string,
  kind: number,
): Promise<
  | { id: string; event: NostrEvent; payoutsString: string | undefined; recorded: boolean }
  | undefined
> {
  const [row] = await db.query<CommittedRow>(
    `select id, event, payouts_string, recorded from owner_events where owner = $1 and kind = $2
     order by (event->>'created_at')::bigint desc, committed_at desc limit 1`,
    [owner, kind],
  );
  return row === undefined
    ? undefined
    : {
        id: row.id,
        event: eventOf(row),
        payoutsString: row.payouts_string ?? undefined,
        recorded: row.recorded,
      };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one setup pass for `owner` on `handle` (a control task: the node is
 * stopped). Saves through the handle (marking `appliedRequest`) only when
 * something went out; throws `SetupPassFailed` otherwise, the ledger and the
 * owner events left as they were.
 */
export async function runStoreSetupPass(
  deps: SetupPassDeps,
  owner: string,
  handle: LedgerHandle,
  options: SetupPassOptions = {},
): Promise<SetupPassResult> {
  const { db } = deps;
  const log = deps.log ?? ((message: string) => console.error(message));
  const [row] = await db.query<StoreRow>(
    `select s.status, s.store_pubkey, k.store_key, c.name, c.nip05, c.network, c.inbox_relays,
            c.draft_inbox_relays
     from stores s
     left join store_keys k on k.owner = s.owner
     left join store_config c on c.owner = s.owner
     where s.owner = $1`,
    [owner],
  );
  if (row === undefined) {
    throw new SetupPassFailed(owner, `no store ${owner}`);
  }
  if (
    row.store_key === null ||
    row.name === null ||
    row.network === null ||
    row.inbox_relays === null
  ) {
    throw new SetupPassFailed(owner, 'the store has no key or no config');
  }
  const payoutList = await newestCommitted(db, owner, KIND_PAYTO);
  if (payoutList === undefined) {
    return { kind: 'no_payout_list' };
  }
  const authorization = await newestCommitted(db, owner, KIND_STORE_AUTH);
  // The exact string committed with the list (P9) is what `state.payto` records, never rebuilt.
  const payoutsString = payoutList.payoutsString;
  let payouts: ReturnType<typeof canonicalPayouts>;
  try {
    payouts = canonicalPayouts(JSON.parse(payoutsString ?? 'null'));
  } catch {
    payouts = undefined;
  }
  if (payouts === undefined || payoutsString === undefined) {
    throw new SetupPassFailed(owner, 'the committed payout list has no payouts string');
  }
  const storeSecretKey = deps.vault.open(row.store_key, owner, 'store');
  if (getPublicKey(storeSecretKey) !== row.store_pubkey) {
    throw new SetupPassFailed(owner, 'the sealed store key is not the store pubkey');
  }
  // The 10050 names the draft; the active relays (where buyers send orders now) hear it too.
  let inboxRelays: string[];
  try {
    inboxRelays = allowedInboxRelays(
      owner,
      row.draft_inbox_relays ?? row.inbox_relays,
      deps.inboxRelayAllowlist,
    );
  } catch (error) {
    throw new SetupPassFailed(owner, error instanceof StartRefused ? error.message : 'no relays');
  }
  const activeRelays = allowedOnly(row.inbox_relays, deps.inboxRelayAllowlist);
  const switching = !sameRelays(inboxRelays, activeRelays, row.inbox_relays);
  const products = await readProducts(db, owner, row.status);
  const { state } = handle;
  let declare: boolean;
  try {
    const refresh = await deps.treasuries.refreshFor(row.network, state, deps.now());
    declare = feeDeclaration(state, row.network, refresh).declare;
  } catch (error) {
    throw new SetupPassFailed(owner, errorText(error));
  }
  const offerRelays = deps.offerRelays ?? OFFER_RELAYS;
  const relays = [...new Set([...offerRelays, ...inboxRelays, ...activeRelays])];
  const storePubkey = row.store_pubkey;
  const profile = { name: row.name, ...(row.nip05 === null ? {} : { nip05: row.nip05 }) };
  const pool = deps.pools.open(storePubkey);
  const went = new Map<string, { out: boolean; defaults: boolean }>();
  let inboxListId: string | undefined;
  let outcomes: ListingOutcome[];
  let missedDefaults: string[];
  try {
    const publisher = setupPublisher(
      pool,
      relays,
      offerRelays,
      storeAuth(storeSecretKey),
      (message) => log(`store ${owner.slice(0, 12)}: ${message}`),
    );
    const publish = async (event: NostrEvent, name: string): Promise<boolean> => {
      const missed = publisher.missedDefaults.length;
      const out = await publisher.publish(event, name);
      went.set(event.id, { out, defaults: publisher.missedDefaults.length === missed });
      return out;
    };
    try {
      outcomes = await runSetupPass(state, {
        pool,
        relays,
        defaultRelays: offerRelays,
        pubkeys: { storePubkey, ownerPubkey: owner },
        products,
        payouts: payouts.list,
        payoutsString,
        storeSecretKey,
        sign: ({ startedAt }) => {
          const storeSigned = buildStoreSignedEvents(
            { ...profile, inboxRelays },
            storeSecretKey,
            owner,
            startedAt,
            declare,
          );
          inboxListId = storeSigned.find((event) => event.kind === KIND_INBOX_RELAYS)?.id;
          return {
            payoutList: payoutList.event,
            others: [...storeSigned, ...(authorization === undefined ? [] : [authorization.event])],
          };
        },
        publish,
        now: deps.now,
      });
    } catch (error) {
      throw new SetupPassFailed(owner, errorText(error));
    }
    missedDefaults = [...publisher.missedDefaults];
  } finally {
    deps.pools.close(storePubkey);
  }
  const listOut = went.get(payoutList.event.id);
  const authOut = authorization === undefined ? undefined : went.get(authorization.event.id);
  const outEvents = [
    ...(listOut?.out === true ? [{ id: payoutList.id, defaults: listOut.defaults }] : []),
    ...(authorization !== undefined && authOut?.out === true
      ? [{ id: authorization.id, defaults: authOut.defaults }]
      : []),
  ];
  const savedAt = deps.now();
  const payoutListPending = !payoutList.recorded && listOut?.out !== true;
  const inboxOut = inboxListId === undefined ? undefined : went.get(inboxListId);
  const inboxRelaysSwitched = switching && inboxOut?.out === true && inboxOut.defaults;
  // A request whose payout list or inbox relays did not go out stays pending: the holder retries it.
  const applied =
    payoutListPending || (switching && !inboxRelaysSwitched) ? undefined : options.appliedRequest;
  // `recorded` commits with the terms it stands for, or not at all; the node
  // listens on the new inbox relays from the save that says buyers read them.
  await handle.save(state, {
    ...(applied === undefined ? {} : { appliedRequest: applied }),
    alongside: async (tx) => {
      await markWentOut(tx, owner, savedAt, outEvents);
      if (inboxRelaysSwitched) {
        await tx.query('update store_config set inbox_relays = $2 where owner = $1', [
          owner,
          inboxRelays,
        ]);
      }
    },
  });
  return {
    kind: 'done',
    payoutListOut: listOut?.out === true,
    payoutListPending,
    authorizationOut: authOut?.out,
    inboxRelaysSwitched,
    inboxRelaysPending: switching && !inboxRelaysSwitched,
    outcomes: outcomes.map((outcome) => ({
      d: outcome.d,
      onSale: outcome.onSale,
      listing: outcome.listing,
    })),
    missedDefaults,
  };
}

/** The relays of `relays` in the allowlist, in its spelling: a relay outside it is never connected to (P7). */
function allowedOnly(relays: readonly string[], allowlist: readonly string[]): string[] {
  return relays.flatMap((relay) => {
    try {
      return allowedInboxRelays('', [relay], allowlist);
    } catch {
      return [];
    }
  });
}

/** Whether the draft names exactly the active relays (the stored list, every one allowed). */
function sameRelays(
  draft: readonly string[],
  allowedActive: readonly string[],
  storedActive: readonly string[],
): boolean {
  return (
    allowedActive.length === storedActive.length &&
    draft.length === allowedActive.length &&
    draft.every((relay, index) => relay === allowedActive[index])
  );
}

/**
 * Mark the owner events that went out `recorded`, and `published` when a
 * default relay took them (else the publisher retries them).
 */
async function markWentOut(
  db: Queryable,
  owner: string,
  now: number,
  events: readonly { id: string; defaults: boolean }[],
): Promise<void> {
  for (const event of events) {
    await db.query(
      `update owner_events set recorded = true,
         published_at = case when $3 then coalesce(published_at, $4) else published_at end
       where id = $1 and owner = $2`,
      [event.id, owner, event.defaults, now],
    );
  }
}

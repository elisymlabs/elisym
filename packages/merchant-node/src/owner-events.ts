/**
 * Owner events signed elsewhere (a store-only home: the owner key never comes
 * here). `setup` publishes the payout list (kind 10133) and the store
 * authorization (kind 30490) from `owner-events.json` instead of signing them,
 * and refuses anything buyers would judge differently from what this node
 * records: another payout list than `config.payouts`, a date that loses to the
 * relays, an authorization the owner has since revoked.
 */
import { readFileSync } from 'node:fs';
import {
  KIND_DELETION,
  KIND_PAYTO,
  KIND_STORE_AUTH,
  MAX_FUTURE_SKEW_SECS,
  buildPaytoEvent,
  readStoreAuth,
  storeAuthAddress,
} from '@elisym/commerce';
import { type NostrEvent, verifyEvent } from 'nostr-tools/pure';
import { z } from 'zod';
import { type QueryPool, READ_WAIT_MS, newest } from './checks';
import type { LedgerState } from './ledger';
import type { StoreConfig } from './store-events';

/** The file in the home that holds them. */
export const OWNER_EVENTS_FILE = 'owner-events.json';

/** The exit code of an owner-side refusal: only the owner (the console) can resolve it. */
export const OWNER_REFUSAL_EXIT_CODE = 3;

/** What an owner-side refusal is about: re-sign the events, or re-authorize a revoked store. */
export type OwnerRefusalReason = 'owner-resign' | 'owner-revoked';

/**
 * A refusal only the owner can resolve. The CLI prints it as `refused <reason>: ...`
 * and exits with `OWNER_REFUSAL_EXIT_CODE`, so a control plane can tell it from a
 * failure worth retrying without reading the wording.
 */
export class OwnerRefusal extends Error {
  constructor(
    readonly reason: OwnerRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = 'OwnerRefusal';
  }
}

export interface OwnerEvents {
  payoutList: NostrEvent;
  auth: NostrEvent;
}

const EVENT_SCHEMA = z.object({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number().int(),
  kind: z.number().int(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string(),
});

const OWNER_EVENTS_SCHEMA = z.object({ payoutList: EVENT_SCHEMA, auth: EVENT_SCHEMA });

/** `owner-events.json` as written by the console: both events, each signed. */
export function readOwnerEventsFile(path: string): OwnerEvents {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        `this store-only home has no ${OWNER_EVENTS_FILE}: the owner signs the payout list and the store authorization elsewhere`,
      );
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${OWNER_EVENTS_FILE} is not JSON`);
  }
  const parsed = OWNER_EVENTS_SCHEMA.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${OWNER_EVENTS_FILE} holds no usable events`);
  }
  return parsed.data;
}

/**
 * The events must be the owner's, signed, and say what this node will record:
 * the payout list is exactly `payouts` (rebuilt and compared tag for tag, wallet
 * signatures included), and the authorization names this store and is in force.
 */
export function checkOwnerEvents(
  events: OwnerEvents,
  expected: {
    ownerPubkey: string;
    storePubkey: string;
    payouts: StoreConfig['payouts'];
    now: number;
  },
): void {
  for (const [name, event, kind] of [
    ['payout list', events.payoutList, KIND_PAYTO],
    ['store authorization', events.auth, KIND_STORE_AUTH],
  ] as const) {
    if (event.kind !== kind || event.pubkey !== expected.ownerPubkey || !verifyEvent(event)) {
      throw new OwnerRefusal('owner-resign', `the ${name} is not signed by this home's owner`);
    }
  }
  // The authorization first: a revoked store is the more basic refusal.
  const auth = readStoreAuth(events.auth, expected.storePubkey, expected.now);
  if (auth.status === 'revoked') {
    throw new OwnerRefusal('owner-revoked', 'the store authorization revokes this store');
  }
  if (auth.status !== 'active') {
    throw new OwnerRefusal('owner-resign', `the store authorization is ${auth.status}`);
  }
  const rebuilt = buildPaytoEvent({
    ownerPubkey: expected.ownerPubkey,
    accept: expected.payouts,
    createdAt: events.payoutList.created_at,
  });
  if (
    events.payoutList.content !== rebuilt.content ||
    JSON.stringify(events.payoutList.tags) !== JSON.stringify(rebuilt.tags)
  ) {
    throw new OwnerRefusal('owner-resign', 'the signed payout list is not config.json payouts');
  }
}

/**
 * Why the signed payout list may not go out (one rule for an unchanged list, a
 * changed one, and a retry after a publish the ledger never recorded): never
 * older than the recorded list, and as old only with the same payouts; and the
 * relays' newest list is absent, older, or this very event (a retry). Both are
 * owner-side (`OwnerRefusal`). The date's distance from the clock is the host's,
 * checked with the listings' (`setupClockProblems`) after the revocation.
 */
export function payoutListRefusal(
  event: NostrEvent,
  state: LedgerState,
  payouts: string,
  newestOnRelays: NostrEvent | undefined,
): void {
  const recorded = state.payto;
  if (
    recorded !== undefined &&
    (event.created_at < recorded.createdAt ||
      (event.created_at === recorded.createdAt && recorded.payouts !== payouts))
  ) {
    throw new OwnerRefusal(
      'owner-resign',
      'the signed payout list is older than the one recorded: re-sign it in the console',
    );
  }
  if (
    newestOnRelays !== undefined &&
    newestOnRelays.id !== event.id &&
    newestOnRelays.created_at >= event.created_at
  ) {
    throw new OwnerRefusal(
      'owner-resign',
      'the relays serve a newer payout list from the owner: re-sign it in the console',
    );
  }
}

/** The owner's store-authorization history of this store on the relays: signed, verified, by the owner. */
export interface StoreAuthHistory {
  /** AUTH events (kind 30490) at this store's address. */
  auths: NostrEvent[];
  /** Deletions (kind 5) naming that address. */
  deletions: NostrEvent[];
}

/**
 * Read the owner's AUTHs and deletions of this store from `relays`, keeping only
 * what is really the owner's and about this store: a relay may ignore a filter.
 */
export async function readStoreAuthHistory(
  pool: QueryPool,
  relays: readonly string[],
  ownerPubkey: string,
  storePubkey: string,
): Promise<StoreAuthHistory> {
  const address = storeAuthAddress(ownerPubkey, storePubkey);
  // Side by side: a slow relay costs one wait, not two.
  const [auths, deletions] = await Promise.all([
    pool
      .querySync(
        [...relays],
        { kinds: [KIND_STORE_AUTH], authors: [ownerPubkey], '#d': [storePubkey] },
        { maxWait: READ_WAIT_MS },
      )
      .catch(() => []),
    pool
      .querySync(
        [...relays],
        { kinds: [KIND_DELETION], authors: [ownerPubkey], '#a': [address] },
        { maxWait: READ_WAIT_MS },
      )
      .catch(() => []),
  ]);
  // A failed read counts as nothing (as checks.ts reads): a revocation or deletion
  // already on the relays replaces or deletes the older AUTH there anyway.
  const byOwner = (event: NostrEvent) => event.pubkey === ownerPubkey && verifyEvent(event);
  return {
    auths: auths.filter(
      (event) =>
        event.kind === KIND_STORE_AUTH &&
        // The first `d`, as buyers and readStoreAuth read the address.
        event.tags.find((tag) => tag[0] === 'd')?.[1] === storePubkey &&
        byOwner(event),
    ),
    deletions: deletions.filter(
      (event) =>
        event.kind === KIND_DELETION &&
        event.tags.some((tag) => tag[0] === 'a' && tag[1] === address) &&
        byOwner(event),
    ),
  };
}

/**
 * The date of the owner's newest revocation of this store: an AUTH with mode
 * `revoked`, or a deletion naming its address. No future limit, as buyers read
 * it: a revocation can only refuse.
 */
export function revocationDate(history: StoreAuthHistory, storePubkey: string): number | undefined {
  const revoking = [
    ...history.auths.filter((event) => readStoreAuth(event, storePubkey).status === 'revoked'),
    ...history.deletions,
  ];
  return newest(revoking)?.created_at;
}

/**
 * Buyers judge by the owner's newest AUTH (within the skew window): a newer one
 * on the relays that is expired or malformed would replace the signed one there
 * and leave buyers refusing the store, so the console must sign again.
 */
export function supersedingAuthRefusal(
  signedAuth: NostrEvent,
  history: StoreAuthHistory,
  storePubkey: string,
  now: number,
): void {
  const newestAuth = newest(
    history.auths.filter((event) => event.created_at <= now + MAX_FUTURE_SKEW_SECS),
  );
  if (newestAuth === undefined || newestAuth.id === signedAuth.id) {
    return;
  }
  const wins =
    newestAuth.created_at > signedAuth.created_at ||
    (newestAuth.created_at === signedAuth.created_at && newestAuth.id < signedAuth.id);
  const status = readStoreAuth(newestAuth, storePubkey, now).status;
  if (wins && (status === 'expired' || status === 'malformed')) {
    throw new OwnerRefusal(
      'owner-resign',
      `the relays serve a newer store authorization that is ${status}: re-sign it in the console`,
    );
  }
}

/** A revocation not older than the authorization revokes it (a tie revokes, as buyers judge). */
export function revocationRefusal(auth: NostrEvent, revokedAt: number | undefined): void {
  if (revokedAt !== undefined && revokedAt >= auth.created_at) {
    throw new OwnerRefusal(
      'owner-revoked',
      'the owner revoked this store after the signed authorization: re-authorize it in the console',
    );
  }
}

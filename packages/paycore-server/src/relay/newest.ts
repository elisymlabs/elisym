/**
 * The owner's newest payout list (kind 10133) or store authorization (kind
 * 30490) the public offer relays serve: what the admin API dates a new owner
 * event against and what import takes over. One read through a short-lived
 * unauthenticated pool, destroyed after it; bounded by a timeout. Only events
 * by the owner, of the kind (and for 30490 of the store's address `d`), with
 * a valid id and signature count; the newest wins, and of two in the same
 * second the lowest id (NIP-01 replaceable rules, as the checkout picks).
 */
import { KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import { type QueryPool, newest } from '@merchant-node/checks';
import { OFFER_RELAYS } from '@merchant-node/constants';
import { listeningPool } from '@merchant-node/relay-pool';
import type { NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import type { OwnerEventKind } from '../owner-events';

/** How long one read of the offer relays may take before it counts as not read. */
export const NEWEST_READ_TIMEOUT_MS = 5_000;

/** A pool for one read, destroyed after it. */
export type NewestReadPool = QueryPool & { destroy: () => void };

export interface NewestReadOptions {
  /** The 30490's address (`d` = the store pubkey); required for kind 30490, ignored for 10133. */
  d?: string;
  /** Default: merchant-node's `OFFER_RELAYS` (the checkout's default relays). */
  relays?: readonly string[];
  /** Default: a fresh nostr-tools pool. */
  makePool?: () => NewestReadPool;
  timeoutMs?: number;
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/**
 * Whether the id is the event's hash and the signature the author's. Checked
 * on a plain copy: nostr-tools caches a verdict on the object it was given,
 * and a relay's event must not carry one in.
 */
function validSignature(event: NostrEvent): boolean {
  return verifyEvent({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  });
}

function timeout(ms: number): { promise: Promise<NostrEvent[]>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<NostrEvent[]>((resolve) => {
    timer = setTimeout(() => resolve([]), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * O's newest event of `kind` on the offer relays, or undefined when none is
 * served (or none could be read in time).
 */
export async function newestOnRelays(
  owner: string,
  kind: OwnerEventKind,
  options: NewestReadOptions = {},
): Promise<NostrEvent | undefined> {
  const d = kind === KIND_STORE_AUTH ? options.d : undefined;
  if (kind === KIND_STORE_AUTH && d === undefined) {
    throw new Error('the newest store authorization is read for one store: `d` is required');
  }
  const timeoutMs = options.timeoutMs ?? NEWEST_READ_TIMEOUT_MS;
  const pool = (options.makePool ?? listeningPool)();
  const deadline = timeout(timeoutMs);
  let events: NostrEvent[];
  try {
    events = await Promise.race([
      pool
        .querySync(
          [...(options.relays ?? OFFER_RELAYS)],
          { kinds: [kind], authors: [owner], ...(d === undefined ? {} : { '#d': [d] }) },
          { maxWait: timeoutMs },
        )
        .catch(() => []),
      deadline.promise,
    ]);
  } finally {
    deadline.cancel();
    pool.destroy();
  }
  return newest(
    events.filter(
      (event) =>
        event.pubkey === owner &&
        event.kind === kind &&
        (d === undefined || tagValue(event, 'd') === d) &&
        validSignature(event),
    ),
  );
}

export interface NewestDateDeps {
  /** O's hosted store, if any: a 30490 is read at its address. */
  store: (owner: string) => Promise<{ storePubkey: string } | undefined>;
  makePool?: () => NewestReadPool;
  relays?: readonly string[];
}

/**
 * `created_at` of O's newest owner event of `kind` on the offer relays: the
 * payout list (10133) is O's alone, a store authorization (30490) is read at
 * O's store's address, and none is known for an owner with no store.
 */
export async function newestOwnerEventDate(
  owner: string,
  kind: OwnerEventKind,
  deps: NewestDateDeps,
): Promise<number | undefined> {
  const read = {
    ...(deps.makePool === undefined ? {} : { makePool: deps.makePool }),
    ...(deps.relays === undefined ? {} : { relays: deps.relays }),
  };
  if (kind === KIND_PAYTO) {
    return (await newestOnRelays(owner, kind, read))?.created_at;
  }
  const store = await deps.store(owner);
  if (store === undefined) {
    return undefined;
  }
  return (await newestOnRelays(owner, kind, { ...read, d: store.storePubkey }))?.created_at;
}

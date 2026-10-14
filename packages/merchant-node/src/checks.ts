import {
  KIND_GIFT_WRAP,
  KIND_INBOX_RELAYS,
  KIND_PAYTO,
  KIND_PRODUCT,
  KIND_STORE_PROFILE,
  LIMITS,
  buildOrderMessage,
  isPurchasable,
  parseCaip19,
  parsePayto,
  parseProduct,
  parseStoreProfile,
  priceInSubunits,
  wrapOrderMessage,
} from '@elisym/commerce';
import type { Network } from '@elisym/pay-core';
import type { Filter, NostrEvent } from 'nostr-tools';
import {
  type EventTemplate,
  type VerifiedEvent,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';
import { readListingChunks } from './listing-reads';
import { type AuthSigner, type PublishPool, publishToRelays } from './publish';
import { checkoutRelaySpelling } from './relays';
import type { OfferTerms } from './terms';

/** How long a check waits for a relay to answer a read. */
const READ_WAIT_MS = 10_000;

/** The part of nostr-tools' `SimplePool` the checks read with. */
export interface QueryPool {
  querySync(
    relays: string[],
    filter: Filter,
    params: { maxWait?: number; onauth?: (template: EventTemplate) => Promise<VerifiedEvent> },
  ): Promise<NostrEvent[]>;
}

export interface RelayVerdict {
  relay: string;
  /** Took a gift wrap for a key it never saw. */
  accepts: boolean;
  /** Served it back to that key. */
  serves: boolean;
}

/**
 * Whether each inbox relay does what the store needs from it: take a gift
 * wrap addressed to any key (the store replies to one-time buyer keys, which
 * have no inbox of their own) and serve it back to that key. A probe wrap to a
 * fresh key is written with the store's auth and read back with the key's, on
 * its own connections (`reader`): a connection authenticates once, and one
 * that did as the store would be served what the store may read.
 */
export async function checkInboxRelays(
  writer: PublishPool,
  reader: QueryPool,
  relays: readonly string[],
  storeSecretKey: Uint8Array,
  storeAuth: AuthSigner,
  log: (message: string) => void,
  now: number,
): Promise<RelayVerdict[]> {
  const recipientSecretKey = generateSecretKey();
  const recipient = getPublicKey(recipientSecretKey);
  const probe = wrapOrderMessage(
    buildOrderMessage(
      {
        type: 'status',
        buyerPubkey: recipient,
        orderId: `probe-${now.toString(36)}`,
        status: 'pending',
      },
      now,
    ),
    storeSecretKey,
    recipient,
  ).recipientWrap;
  const recipientAuth = async (template: EventTemplate) =>
    finalizeEvent(template, recipientSecretKey);
  return await Promise.all(
    relays.map(async (relay) => {
      const accepted = await publishToRelays(writer, [relay], probe, storeAuth, log);
      if (accepted.length === 0) {
        return { relay, accepts: false, serves: false };
      }
      const found = await reader
        .querySync(
          [relay],
          { kinds: [KIND_GIFT_WRAP], '#p': [recipient], ids: [probe.id] },
          { maxWait: READ_WAIT_MS, onauth: recipientAuth },
        )
        .catch(() => []);
      return { relay, accepts: true, serves: found.some((event) => event.id === probe.id) };
    }),
  );
}

export interface DomainVerdict {
  url: string;
  ok: boolean;
  problem?: string;
}

/**
 * Whether `domain` serves `expected` (the store's nostr.json) where commerce
 * reads it, with the CORS header a browser needs to read it from another site.
 */
export async function checkDomain(
  domain: string,
  expected: { names: Record<string, string> },
  fetcher: typeof fetch = fetch,
): Promise<DomainVerdict> {
  const url = `https://${domain}/.well-known/nostr.json?name=_`;
  let response: Response;
  try {
    response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(READ_WAIT_MS) });
  } catch (error) {
    return { url, ok: false, problem: `not reachable (${errorText(error)})` };
  }
  if (!response.ok) {
    return { url, ok: false, problem: `answered ${response.status}` };
  }
  if (response.headers.get('access-control-allow-origin') !== '*') {
    return { url, ok: false, problem: 'no "Access-Control-Allow-Origin: *" header' };
  }
  let served: unknown;
  try {
    const text = await response.text();
    if (text.length > LIMITS.MAX_NIP05_DOCUMENT_BYTES) {
      return { url, ok: false, problem: 'the document is too large' };
    }
    served = JSON.parse(text);
  } catch {
    return { url, ok: false, problem: 'not JSON' };
  }
  const names =
    typeof served === 'object' && served !== null && 'names' in served
      ? (served.names as Record<string, unknown>)
      : undefined;
  for (const [name, pubkey] of Object.entries(expected.names)) {
    if (names?.[name] !== pubkey) {
      return { url, ok: false, problem: `"${name}" is not ${pubkey}` };
    }
  }
  return { url, ok: true };
}

/**
 * What buyers are offered that this node does not honour, read from the relays'
 * newest listing of each product (kind 30402) and owner payout list (kind
 * 10133): a payout on another rail or network, an address its ledger does not
 * stand behind, or a coin a listing on sale prices at an amount the ledger
 * does not record for that product (a listing published by a setup that stopped
 * before writing the ledger, or one still on sale after its terms retired). A
 * buyer could pay one and never get it completed. A sold-out listing offers
 * nothing; the payout list is judged only where something is on sale, so a
 * store whose products are all stopped still starts. `undefined` when no relay
 * served a listing or the payout list.
 */
export function offersNotHonoured(
  listings: readonly NostrEvent[],
  payoutList: NostrEvent | undefined,
  network: Network,
  standing: readonly OfferTerms[],
  /** The registry network of the node's Tempo block, when it has one. */
  tempoNetwork?: Network,
): string[] | undefined {
  if (listings.length === 0 && payoutList === undefined) {
    return undefined;
  }
  const onSale = listings.flatMap((listing) => {
    const product = parseProduct(listing);
    return product !== undefined && isPurchasable(product) ? [product] : [];
  });
  const targets = payoutList === undefined ? [] : parsePayto(payoutList).targets;
  const found = (onSale.length === 0 ? [] : targets)
    .filter(
      (target) =>
        (target.caip19.chain.family === 'solana'
          ? target.caip19.chain.network !== network
          : target.caip19.chain.family !== 'evm' ||
            tempoNetwork === undefined ||
            target.caip19.chain.network !== tempoNetwork) ||
        !standing.some(
          (terms) => terms.caip19 === target.caip19.id && terms.payout === target.address,
        ),
    )
    .map((target) => `${target.caip19.id} ${target.address}`);
  for (const product of onSale) {
    for (const id of product.accept) {
      const caip19 = parseCaip19(id);
      const target = targets.find((candidate) => candidate.caip19.id === caip19?.id);
      // A coin with no payout, or one the widget cannot price, is not payable at all.
      if (caip19 === undefined || target === undefined) {
        continue;
      }
      let amount: string;
      try {
        amount = priceInSubunits(product.price, caip19.asset).toString();
      } catch {
        continue;
      }
      const honoured = standing.some(
        (terms) =>
          terms.d === product.d &&
          terms.caip19 === caip19.id &&
          terms.payout === target.address &&
          terms.amount === amount,
      );
      if (!honoured) {
        found.push(`${product.d}: ${caip19.id} at ${amount}`);
      }
    }
  }
  return [...new Set(found)];
}

/** How many relays of an inbox list the checkout uses (its `STORE_RELAY_CAP`). */
const CHECKOUT_INBOX_CAP = 8;

/**
 * The relays the store's published inbox list (kind 10050) sends buyers' orders
 * to that this node does not read (`read`: its configured inbox relays) - an
 * order sent there is never taken. `undefined` when no relay served a list.
 */
export function inboxRelaysNotRead(
  inboxList: NostrEvent | undefined,
  read: readonly string[],
): string[] | undefined {
  if (inboxList === undefined) {
    return undefined;
  }
  const reading = read.map(checkoutRelaySpelling);
  const listed: string[] = [];
  for (const tag of inboxList.tags) {
    const relay = tag[0] === 'relay' ? checkoutRelaySpelling(tag[1]) : undefined;
    if (relay !== undefined && !listed.includes(relay)) {
      listed.push(relay);
    }
  }
  return listed.slice(0, CHECKOUT_INBOX_CAP).filter((relay) => !reading.includes(relay));
}

/** What one set of relays serves: the newest listing of each product, payout list, inbox list and store profile. */
export interface RelayView {
  listings: NostrEvent[];
  payoutList: NostrEvent | undefined;
  inboxList: NostrEvent | undefined;
  /** The store's newest profile (kind 0): buyers read its fee declaration. */
  profile?: NostrEvent | undefined;
}

/**
 * Whether the relays serve a store profile, and whether every one served
 * declares protocol-fee support: a buyer reading a view without it refuses
 * this store while the fee is above 0.
 */
export function profileFeeSupport(views: readonly RelayView[]): {
  found: boolean;
  feeSupport: boolean;
} {
  const served = views.flatMap((view) => (view.profile === undefined ? [] : [view.profile]));
  return {
    found: served.length > 0,
    feeSupport: served.every((profile) => parseStoreProfile(profile)?.feeSupport === true),
  };
}

/** The store's newest profile (kind 0) the relays serve. */
export async function newestStoreProfile(
  pool: QueryPool,
  relays: readonly string[],
  storePubkey: string,
): Promise<NostrEvent | undefined> {
  const events = await pool
    .querySync(
      [...relays],
      { kinds: [KIND_STORE_PROFILE], authors: [storePubkey] },
      { maxWait: READ_WAIT_MS },
    )
    .catch(() => []);
  return newest(
    events.filter((event) => event.pubkey === storePubkey && event.kind === KIND_STORE_PROFILE),
  );
}

/**
 * Everything the relays offer buyers that this node does not honour, across
 * views (each set of relays a page may read: the defaults every page reads, and
 * with the store's own relays): terms it does not honour, and inbox relays it does not
 * read. `served` is false when no view served a listing or payout list at all.
 */
export function offerProblems(
  views: readonly RelayView[],
  inboxRelays: readonly string[],
  network: Network,
  standing: readonly OfferTerms[],
  tempoNetwork?: Network,
): { problems: string[]; served: boolean } {
  const problems = new Set<string>();
  let served = false;
  for (const view of views) {
    for (const relay of inboxRelaysNotRead(view.inboxList, inboxRelays) ?? []) {
      problems.add(`orders sent to ${relay}, which this node does not read`);
    }
    const notHonoured = offersNotHonoured(
      view.listings,
      view.payoutList,
      network,
      standing,
      tempoNetwork,
    );
    served ||= notHonoured !== undefined;
    for (const offer of notHonoured ?? []) {
      problems.add(offer);
    }
  }
  return { problems: [...problems], served };
}

/** The store's newest inbox list (kind 10050) the relays serve. */
export async function newestInboxList(
  pool: QueryPool,
  relays: readonly string[],
  storePubkey: string,
): Promise<NostrEvent | undefined> {
  const events = await pool
    .querySync(
      [...relays],
      { kinds: [KIND_INBOX_RELAYS], authors: [storePubkey] },
      { maxWait: READ_WAIT_MS },
    )
    .catch(() => []);
  return newest(
    events.filter((event) => event.pubkey === storePubkey && event.kind === KIND_INBOX_RELAYS),
  );
}

/**
 * The store's newest listing of each product in `ds` the relays serve (the
 * newest wins, then the lowest id), keyed by `d`: chunked `'#d'` reads, a few
 * subscriptions per relay at a time (see `readListingChunks`).
 */
export async function newestListings(
  pool: QueryPool,
  relays: readonly string[],
  storePubkey: string,
  ds: readonly string[],
): Promise<Map<string, NostrEvent>> {
  const wanted = new Set(ds);
  const events = await readListingChunks(ds, (chunk) =>
    pool
      .querySync(
        [...relays],
        { kinds: [KIND_PRODUCT], authors: [storePubkey], '#d': chunk },
        { maxWait: READ_WAIT_MS },
      )
      .catch(() => []),
  );
  const byD = new Map<string, NostrEvent[]>();
  for (const event of events) {
    const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
    if (
      event.pubkey === storePubkey &&
      event.kind === KIND_PRODUCT &&
      d !== undefined &&
      wanted.has(d)
    ) {
      byD.set(d, [...(byD.get(d) ?? []), event]);
    }
  }
  const found = new Map<string, NostrEvent>();
  for (const [d, candidates] of byD) {
    const best = newest(candidates);
    if (best !== undefined) {
      found.set(d, best);
    }
  }
  return found;
}

/** The newest event, and of two in the same second the lowest id (NIP-01), as the checkout picks. */
export function newest(events: readonly NostrEvent[]): NostrEvent | undefined {
  return events.reduce<NostrEvent | undefined>(
    (best, event) =>
      best === undefined ||
      event.created_at > best.created_at ||
      (event.created_at === best.created_at && event.id < best.id)
        ? event
        : best,
    undefined,
  );
}

/** The owner's newest payout list (kind 10133) the relays serve, as the widget picks it. */
export async function newestPayoutList(
  pool: QueryPool,
  relays: readonly string[],
  ownerPubkey: string,
): Promise<NostrEvent | undefined> {
  const events = await pool
    .querySync(
      [...relays],
      { kinds: [KIND_PAYTO], authors: [ownerPubkey] },
      { maxWait: READ_WAIT_MS },
    )
    .catch(() => []);
  return newest(
    events.filter((event) => event.pubkey === ownerPubkey && event.kind === KIND_PAYTO),
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read each set of relays a page may read, one view after the other, and in
 * each the listings, then the payout list, the inbox list and the store
 * profile: never two
 * reads at once beside the listing chunks, so no relay carries more than
 * `MAX_SUBSCRIPTIONS_PER_RELAY` of our subscriptions.
 */
export async function readRelayViews(
  pool: QueryPool,
  views: readonly (readonly string[])[],
  pubkeys: { storePubkey: string; ownerPubkey: string },
  ds: readonly string[],
): Promise<RelayView[]> {
  const read: RelayView[] = [];
  for (const relays of views) {
    const listings = await newestListings(pool, relays, pubkeys.storePubkey, ds);
    const payoutList = await newestPayoutList(pool, relays, pubkeys.ownerPubkey);
    const inboxList = await newestInboxList(pool, relays, pubkeys.storePubkey);
    const profile = await newestStoreProfile(pool, relays, pubkeys.storePubkey);
    read.push({ listings: [...listings.values()], payoutList, inboxList, profile });
  }
  return read;
}

/**
 * What setup reads before it publishes: the owner's newest payout list from
 * `relays`, then the newest listing of each of `ds` from the default relays -
 * one after the other, never side by side.
 */
export async function readBeforeSetup(
  pool: QueryPool,
  relays: readonly string[],
  defaultRelays: readonly string[],
  pubkeys: { storePubkey: string; ownerPubkey: string },
  ds: readonly string[],
): Promise<{ payoutList: NostrEvent | undefined; listings: Map<string, NostrEvent> }> {
  const payoutList = await newestPayoutList(pool, relays, pubkeys.ownerPubkey);
  const listings = await newestListings(pool, defaultRelays, pubkeys.storePubkey, ds);
  return { payoutList, listings };
}

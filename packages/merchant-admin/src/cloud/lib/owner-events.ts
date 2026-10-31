/**
 * The owner's own events, read in the page straight from `DEFAULT_RELAYS`
 * (never through cloud-api), and the date rules for signing new ones (plan
 * section 3). Owner events are dated by the local clock, never the server's:
 * a far-future server `Date` must not collect events that become valid later.
 * So signing is refused while the two clocks are more than 2 minutes apart,
 * and the newest list or revocation on the relays decides whether a new one
 * can be signed now, must wait, or cannot outrank it for a while.
 */
import {
  KIND_DELETION,
  KIND_PAYTO,
  KIND_STORE_AUTH,
  MAX_FUTURE_SKEW_SECS,
  readStoreAuth,
  storeAuthAddress,
} from '@elisym/commerce';
import { type NostrEvent, verifyEvent } from 'nostr-tools/pure';
import type { RelayQuery } from './key-in-use';

/** Signing is refused while the local clock and the server's `Date` differ by more than this. */
export const CLOCK_SKEW_SECS = 120;
/** A list dated further ahead than this is not shown as the current payouts (buyers skip it). */
export const SHOWN_AHEAD_SECS = MAX_FUTURE_SKEW_SECS;
/** The node's own bound on how far ahead an owner event may be: a newer one cannot be signed past it. */
export const SIGN_AHEAD_SECS = MAX_FUTURE_SKEW_SECS - 60;

/** The newest event, and of two in the same second the lowest id (NIP-01), as the node and buyers pick. */
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

/** What the relays hold of the owner, each verified against the owner's pubkey. */
export interface OwnerEventsRead {
  /** Every valid payout list of the owner (kind 10133). */
  payoutLists: NostrEvent[];
  /** Every revocation of this store's AUTH: a 30490 in `mode: revoked`, or a kind 5 naming its address. */
  revocations: NostrEvent[];
  /** Every AUTH of this store that is no revocation (a later one supersedes an older revocation). */
  auths: NostrEvent[];
}

/** Reads the owner's payout lists, and the AUTHs and revocations of this store's AUTH. */
export async function readOwnerEvents(
  query: RelayQuery,
  ownerPubkey: string,
  storePubkey: string,
): Promise<OwnerEventsRead> {
  const address = storeAuthAddress(ownerPubkey, storePubkey);
  // Side by side, as the node reads them: each waits up to the relay query's own bound.
  const [lists, auths, deletions] = await Promise.all([
    query({ kinds: [KIND_PAYTO], authors: [ownerPubkey] }),
    query({ kinds: [KIND_STORE_AUTH], authors: [ownerPubkey], '#d': [storePubkey] }),
    query({ kinds: [KIND_DELETION], authors: [ownerPubkey], '#a': [address] }),
  ]);
  const byOwner = (event: NostrEvent, kind: number) =>
    event.pubkey === ownerPubkey && event.kind === kind && verifyEvent(event);
  const storeAuths = auths.filter((event) => byOwner(event, KIND_STORE_AUTH));
  const status = (event: NostrEvent) => readStoreAuth(event, storePubkey).status;
  return {
    payoutLists: lists.filter((event) => byOwner(event, KIND_PAYTO)),
    revocations: [
      ...storeAuths.filter((event) => status(event) === 'revoked'),
      ...deletions.filter(
        (event) =>
          byOwner(event, KIND_DELETION) &&
          event.tags.some((tag) => tag[0] === 'a' && tag[1] === address),
      ),
    ],
    // Every other AUTH whose address is this store's, malformed or expired as it may be: buyers
    // and the node take the newest of them (by its first `d`) whatever it says.
    auths: storeAuths.filter(
      (event) =>
        event.tags.find((tag) => tag[0] === 'd')?.[1] === storePubkey &&
        status(event) !== 'revoked',
    ),
  };
}

/** The payout list the console shows as current: the newest not more than 15 min ahead of the local clock. */
export function currentPayoutList(read: OwnerEventsRead, localNow: number): NostrEvent | undefined {
  return newest(
    read.payoutLists.filter((event) => event.created_at <= localNow + SHOWN_AHEAD_SECS),
  );
}

/**
 * The owner's revocation in force, as buyers and the node judge it: the newest
 * revocation when it is not older than the newest AUTH buyers would take (one
 * not more than 15 min ahead), or when there is no AUTH at all.
 */
export function revocationInForce(read: OwnerEventsRead, localNow: number): NostrEvent | undefined {
  const revocation = newest(read.revocations);
  const auth = newest(
    read.auths.filter((event) => event.created_at <= localNow + SHOWN_AHEAD_SECS),
  );
  return revocation !== undefined &&
    (auth === undefined || revocation.created_at >= auth.created_at)
    ? revocation
    : undefined;
}

/** Whether new owner events can be signed now, and if not, why and until when. */
export type SigningDecision =
  | { kind: 'sign'; createdAt: number }
  /** No answer of cloud-api has told its time yet: the clocks cannot be compared. */
  | { kind: 'server-time-unknown' }
  | { kind: 'fix-clock'; skewSecs: number }
  /** An event of the owner is dated at or after now: a new one must be dated after it. */
  | { kind: 'wait'; what: 'payout list' | 'revocation'; until: number }
  /** An event of the owner is dated more than 14 min ahead: nothing signed now outranks it before then. */
  | { kind: 'ahead'; what: 'payout list' | 'revocation'; date: number }
  /** The owner revoked this store (no later AUTH): it is authorized again only on the owner's choice. */
  | { kind: 'revoked'; date: number };

/**
 * The decision for signing the AUTH and the payout list at the local clock.
 * A revocation in force is named first; then the newest list and revocation
 * are taken with no future filter (as the node takes them). `reauthorize` is
 * the owner's explicit choice to authorize a revoked store again.
 */
export function signingDecision(input: {
  localNow: number;
  serverNow: number | undefined;
  read: OwnerEventsRead;
  reauthorize: boolean;
}): SigningDecision {
  const { localNow, read } = input;
  if (input.serverNow === undefined) {
    return { kind: 'server-time-unknown' };
  }
  if (Math.abs(localNow - input.serverNow) > CLOCK_SKEW_SECS) {
    return { kind: 'fix-clock', skewSecs: localNow - input.serverNow };
  }
  const inForce = revocationInForce(read, localNow);
  if (inForce !== undefined && !input.reauthorize) {
    return { kind: 'revoked', date: inForce.created_at };
  }
  for (const [what, event] of [
    ['revocation', newest(read.revocations)],
    ['payout list', newest(read.payoutLists)],
  ] as const) {
    if (event === undefined) {
      continue;
    }
    if (event.created_at > localNow + SIGN_AHEAD_SECS) {
      return { kind: 'ahead', what, date: event.created_at };
    }
    if (event.created_at >= localNow) {
      return { kind: 'wait', what, until: event.created_at + 1 };
    }
  }
  return { kind: 'sign', createdAt: localNow };
}

/** What the merchant reads for a decision that is not to sign now (dates in UTC, as the console shows them). */
export function decisionText(decision: SigningDecision): string | undefined {
  const at = (seconds: number) =>
    `${new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  switch (decision.kind) {
    case 'sign':
      return undefined;
    case 'server-time-unknown':
      return "The console could not read the cloud's time yet: try again in a moment.";
    case 'fix-clock':
      return `Your device clock is ${Math.abs(decision.skewSecs)} seconds off: set it right, then sign.`;
    case 'wait':
      return `A ${decision.what} of yours is dated ${at(decision.until - 1)}: you can sign from ${at(decision.until)}.`;
    case 'ahead':
      return `A ${decision.what} of yours dated ${at(decision.date)} is on the relays and outranks anything signed before then.`;
    case 'revoked':
      return `You revoked this store on ${at(decision.date)}. Re-authorize it to sign, or withdraw it.`;
  }
}

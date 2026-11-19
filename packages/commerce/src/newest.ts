import type { NostrEvent } from 'nostr-tools';
import { KIND_DELETION, MAX_FUTURE_SKEW_SECS } from './constants';
import { expirationState, tagValue, tagValues } from './tags';
import { isEventShaped, isGenuineEvent } from './verify';

/** The newest event of `kind` by `author` (and `d`, when given) that is genuinely signed. */
export function newestSigned(
  events: readonly NostrEvent[],
  kind: number,
  author: string,
  now: number,
  d?: string,
): NostrEvent | undefined {
  let newest: NostrEvent | undefined;
  for (const event of events) {
    if (
      !isEventShaped(event) ||
      event.kind !== kind ||
      event.pubkey !== author ||
      event.created_at > now + MAX_FUTURE_SKEW_SECS ||
      (d !== undefined && tagValue(event.tags, 'd') !== d)
    ) {
      continue;
    }
    // Ties on created_at go to the lowest id (NIP-01), so every reader picks the same one.
    if (
      newest &&
      (event.created_at < newest.created_at ||
        (event.created_at === newest.created_at && event.id >= newest.id))
    ) {
      continue;
    }
    if (isGenuineEvent(event)) {
      newest = event;
    }
  }
  return newest;
}

/**
 * For evidence that can only refuse (revocations, deletions): no future-date
 * window, so a signer's fast clock cannot delay it.
 */
export const NO_FUTURE_LIMIT = Number.POSITIVE_INFINITY;

/** The newest genuine NIP-09 deletion by `author` that names the addressable `address`. */
export function newestDeletion(
  events: readonly NostrEvent[],
  address: string,
  author: string,
  now: number,
): NostrEvent | undefined {
  return newestSigned(
    events.filter((event) => isEventShaped(event) && tagValues(event.tags, 'a').includes(address)),
    KIND_DELETION,
    author,
    now,
  );
}

/** NIP-40: past its `expiration`, or with one that cannot be read. */
export function isLapsed(event: NostrEvent, now: number): boolean {
  const state = expirationState(event.tags, now);
  return state === 'expired' || state === 'malformed';
}

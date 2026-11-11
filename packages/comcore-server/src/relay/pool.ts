import { EXPIRATION_ADMISSION_SLACK_SECS, LIMITS, SESSION_TTL_SECS } from '@elisym/comcore';
import type { NostrEvent, VerifiedEvent } from 'nostr-tools';
import { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { verifyEvent } from 'nostr-tools/pure';
import WebSocket from 'ws';
import { CONNECTION_TIMEOUT_MS, WRAP_AHEAD_SECS } from '../constants';

const KIND_GIFT_WRAP = 1059;

/**
 * The 2.4 wrap pre-check, run before any signature check: a wrap must carry an
 * `expiration` in (now, now + 24 h + 10 min], a `created_at` no more than 2
 * minutes ahead (ours are only backdated), content within the 4.1 bound, and
 * exactly one `p` naming an assistant key this worker leases.
 */
export function passesWrapPreCheck(
  event: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
  isLeasedAssistant: (pubkey: string) => boolean,
  now: number,
): boolean {
  if (event.kind !== KIND_GIFT_WRAP) {
    return true;
  }
  if (typeof event.content !== 'string' || event.content.length > LIMITS.WRAP_CONTENT_MAX_CHARS) {
    return false;
  }
  if (event.created_at > now + WRAP_AHEAD_SECS) {
    return false;
  }
  const expirations = event.tags.filter((tag) => tag[0] === 'expiration');
  const expiration = expirations.length === 1 ? expirations[0]?.[1] : undefined;
  if (expiration === undefined || !/^\d{1,12}$/.test(expiration)) {
    return false;
  }
  const expiresAt = Number(expiration);
  if (expiresAt <= now || expiresAt > now + SESSION_TTL_SECS + EXPIRATION_ADMISSION_SLACK_SECS) {
    return false;
  }
  const recipients = event.tags.filter((tag) => tag[0] === 'p');
  const recipient = recipients.length === 1 ? recipients[0]?.[1] : undefined;
  return recipient !== undefined && isLeasedAssistant(recipient);
}

/**
 * The server's one pool (2.4), following merchant-node's `listeningPool`: `ws`
 * sockets with real WebSocket pings, so a half-open socket closes and is
 * resubscribed instead of going silently deaf. The `ws` socket goes in as this
 * pool's own implementation, so nothing changes process-wide. Its
 * `verifyEvent` runs the wrap pre-check first, so junk wraps cost no signature
 * check.
 */
export function createServerPool(
  isLeasedAssistant: (pubkey: string) => boolean,
  now: () => number = () => Math.floor(Date.now() / 1000),
): AbstractSimplePool {
  return new AbstractSimplePool({
    enablePing: true,
    maxWaitForConnection: CONNECTION_TIMEOUT_MS,
    // `ws` implements the WebSocket API nostr-tools uses (plus `ping`/`once`); its types are its own.
    websocketImplementation: WebSocket as unknown as typeof globalThis.WebSocket,
    verifyEvent: (event): event is VerifiedEvent =>
      passesWrapPreCheck(event, isLeasedAssistant, now()) && verifyEvent(event),
  });
}

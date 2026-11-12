import { HEX_PUBKEY_RE, isGenuineEvent, nowSecs, tagsNamed } from '@elisym/commerce';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { KIND_SESSION_TICKET, TICKET_TTL_SECS } from './constants';

export interface TicketInput {
  visitor: string;
  store: string;
  /** The gateway's clock; the widget derives its corrected clock from the ticket's `created_at`. */
  now?: number;
}

/** A gateway session ticket (3): signed by G, never published. */
export function buildTicket(input: TicketInput): EventTemplate {
  if (!HEX_PUBKEY_RE.test(input.visitor) || !HEX_PUBKEY_RE.test(input.store)) {
    throw new Error('visitor and store must be 64 lowercase hex characters');
  }
  const now = input.now ?? nowSecs();
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  return {
    kind: KIND_SESSION_TICKET,
    created_at: now,
    tags: [
      ['p', input.visitor],
      ['store', input.store],
      ['expiration', String(now + TICKET_TTL_SECS)],
      ['nonce', Array.from(nonce, (byte) => byte.toString(16).padStart(2, '0')).join('')],
    ],
    content: '',
  };
}

export type TicketCheck = 'valid' | 'expired' | 'invalid';

function single(event: NostrEvent, name: string): string | undefined {
  const matches = tagsNamed(event.tags, name);
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

/**
 * Check a ticket carried inside an ask (5.8 drop order): signed by one of the
 * known gateway keys, for this store, issued to the seal's author. `expired`
 * is reported separately and only for an otherwise valid ticket, so the
 * assistant can answer `unavailable: expired` and the widget renews.
 */
export function checkTicket(
  ticket: NostrEvent,
  options: {
    gatewayKeys: readonly string[];
    store: string;
    sender: string;
    now?: number;
  },
): TicketCheck {
  if (
    ticket.kind !== KIND_SESSION_TICKET ||
    !options.gatewayKeys.includes(ticket.pubkey) ||
    !isGenuineEvent(ticket)
  ) {
    return 'invalid';
  }
  const visitor = single(ticket, 'p');
  const store = single(ticket, 'store');
  const expiration = single(ticket, 'expiration');
  if (
    visitor !== options.sender ||
    store !== options.store ||
    expiration === undefined ||
    !/^\d{1,12}$/.test(expiration)
  ) {
    return 'invalid';
  }
  return Number(expiration) <= (options.now ?? nowSecs()) ? 'expired' : 'valid';
}

/** The widget's clock offset from a fresh ticket: add it to local time to write gateway time. */
export function clockOffsetFromTicket(
  ticket: Pick<NostrEvent, 'created_at'>,
  localNow: number,
): number {
  return ticket.created_at - localNow;
}

/**
 * Relays the widget always queries for the offer and the store's inbox list,
 * outside the cap on store-named relays: the store's own relays hold neither the
 * owner's payout list nor its authorization, and the store key must not choose
 * where those reads go.
 */
export const DEFAULT_RELAYS: readonly string[] = [
  'wss://relay.elisym.network',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

/** At most this many relays named by the store (its inbox list, naddr hints). */
export const STORE_RELAY_CAP = 8;

/** A relay URL longer than this is not one. */
export const MAX_RELAY_URL_LENGTH = 256;

/** An offer snapshot older than this is verified again before ordering or paying. */
export const OFFER_SNAPSHOT_MAX_AGE_SECS = 120;

/** Store inbox relays that must acknowledge the order before the wallet opens. */
export const ORDER_ACK_TARGET = 2;

/** How long one relay query waits before it answers with what it has. */
export const RELAY_QUERY_MAX_WAIT_MS = 4000;

/** The most one relay's query may take in all, AUTH and a re-subscription included. */
export const RELAY_QUERY_DEADLINE_MS = 15_000;

/** How long a publish waits to connect to one relay. */
export const RELAY_CONNECT_MAX_WAIT_MS = 6000;

/**
 * The most one relay's publish may take in all: connect, OK, AUTH and a retry.
 * The OK itself is bounded by the relay library's own publish timeout.
 */
export const RELAY_PUBLISH_DEADLINE_MS = 20_000;

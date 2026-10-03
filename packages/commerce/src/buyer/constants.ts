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

/**
 * How long a query that asks (`QueryOptions.skipUnreachable`, the load that opens
 * a page) passes by a relay this client could not connect to: a dead relay then
 * costs one connection wait for that load, not one per read.
 */
export const UNREACHABLE_RELAY_SKIP_MS = 15_000;

/**
 * A failed connection counts toward the skip only when it took about as long as
 * a query's connection wait: the pool waits `max(maxWait * 0.8, maxWait - 1000)`,
 * never under 3 s, so 3.2 s for `RELAY_QUERY_MAX_WAIT_MS`. A fast refusal (a 503,
 * a reset) costs nothing to retry.
 */
export const SLOW_CONNECT_FAILURE_MS = 2000;

/** A failure that took longer is a page or process that was frozen (the buyer in the wallet app), not a dead relay. */
export const SLOW_CONNECT_FAILURE_MAX_MS = 4500;

/** The most one relay's query may take in all, AUTH and a re-subscription included. */
export const RELAY_QUERY_DEADLINE_MS = 15_000;

/** How long a publish waits to connect to one relay. */
export const RELAY_CONNECT_MAX_WAIT_MS = 6000;

/**
 * The most one relay's publish may take in all: connect, OK, AUTH and a retry.
 * The OK itself is bounded by the relay library's own publish timeout.
 */
export const RELAY_PUBLISH_DEADLINE_MS = 20_000;

/** Pauses before a closed long-lived subscription is opened again, growing to the last. */
export const SUBSCRIBE_RETRY_MAX_MS = 60_000;
export const SUBSCRIBE_RETRY_MS: readonly number[] = [1_000, 5_000, 15_000, SUBSCRIBE_RETRY_MAX_MS];

/**
 * How long a subscription must stay open past its EOSE before a close starts the
 * pauses over: a relay that drops right after EOSE is not retried every second.
 */
export const SUBSCRIBE_STABLE_MS = 30_000;

/** Tries of an order-record write that lost a race with another tab. */
export const STORE_WRITE_ATTEMPTS = 5;

/** The device clock may differ from chain time by at most this much to order. */
export const MAX_CLOCK_SKEW_SECS = 5 * 60;

/** NIP-59 back-dates a gift wrap up to two days: a read for replies reaches back that far. */
export const WRAP_BACKDATE_SECS = 2 * 24 * 60 * 60;

/** The merchant keeps catching up on an order's payments this long after it (plan: 3 days). */
export const MERCHANT_CATCH_UP_SECS = 3 * 24 * 60 * 60;

/** No wallet request, first or retry, this close to the end of the merchant's catch-up. */
export const PAY_CUTOFF_SECS = 60 * 60;

/**
 * A payment is looked for back to the order's `created_at` minus this margin
 * (the merchant's own scan margin): the order is dated by the chain, a block a
 * little behind it may hold the payment.
 */
export const PAYMENT_SCAN_MARGIN_SECS = 30 * 60;

/** Compute units the payment transaction asks for: what pay-core's own builder uses. */
export const SOLANA_COMPUTE_UNIT_LIMIT = 200_000;

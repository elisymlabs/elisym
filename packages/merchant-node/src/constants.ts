/**
 * A payment may pay any price or payout the store offered within this long
 * before the payment's block time: a relay lag or a rotation between the
 * widget's read and the payment must not refuse a correct payment.
 */
export const TERMS_WINDOW_SECS = 45 * 60;

/**
 * How far before an order's `created_at` a scan for its payment starts: the
 * rumor may be dated up to 15 minutes ahead (commerce `MAX_FUTURE_SKEW_SECS`).
 */
export const ORDER_SCAN_MARGIN_SECS = 30 * 60;

/** How long an unpaid order is caught up (per payout address, not per order). */
export const CATCH_UP_SECS = 3 * 24 * 60 * 60;

/** NIP-59 back-dates a gift wrap up to two days: a subscription reaches back that far. */
export const WRAP_BACKDATE_SECS = 2 * 24 * 60 * 60;

/** How often a running merchant catches up on its payout addresses. */
export const CATCH_UP_INTERVAL_MS = 60_000;

/** The receipt `medium` of each Solana network. */
export const SOLANA_MEDIUMS = { mainnet: 'solana', devnet: 'solana-devnet' } as const;

/**
 * Where the store publishes its offer: the relays the checkout always reads
 * (its `DEFAULT_RELAYS`). The store's own inbox relays are added to these.
 */
export const OFFER_RELAYS: readonly string[] = [
  'wss://relay.elisym.network',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

/** How long one relay may take to connect and answer a publish. */
export const PUBLISH_DEADLINE_MS = 20_000;

/** No order is dated before this (2020-09): a payment request refuses such a date. */
export const EARLIEST_ORDER_SECS = 1_600_000_000;

/** Receipts kept per order: more are dropped (anyone can send them for free). */
export const MAX_RECEIPTS_PER_ORDER = 5;

/**
 * Reported transactions checked again per catch-up, across ALL orders: a landed
 * payment is found by the payout-account scan anyway, so this only speeds up a
 * receipt that came before its transaction, and it must not grow with orders.
 */
export const MAX_RECHECKS_PER_SWEEP = 20;

/** Pauses before a closed inbox subscription is opened again, growing to the last. */
export const RESUBSCRIBE_BACKOFF_MS: readonly number[] = [1_000, 5_000, 15_000, 60_000];

/**
 * Receipts checked on arrival per minute, across all orders: a fresh order and
 * its receipts are free to send, so the rest wait for the sweep's bounded recheck.
 */
export const MAX_LIVE_CHECKS_PER_MINUTE = 20;

/**
 * When a reported transaction is not visible to the node's RPC yet (`ask_again`),
 * it is checked again after these pauses (each within the live budget), not only
 * at the next minute's sweep: the buyer waits on the other side.
 */
export const ASK_AGAIN_DELAYS_MS: readonly number[] = [3_000, 10_000, 30_000];

/**
 * A delivered order's status is sent again when its order or a receipt is read
 * again (a relay may have dropped the first one), at most this often per order.
 */
export const RESEND_EVERY_SECS = 10 * 60;

/**
 * Statuses sent again at once, off the queue: a restart reads two days of
 * orders back, and a slow relay must not hold new orders behind them.
 */
export const MAX_REPEATS_IN_FLIGHT = 4;

/**
 * A delivery counts as done once this many of the store's inbox relays took it
 * (or all of them, when fewer are configured) - one relay may drop it later.
 */
export const DELIVERY_RELAYS_WANTED = 2;

/** After this long past the payment, one relay taking the delivery is enough. */
export const DELIVERY_SETTLE_SECS = 60 * 60;

/** New terms are dated this much before the local clock, which may run ahead of chain time. */
export const TERMS_CLOCK_MARGIN_SECS = 60;

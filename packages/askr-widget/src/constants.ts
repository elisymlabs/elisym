/** The custom element the widget defines. */
export const ELEMENT_NAME = 'askr-chat';

/** No `answer` or new `status` within this long after sending: reconnect, then offer retry (4.1). */
export const ANSWER_TIMEOUT_MS = 60_000;

/** A history read (REQ) with no real EOSE within this long counts as failed (2.4). */
export const NO_EOSE_TIMEOUT_MS = 15_000;
/** nostr-tools' own `eoseTimeout` sits above our timer, so only our timer judges a missing EOSE. */
export const EOSE_TIMEOUT_SLACK_MS = 5_000;
export const CONNECT_TIMEOUT_MS = 10_000;
/** How long a card fetch waits for the relay connection to come back before it gives up. */
export const CONNECTION_WAIT_MS = 30_000;
/** A card fetch cut by a reconnect is re-run at most this many times. */
export const MAX_QUERY_ATTEMPTS = 3;

/** Reconnect backoff (2.4): exponential with jitter, 1 s doubling to 60 s. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** The backoff resets once the connection stayed up this long after a real EOSE. */
export const BACKOFF_RESET_AFTER_EOSE_MS = 60_000;

/** Card resolution: at most this many distinct addresses per answer (4.3). */
export const MAX_CARD_ADDRESSES = 50;
/** Resolved cards (and confirmed misses) are reused from sessionStorage for this long. */
export const CARD_CACHE_TTL_SECS = 5 * 60;

export const STORAGE_PREFIX = 'askr:';
export const VISITOR_KEY_PREFIX = `${STORAGE_PREFIX}v:`;
export const CARD_CACHE_PREFIX = `${STORAGE_PREFIX}card:`;
export const PANEL_OPEN_PREFIX = `${STORAGE_PREFIX}open:`;

export const KIND_PRODUCT = 30402;
export const KIND_GIFT_WRAP = 1059;

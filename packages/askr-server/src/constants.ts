/** Every REQ on the server's relay connection stays under this budget (the relay allows 32, 2.4). */
export const SUBSCRIPTION_BUDGET = 8;
/** Slots of the budget always kept for catalog reload pages (2.4). */
export const RELOAD_SLOTS = 1;
/** A serialized REQ is split past this many bytes (the relay's message cap is 256 KiB, 2.4). */
export const REQ_BYTES_CAP = 200 * 1024;
/** Wraps to an assistant key are read from this far back on every (re)subscription (2.4). */
export const WRAP_SINCE_SECS = 10 * 60;
/** A wrap whose `created_at` is further ahead than this is junk: ours are only backdated (2.4). */
export const WRAP_AHEAD_SECS = 2 * 60;
/** Wrap ids already verified are skipped on a replay for this long (2.4). */
export const VERIFIED_IDS_TTL_SECS = 12 * 60;
/** A history-reading REQ that gets no real EOSE in this time is closed and reopened (2.4). */
export const EOSE_TIMEOUT_MS = 20_000;
/** nostr-tools' own EOSE timer is set above ours, so only a real EOSE ends a read (2.4). */
export const LIBRARY_EOSE_TIMEOUT_MS = EOSE_TIMEOUT_MS + 10_000;
/** A relay connection attempt gives up after this long (2.4). */
export const CONNECTION_TIMEOUT_MS = 10_000;
/** Reconnect backoff: jittered, doubling from 1 s to 60 s (2.4). */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** A turn's deadline (5.8). */
export const TURN_DEADLINE_MS = 2 * 60 * 1_000;
/** Rumor ids are remembered for the wrap TTL (5.8). */
export const RUMOR_DEDUP_SECS = 24 * 60 * 60;
/** Catalog reads page backwards in windows of this many events. */
export const CATALOG_PAGE_LIMIT = 500;
/** How often ended sessions, dedup ids and past days' counters are swept (5.8). */
export const SWEEP_INTERVAL_MS = 60_000;
/** A connection that stayed up this long resets its backoff (one ping cycle, 2.4). */
export const STABLE_CONNECTION_MS = 60_000;
/** Pages read per filter at most, so no relay can hold the reload queue (5.1). */
export const CATALOG_PAGES_PER_FILTER = 40;
/** A third-party relay of a `paycore` source gets this long to connect and per page (5.1). */
export const EXTRA_RELAY_TIMEOUT_MS = 5_000;
/** ...and this long in all per reload, so a dead one holds the queue at most this (5.1). */
export const EXTRA_RELAY_BUDGET_MS = 10_000;

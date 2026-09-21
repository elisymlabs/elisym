/**
 * Tempo's fixed addresses, selectors, event topics and the bounds of a log scan.
 *
 * Every value here was measured on both networks (the facts file beside the
 * plan records each one and how). None of it is configurable, and none of it is
 * ever taken from a card, a payment request or a job.
 */

/** TIP-403 receive-policy registry. */
export const TEMPO_POLICY_REGISTRY = '0x403c000000000000000000000000000000000000';
/** The guard that holds a blocked transfer's funds and emits `TransferBlocked`. */
export const TEMPO_TRANSFER_GUARD = '0xb10c000000000000000000000000000000000000';
/** `receivePolicy(address)` on the registry: exactly 192 bytes back. */
export const RECEIVE_POLICY_SELECTOR = '0xe111e611';

/** `Transfer(address indexed from, address indexed to, uint256 value)`. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/**
 * `TransferWithMemo(address indexed from, address indexed to, uint256 amount,
 * bytes32 indexed memo)` - four topics, 32 bytes of data. Emitted only by the
 * token's own mint / burn / transfer entry points, so only the token can emit it
 * from the token's address.
 */
export const TRANSFER_WITH_MEMO_TOPIC =
  '0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0';
/**
 * `TransferBlocked(address indexed token, address indexed receiver, uint64
 * indexed blockedNonce, uint256 amount, uint8 receiptVersion, bytes receipt)`,
 * emitted by the guard when a receive policy refuses a transfer. The
 * transaction SUCCEEDS and no `TransferWithMemo` is emitted, so this log is the
 * only difference between "blocked" and "never sent".
 */
export const TRANSFER_BLOCKED_TOPIC =
  '0x361d86e46fd139dc3eac4148f16b53597f0f8ddd9aba772aae0034bda5531b1c';

/** `eth_getLogs` answers more than this many blocks with an explicit error. */
export const MAX_LOG_BLOCK_RANGE = 100_000;
/**
 * A payment that arrives after its request expired is still the customer's
 * money. A scan may conclude "nothing was ever sent" only once this much has
 * passed on top of the expiry.
 */
export const EVM_LATE_PAYMENT_GRACE_SECS = 1800;
/** The first width of a history-control window, in blocks. */
export const HISTORY_CONTROL_START_BLOCKS = 256;
/** Widening x4 and halving cannot fight each other for longer than this. */
export const MAX_HISTORY_CONTROL_ITERATIONS = 12;
/**
 * How long the live path may poll for a payment whose hash the customer never
 * reported. The Solana paths are one-shot on purpose, so one unpaid job cannot
 * pin a provider slot for the whole payment window.
 */
export const TEMPO_LIVE_NOHASH_BUDGET_MS = 60_000;
/** Pause between passes of that poll. */
export const TEMPO_LIVE_POLL_INTERVAL_MS = 2_000;
/**
 * A hard ceiling on `eth_getLogs` requests in one scan. Reached only by a range
 * far wider than any live path asks for, or by a node that halves every chunk;
 * either way the pass is INCOMPLETE, which never credits and never concludes
 * "not paid".
 */
export const MAX_LOG_SCAN_REQUESTS = 512;

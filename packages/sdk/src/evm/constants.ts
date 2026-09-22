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
/**
 * The network's fee sink. Every Tempo receipt ends with a transfer to it, on a
 * reverted transaction too - so a sender matching its own legs must never count
 * one.
 */
export const TEMPO_FEE_SINK = '0xfeec000000000000000000000000000000000000';

/** The TIP-1022 address registry precompile, live on mainnet. */
export const TEMPO_ADDRESS_REGISTRY = '0xfdc0000000000000000000000000000000000000';

/**
 * Addresses no payment of ours may name. Four are the protocol's own system
 * accounts - the policy registry, the transfer guard, the fee sink and the
 * address registry - and the fifth is the burn address: money sent to any of
 * them is gone, and nothing this SDK can read would ever report it as
 * delivered - the fee sink is excluded from every leg match by name.
 */
export const TEMPO_UNPAYABLE_ADDRESSES: readonly string[] = [
  `0x${'0'.repeat(40)}`,
  TEMPO_POLICY_REGISTRY,
  TEMPO_TRANSFER_GUARD,
  TEMPO_FEE_SINK,
  TEMPO_ADDRESS_REGISTRY,
];
/** `receivePolicy(address)` on the registry: exactly 192 bytes back. */
export const RECEIVE_POLICY_SELECTOR = '0xe111e611';
/**
 * `validateReceivePolicy(address,address,address)` on the registry, read as
 * `(token, sender, receiver)` - the registry's own verdict, exactly 64 bytes back.
 */
export const VALIDATE_RECEIVE_POLICY_SELECTOR = '0xb72b0c59';

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

/**
 * A floor under anything claiming to be a Tempo deadline, in epoch seconds.
 * September 2020 - comfortably before the chain existed and comfortably above
 * the values a mistake produces (`0`, a `Number('')`, a small counter, a value
 * in milliseconds is far ABOVE it and caught by the chain's own clock). It
 * separates "a number" from "a time", and claims nothing more.
 */
export const EARLIEST_TEMPO_SECONDS = 1_600_000_000;

/**
 * And a ceiling, for the likeliest slip of all: `Date.now()` where seconds
 * were meant. A millisecond value clears the floor by three orders of
 * magnitude and is then caught only by the chain's own clock - which never
 * reaches it, so the answer is `pending` for ever and says nothing about why.
 * The year 2200 in seconds.
 */
export const LATEST_TEMPO_SECONDS = 7_258_118_400;

/**
 * How far the chain's clock and the issuer's own may differ before a quote is
 * refused. Stamping `created_at` from the chain makes the verifier's window
 * self-consistent under a constant rpc lag - both stamps are chain time, so
 * the lag cancels - but it removes the only local anchor: an endpoint whose
 * `finalized` tag lags by more than the window would mint requests already
 * past their late deadline, and one answering a future timestamp would mint
 * requests no verdict can ever terminate. Comparing the two catches either,
 * and neither alone would. Fifteen minutes is far above real finality lag on
 * Tempo (measured: zero to one second). It is NOT below the payment window -
 * `DEFAULTS.PAYMENT_EXPIRY_SECS` is 600 s, so this is one and a half times it -
 * and that is survivable only because nothing downstream orders the two: the
 * verifier's own lateness is covered by the 1800 s grace, and a request minted
 * against a skewed clock is refused on the CUSTOMER's side by the expiry gate
 * before any money moves.
 */
export const MAX_ISSUER_CLOCK_SKEW_SECS = 900;

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

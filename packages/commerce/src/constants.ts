/** Store profile (NIP-01), signed by the store key. */
export const KIND_STORE_PROFILE = 0;
/** Payout addresses (NIP-A3 `payto` plus the elisym `accept` extension), signed by the owner key. */
export const KIND_PAYTO = 10133;
/**
 * "Store key S acts for owner O", signed by the owner key. Addressable, `d` = the
 * store pubkey.
 *
 * PROVISIONAL: the number is not registered yet (spec, open question 1). It is
 * named in one place so that fixing it is a one-line change.
 */
export const KIND_STORE_AUTH = 30490;
/** Product listing (NIP-99, Gamma Markets), signed by the store key. */
export const KIND_PRODUCT = 30402;
/** Inbox relays for gift-wrapped messages (NIP-17). */
export const KIND_INBOX_RELAYS = 10050;
/** Order message inside a gift wrap: `type` 1 order, 2 payment request, 3 status (Gamma Markets). */
export const KIND_ORDER_MESSAGE = 16;
/** Payment receipt inside a gift wrap (Gamma Markets). */
export const KIND_PAYMENT_RECEIPT = 17;
export const KIND_SEAL = 13;
export const KIND_GIFT_WRAP = 1059;

/** Opt-in tag value that lists a product in the elisym aggregator. */
export const ELISYM_NETWORK_TAG = 'elisym';

/**
 * What a payout wallet signs to prove it belongs to the owner. The owner pubkey
 * and the CAIP-19 id are both inside, so a proof made for one owner or one asset
 * cannot be replayed for another.
 */
export const PAYTO_PROOF_PREFIX = 'elisym-payto:v1';

export const DELIVERY_METHODS = ['download', 'license', 'access', 'webhook', 'api'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const ORDER_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Gamma Markets visibility values under which a product can be bought. */
export const PURCHASABLE_VISIBILITIES = ['on-sale', 'pre-order'] as const;

/** A payout address younger than this is flagged: the owner key may have been taken over. */
export const PAYOUT_COOLDOWN_SECS = 72 * 60 * 60;

/** How far in the future an event's `created_at` may sit before it is ignored. */
export const MAX_FUTURE_SKEW_SECS = 15 * 60;

export const LIMITS = {
  MAX_ORDER_ID_LENGTH: 64,
  MAX_TAG_VALUE_LENGTH: 1024,
  MAX_CONTENT_LENGTH: 64 * 1024,
  MAX_ITEMS_PER_ORDER: 50,
  MAX_NIP05_DOCUMENT_BYTES: 64 * 1024,
} as const;

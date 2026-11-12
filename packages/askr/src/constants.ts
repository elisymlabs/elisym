/**
 * Askr event kinds. Every number except 30402 (NIP-99) is PROVISIONAL: not
 * registered anywhere yet, and named only here so that changing one is a
 * one-line change. 30490 (Pay Core's store authorization) comes from
 * `@elisym/commerce` as `KIND_STORE_AUTH` and is never redefined here.
 */
export const KIND_POLICY = 30495;
export const KIND_CONFIG = 30496;
export const KIND_CATALOG_AUTH = 30497;
/** The chat rumor inside a gift wrap: not kind 14, so DM clients never show it as a human DM. */
export const KIND_CHAT_MESSAGE = 4495;
/** A gateway session ticket: signed, never published. */
export const KIND_SESSION_TICKET = 27495;

/** The only relay Askr writes to and reads from (K20). Compiled in, never taken from a message. */
export const ASKR_RELAYS: readonly string[] = ['wss://relay.elisym.network'];

/** The public API host: gateway, `widget.js`, admin. NIP-98 `u` is checked against it. */
export const ASKR_API_BASE = 'https://api.askr.elisym.network';

/** `d` of the store's Askr config event (30496). */
export const CONFIG_D_TAG = 'askr';

/** A session ends this long after its first message; every wrap of it expires then (4.4). */
export const SESSION_TTL_SECS = 24 * 60 * 60;
/** An ask arriving this close to the session end starts the next session instead. */
export const SESSION_END_MARGIN_SECS = 5 * 60;
/** A rumor older than this (by its own, un-backdated `created_at`) is dropped silently. */
export const MAX_RUMOR_AGE_SECS = 5 * 60;
/** A status wrap's own lifetime. */
export const STATUS_TTL_SECS = 60;
/** Gateway tickets live this long; a renewal continues the same session. */
export const TICKET_TTL_SECS = 30 * 60;
/** Slack the relay admission grants over a session end when checking a wrap's `expiration`. */
export const EXPIRATION_ADMISSION_SLACK_SECS = 10 * 60;

export const LIMITS = {
  /** Senders keep a serialized rumor event within this. */
  RUMOR_WORKING_BYTES: 32_000,
  /** Receivers reject a serialized rumor event above this (largest padded size whose seal fits NIP-44). */
  RUMOR_CEILING_BYTES: 40_960,
  /** A wrap's `content` derived from the ceiling: checked before any decrypt. */
  WRAP_CONTENT_MAX_CHARS: 76_548,
  ASK_TEXT_CHARS: 2_000,
  ANSWER_TEXT_CHARS: 4_000,
  PAGE_URL_BYTES: 2_048,
  LOCALE_CHARS: 35,
  STATUS_TEXT_CHARS: 80,
  REASON_CHARS: 140,
  CHIP_CHARS: 40,
  MAX_CHIPS: 4,
  MAX_PRODUCT_PICKS: 8,
  MIN_COMPARISON: 2,
  MAX_COMPARISON: 4,
  MAX_COMPARISON_ROWS: 6,
  MAX_PLAN_STEPS: 6,
  MAX_PLAN_STEP_ADDRESSES: 4,
  MAX_GUIDE_SECTIONS: 6,
  TITLE_CHARS: 80,
  GUIDE_BODY_CHARS: 600,
  PLAN_DETAIL_CHARS: 240,
  /** Catalog listing caps (2.1), in characters as zod counts them. */
  TAG_VALUE_CHARS: 1_024,
  DESCRIPTION_CHARS: 64 * 1024,
  MAX_IMAGES: 8,
  MAX_TOPICS: 20,
  TOPIC_CHARS: 64,
  MAX_ATTRS: 30,
  ATTR_NAME_CHARS: 32,
  ATTR_VALUE_CHARS: 128,
  MAX_OPTIONS: 5,
  MAX_OPTION_VALUES: 10,
  MAX_VARIANTS: 100,
  /** Policies (2.2). */
  POLICY_CONTENT_CHARS: 16 * 1024,
  MAX_POLICIES: 50,
  /** Config private part (2.3): the plaintext JSON, in UTF-8 bytes. */
  CONFIG_PRIVATE_BYTES: 16 * 1024,
  /**
   * The config `content` bound the reader derives from CONFIG_PRIVATE_BYTES with
   * NIP-44 sizing: 16 384 bytes pad to 16 384, plus version, nonce, length and
   * MAC (67 bytes), base64 of 16 451 bytes = 21 936 chars.
   */
  CONFIG_CONTENT_MAX_CHARS: 21_936,
  CONFIG_VOICE_CHARS: 4_000,
  CONFIG_INSTRUCTIONS_CHARS: 8_000,
  CONFIG_NOTES_CHARS: 4_000,
  MAX_ORIGINS: 20,
  GREETING_CHARS: 280,
  PLAN_STEP_LABEL_CHARS: 120,
  MAX_COMPONENTS: 4,
} as const;

/** Visibilities an Askr reader knows; anything else is absent. */
export const VISIBILITIES = ['on-sale', 'pre-order', 'sold-out', 'hidden'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** Reserved `attr` names: never search filters or top attrs (2.1). */
export const RESERVED_ATTRS: readonly string[] = ['sku', 'source-id'];

/** The wildcard a variant carries for an option it accepts any value of (a Woo "Any" variation). */
export const ANY_OPTION_VALUE = '*';

export const PRODUCT_SOURCES = ['paycore', 'catalog', 'admin', 'connector'] as const;
export type ProductSourceKind = (typeof PRODUCT_SOURCES)[number];

export const CONNECTOR_PLATFORMS = ['shopify', 'woocommerce', 'google'] as const;
export type ConnectorPlatform = (typeof CONNECTOR_PLATFORMS)[number];

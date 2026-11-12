import { HEX_PUBKEY_RE, nowSecs, tagValue, tagValues, tagsNamed } from '@elisym/commerce';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import * as nip44 from 'nostr-tools/nip44';
import { z } from 'zod';
import {
  CONFIG_D_TAG,
  CONNECTOR_PLATFORMS,
  type ConnectorPlatform,
  KIND_CONFIG,
  LIMITS,
  PRODUCT_SOURCES,
  type ProductSourceKind,
} from '../constants';

const CURRENCY_RE = /^[A-Z]{3}$/;
const LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface ProductSource {
  kind: ProductSourceKind;
  /** Only for `connector`. */
  platform?: ConnectorPlatform;
  /**
   * Only for `connector`: the connected shop (`https://host` or `https://host/shop`),
   * in the form `normalizeShopUrl` gives. Its origin is one of the config's
   * `origin` entries. Without it the widget never adds to the cart natively.
   */
  shopUrl?: string;
}

export interface StoreConfig {
  owner: string;
  assistant: string;
  /** Origins allowed to embed the widget and get tickets. */
  origins: string[];
  /** Extra origins allowed for `r` product links only. */
  linkOrigins: string[];
  name: string;
  displayName?: string;
  avatar?: string;
  greeting?: string;
  /** BCP 47 language of the catalog. */
  language: string;
  /** ISO 4217: the store's one currency. */
  currency: string;
  source: ProductSource;
  /** The K (or a Pay Core S) whose 30402 the store's products come from. */
  catalogKey: string;
  /** The key whose 30495 policies are read. */
  policyKey: string;
  contact?: string;
  /** Encrypted to the assistant key: voice, instructions, notes. */
  privateContent: string;
  createdAt: number;
}

export interface StorePrivateConfig {
  voice: string;
  instructions: string;
  notes: string;
}

const httpsOrigin = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === value;
    } catch {
      return false;
    }
  }, 'an https origin without a path');

const hexKey = z.string().regex(HEX_PUBKEY_RE);

/**
 * A connected shop URL in its one canonical form: https, no credentials, query
 * or fragment, `{origin}{path}` with no trailing slash (`https://host/shop`).
 * Undefined when the value is not such a URL.
 */
export function normalizeShopUrl(value: string): string | undefined {
  if (value.length > LIMITS.TAG_VALUE_CHARS) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    value.includes('?') ||
    value.includes('#')
  ) {
    return undefined;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

export const StoreConfigInputSchema = z.object({
  assistant: hexKey,
  origins: z.array(httpsOrigin).min(1).max(LIMITS.MAX_ORIGINS),
  linkOrigins: z.array(httpsOrigin).max(LIMITS.MAX_ORIGINS).default([]),
  name: z.string().min(1).max(LIMITS.TITLE_CHARS),
  displayName: z.string().min(1).max(LIMITS.TITLE_CHARS).optional(),
  avatar: z.string().url().startsWith('https://').max(LIMITS.TAG_VALUE_CHARS).optional(),
  greeting: z.string().min(1).max(LIMITS.GREETING_CHARS).optional(),
  language: z.string().regex(LANGUAGE_RE).max(LIMITS.LOCALE_CHARS),
  currency: z.string().regex(CURRENCY_RE),
  source: z.object({
    kind: z.enum(PRODUCT_SOURCES),
    platform: z.enum(CONNECTOR_PLATFORMS).optional(),
    shopUrl: z
      .string()
      .refine((value) => normalizeShopUrl(value) !== undefined, 'an https shop URL')
      .optional(),
  }),
  catalogKey: hexKey,
  policyKey: hexKey.optional(),
  contact: z.string().url().startsWith('https://').max(LIMITS.TAG_VALUE_CHARS).optional(),
  private: z
    .object({
      voice: z.string().max(LIMITS.CONFIG_VOICE_CHARS).default(''),
      instructions: z.string().max(LIMITS.CONFIG_INSTRUCTIONS_CHARS).default(''),
      notes: z.string().max(LIMITS.CONFIG_NOTES_CHARS).default(''),
    })
    .default({}),
  createdAt: z.number().int().positive().optional(),
});

export type StoreConfigInput = z.input<typeof StoreConfigInputSchema>;

/**
 * Build the store's Askr config (2.3). The private part is NIP-44 encrypted
 * from the owner to the assistant key; the caller signs the template with the
 * same owner key.
 */
export function buildConfigEvent(
  input: StoreConfigInput,
  ownerSecretKey: Uint8Array,
): EventTemplate {
  const config = StoreConfigInputSchema.parse(input);
  if ((config.source.kind === 'connector') !== (config.source.platform !== undefined)) {
    throw new Error('A connector source names its platform, and only a connector source does');
  }
  // A Pay Core store key S never holds the catalog role, so it cannot be the policy key (1.4).
  if (config.source.kind === 'paycore' && config.policyKey === undefined) {
    throw new Error('A paycore source needs an explicit policyKey (the server or a merchant K)');
  }
  const shopUrl =
    config.source.shopUrl === undefined ? undefined : normalizeShopUrl(config.source.shopUrl);
  if (config.source.shopUrl !== undefined && config.source.kind !== 'connector') {
    throw new Error('Only a connector source names a shop URL');
  }
  if (shopUrl !== undefined && !config.origins.includes(new URL(shopUrl).origin)) {
    throw new Error("The shop URL's origin must be one of the config's origins");
  }
  const privateJson = JSON.stringify(config.private);
  if (new TextEncoder().encode(privateJson).length > LIMITS.CONFIG_PRIVATE_BYTES) {
    throw new Error('The private part of the config is too large');
  }
  const conversationKey = nip44.v2.utils.getConversationKey(ownerSecretKey, config.assistant);
  const tags: string[][] = [
    ['d', CONFIG_D_TAG],
    ['assistant', config.assistant],
    ['name', config.name],
    ['language', config.language],
    ['currency', config.currency],
    sourceTagOf(config.source.kind, config.source.platform, shopUrl),
    ['catalog-key', config.catalogKey],
    ['policy-key', config.policyKey ?? config.catalogKey],
  ];
  for (const origin of config.origins) {
    tags.push(['origin', origin]);
  }
  for (const origin of config.linkOrigins) {
    tags.push(['link-origin', origin]);
  }
  if (config.displayName !== undefined) {
    tags.push(['display-name', config.displayName]);
  }
  if (config.avatar !== undefined) {
    tags.push(['avatar', config.avatar]);
  }
  if (config.greeting !== undefined) {
    tags.push(['greeting', config.greeting]);
  }
  if (config.contact !== undefined) {
    tags.push(['contact', config.contact]);
  }
  return {
    kind: KIND_CONFIG,
    created_at: config.createdAt ?? nowSecs(),
    tags,
    content: nip44.v2.encrypt(privateJson, conversationKey),
  };
}

function sourceTagOf(
  kind: ProductSourceKind,
  platform: ConnectorPlatform | undefined,
  shopUrl: string | undefined,
): string[] {
  if (platform === undefined) {
    return ['source', kind];
  }
  return shopUrl === undefined ? ['source', kind, platform] : ['source', kind, platform, shopUrl];
}

function isProductSourceKind(value: string | undefined): value is ProductSourceKind {
  return PRODUCT_SOURCES.some((kind) => kind === value);
}

function isConnectorPlatform(value: string | undefined): value is ConnectorPlatform {
  return CONNECTOR_PLATFORMS.some((platform) => platform === value);
}

function single(tags: NostrEvent['tags'], name: string): string | undefined {
  const matches = tagsNamed(tags, name);
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

function originsFrom(values: string[]): string[] | undefined {
  const parsed = z.array(httpsOrigin).max(LIMITS.MAX_ORIGINS).safeParse(values);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Read a config's public part, or `undefined` when anything required is
 * missing, duplicated or malformed (fail closed: a store with an unreadable
 * config gets no assistant). The caller checked signature and that the author
 * is the store owner.
 */
export function parseConfig(
  event: Pick<NostrEvent, 'kind' | 'pubkey' | 'tags' | 'content' | 'created_at'>,
): StoreConfig | undefined {
  const tags = event.tags;
  if (event.kind !== KIND_CONFIG || tagValue(tags, 'd') !== CONFIG_D_TAG) {
    return undefined;
  }
  const assistant = single(tags, 'assistant');
  const name = single(tags, 'name');
  const language = single(tags, 'language');
  const currency = single(tags, 'currency');
  const catalogKey = single(tags, 'catalog-key');
  const policyKey = single(tags, 'policy-key');
  const sourceTags = tagsNamed(tags, 'source');
  const sourceTag =
    sourceTags.length === 1 && (sourceTags[0]?.length ?? 0) <= 4 ? sourceTags[0] : undefined;
  const sourceKind = sourceTag?.[1];
  const sourcePlatform = sourceTag?.[2];
  const sourceShopUrl = sourceTag?.[3];
  const origins = originsFrom(tagValues(tags, 'origin'));
  const linkOrigins = originsFrom(tagValues(tags, 'link-origin'));
  if (
    assistant === undefined ||
    !HEX_PUBKEY_RE.test(assistant) ||
    !name ||
    name.length > LIMITS.TITLE_CHARS ||
    language === undefined ||
    !LANGUAGE_RE.test(language) ||
    language.length > LIMITS.LOCALE_CHARS ||
    currency === undefined ||
    !CURRENCY_RE.test(currency) ||
    catalogKey === undefined ||
    !HEX_PUBKEY_RE.test(catalogKey) ||
    policyKey === undefined ||
    !HEX_PUBKEY_RE.test(policyKey) ||
    !isProductSourceKind(sourceKind) ||
    !origins ||
    origins.length === 0 ||
    !linkOrigins ||
    event.content.length > LIMITS.CONFIG_CONTENT_MAX_CHARS
  ) {
    return undefined;
  }
  const source: ProductSource = { kind: sourceKind };
  if (sourceKind === 'connector') {
    if (!isConnectorPlatform(sourcePlatform)) {
      return undefined;
    }
    source.platform = sourcePlatform;
    if (sourceShopUrl !== undefined) {
      // Fail closed: a shop URL that is not canonical, or off the config's origins, voids the config.
      if (
        normalizeShopUrl(sourceShopUrl) !== sourceShopUrl ||
        !origins.includes(new URL(sourceShopUrl).origin)
      ) {
        return undefined;
      }
      source.shopUrl = sourceShopUrl;
    }
  } else if (sourcePlatform !== undefined) {
    return undefined;
  }
  const config: StoreConfig = {
    owner: event.pubkey,
    assistant,
    origins,
    linkOrigins,
    name,
    language,
    currency,
    source,
    catalogKey,
    policyKey,
    privateContent: event.content,
    createdAt: event.created_at,
  };
  const displayName = single(tags, 'display-name');
  if (displayName && displayName.length <= LIMITS.TITLE_CHARS) {
    config.displayName = displayName;
  }
  const avatar = single(tags, 'avatar');
  if (avatar?.startsWith('https://') && avatar.length <= LIMITS.TAG_VALUE_CHARS) {
    config.avatar = avatar;
  }
  const greeting = single(tags, 'greeting');
  if (greeting && greeting.length <= LIMITS.GREETING_CHARS) {
    config.greeting = greeting;
  }
  const contact = single(tags, 'contact');
  if (contact?.startsWith('https://') && contact.length <= LIMITS.TAG_VALUE_CHARS) {
    config.contact = contact;
  }
  return config;
}

const PrivateConfigSchema = z.object({
  voice: z.string().max(LIMITS.CONFIG_VOICE_CHARS),
  instructions: z.string().max(LIMITS.CONFIG_INSTRUCTIONS_CHARS),
  notes: z.string().max(LIMITS.CONFIG_NOTES_CHARS),
});

/** Decrypt the private part with the assistant key, or `undefined` when it does not open. */
export function decryptPrivateConfig(
  config: Pick<StoreConfig, 'owner' | 'privateContent'>,
  assistantSecretKey: Uint8Array,
): StorePrivateConfig | undefined {
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(assistantSecretKey, config.owner);
    const parsed = PrivateConfigSchema.safeParse(
      JSON.parse(nip44.v2.decrypt(config.privateContent, conversationKey)),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The display name the widget shows (K11). */
export function assistantDisplayName(config: Pick<StoreConfig, 'name' | 'displayName'>): string {
  return config.displayName ?? `${config.name} assistant`;
}

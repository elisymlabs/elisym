import {
  type CatalogAuthInput,
  type ConnectorPlatform,
  type ProductSourceKind,
  type StoreConfig,
  type StoreConfigInput,
  StoreConfigInputSchema,
  type StorePrivateConfig,
  buildCatalogAuth,
  buildConfigEventWith,
  normalizeShopUrl,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { DEFAULT_CURRENCY, DEFAULT_LANGUAGE } from '../constants';
import { npubOf, parsePublicKey } from './signer';
import type { Signer } from './signer';

/** The settings form, as typed: every field a string so it can be edited freely. */
export interface StoreForm {
  name: string;
  language: string;
  currency: string;
  /** One origin per line (or comma separated). */
  origins: string;
  linkOrigins: string;
  displayName: string;
  avatar: string;
  greeting: string;
  contact: string;
  source: ProductSourceKind;
  platform: ConnectorPlatform;
  /** Shopify / WooCommerce: the shop's address. */
  shopUrl: string;
  /** `catalog`: the merchant K (npub or hex). */
  merchantKey: string;
  /** `paycore`: the Pay Core store key S (npub or hex). */
  paycoreKey: string;
  voice: string;
  instructions: string;
  notes: string;
}

/** The server's keys for this store, from `POST`/`GET /v1/admin/store`. */
export interface ServerKeys {
  /** A, or the next A while a rotation is under way. */
  assistant: string;
  /** The server catalog key K. */
  serverKey: string;
}

export const EMPTY_FORM: StoreForm = {
  name: '',
  language: DEFAULT_LANGUAGE,
  currency: DEFAULT_CURRENCY,
  origins: '',
  linkOrigins: '',
  displayName: '',
  avatar: '',
  greeting: '',
  contact: '',
  source: 'admin',
  platform: 'shopify',
  shopUrl: '',
  merchantKey: '',
  paycoreKey: '',
  voice: '',
  instructions: '',
  notes: '',
};

/** A form problem worded for the merchant. */
export class FormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormError';
  }
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  origins: 'Allowed origins',
  linkOrigins: 'Link origins',
  name: 'Store name',
  displayName: 'Assistant name',
  avatar: 'Avatar URL',
  greeting: 'Greeting',
  language: 'Language',
  currency: 'Currency',
  source: 'Product source',
  catalogKey: 'Catalog key',
  contact: 'Contact URL',
  private: 'Assistant instructions',
};

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Origins from free text: one per line or comma separated, each reduced to its origin. */
export function parseOrigins(text: string, label: string): string[] {
  const origins: string[] = [];
  for (const entry of text.split(/[\s,]+/u)) {
    if (entry === '') {
      continue;
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new FormError(
        `${label}: "${entry}" is not a web address. Use the form https://shop.example`,
      );
    }
    if (url.protocol !== 'https:') {
      throw new FormError(`${label}: "${entry}" must start with https://`);
    }
    if (!origins.includes(url.origin)) {
      origins.push(url.origin);
    }
  }
  return origins;
}

function keyOf(value: string, label: string): string {
  const key = parsePublicKey(value);
  if (key === undefined) {
    throw new FormError(`${label}: paste an npub or 64 hex characters.`);
  }
  return key;
}

/** Which key holds the products and which the policies, for the chosen source (1.4). */
export function sourceKeysOf(
  form: Pick<StoreForm, 'source' | 'merchantKey' | 'paycoreKey'>,
  serverKey: string,
): { catalogKey: string; policyKey: string } {
  if (form.source === 'catalog') {
    const merchantKey = keyOf(form.merchantKey, 'Merchant catalog key');
    return { catalogKey: merchantKey, policyKey: merchantKey };
  }
  if (form.source === 'paycore') {
    // A Pay Core S never holds the catalog role: its policies are edited here, with the server K.
    return { catalogKey: keyOf(form.paycoreKey, 'Pay Core store key'), policyKey: serverKey };
  }
  return { catalogKey: serverKey, policyKey: serverKey };
}

/** The 30497 the source needs: `hosted` for the server K, `self-host` for a merchant K. */
export function authorizationOf(
  form: Pick<StoreForm, 'source' | 'merchantKey' | 'paycoreKey'>,
  serverKey: string,
): Pick<CatalogAuthInput, 'key' | 'mode'> {
  if (form.source === 'catalog') {
    return { key: sourceKeysOf(form, serverKey).catalogKey, mode: 'self-host' };
  }
  return { key: serverKey, mode: 'hosted' };
}

/** The config input for `buildConfigEventWith`, checked field by field. */
export function configInputOf(
  form: StoreForm,
  keys: ServerKeys,
  createdAt: number,
): StoreConfigInput {
  const origins = parseOrigins(form.origins, 'Allowed origins');
  if (origins.length === 0) {
    throw new FormError('Allowed origins: add the address of at least one site the chat runs on.');
  }
  const { catalogKey, policyKey } = sourceKeysOf(form, keys.serverKey);
  const source: StoreConfigInput['source'] = { kind: form.source };
  if (form.source === 'connector') {
    source.platform = form.platform;
    if (form.platform !== 'google') {
      const shopUrl = normalizeShopUrl(form.shopUrl.trim());
      if (shopUrl === undefined) {
        throw new FormError(
          'Shop address: enter the https address of the shop, like https://shop.example',
        );
      }
      if (!origins.includes(new URL(shopUrl).origin)) {
        throw new FormError(
          `Shop address: add ${new URL(shopUrl).origin} to the allowed origins, so the chat can add to its cart.`,
        );
      }
      source.shopUrl = shopUrl;
    }
  }
  const displayName = optional(form.displayName);
  const avatar = optional(form.avatar);
  const greeting = optional(form.greeting);
  const contact = optional(form.contact);
  const input: StoreConfigInput = {
    assistant: keys.assistant,
    origins,
    linkOrigins: parseOrigins(form.linkOrigins, 'Link origins'),
    name: form.name.trim(),
    language: form.language.trim(),
    currency: form.currency.trim().toUpperCase(),
    source,
    catalogKey,
    ...(policyKey === catalogKey ? {} : { policyKey }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(avatar === undefined ? {} : { avatar }),
    ...(greeting === undefined ? {} : { greeting }),
    ...(contact === undefined ? {} : { contact }),
    private: { voice: form.voice, instructions: form.instructions, notes: form.notes },
    createdAt,
  };
  const checked = StoreConfigInputSchema.safeParse(input);
  if (!checked.success) {
    const [issue] = checked.error.issues;
    const field = String(issue?.path[0] ?? '');
    throw new FormError(`${FIELD_LABELS[field] ?? 'Settings'}: ${issue?.message ?? 'not valid'}`);
  }
  return input;
}

export interface SignOptions {
  form: StoreForm;
  keys: ServerKeys;
  signer: Signer;
  now: number;
  /** The stored config's date: a new one is dated after it (the server refuses an older one). */
  previousCreatedAt?: number;
  /** Keys already authorized with the catalog role: their 30497 is not signed again. */
  authorized?: ReadonlySet<string>;
}

/**
 * The O-signed events a save posts to `POST /v1/admin/store/events`: the
 * 30496 config (private part sealed to A with the signer's NIP-44) and,
 * unless already in force, the 30497 of the source's key.
 */
export async function signStoreEvents(options: SignOptions): Promise<NostrEvent[]> {
  const createdAt = Math.max(options.now, (options.previousCreatedAt ?? 0) + 1);
  const input = configInputOf(options.form, options.keys, createdAt);
  let template;
  try {
    template = await buildConfigEventWith(input, options.signer.encrypt);
  } catch (error) {
    throw new FormError(
      error instanceof Error ? error.message : 'The settings could not be sealed.',
    );
  }
  const events = [await options.signer.signEvent(template)];
  const authorization = authorizationOf(options.form, options.keys.serverKey);
  if (options.authorized?.has(authorization.key) !== true) {
    events.push(await options.signer.signEvent(buildCatalogAuth({ ...authorization, createdAt })));
  }
  return events;
}

/** The form for a config read back from the relay. */
export function formOfConfig(
  config: StoreConfig,
  privatePart: StorePrivateConfig | undefined,
): StoreForm {
  const platform = config.source.platform ?? EMPTY_FORM.platform;
  return {
    name: config.name,
    language: config.language,
    currency: config.currency,
    origins: config.origins.join('\n'),
    linkOrigins: config.linkOrigins.join('\n'),
    displayName: config.displayName ?? '',
    avatar: config.avatar ?? '',
    greeting: config.greeting ?? '',
    contact: config.contact ?? '',
    source: config.source.kind,
    platform,
    shopUrl: config.source.shopUrl ?? '',
    merchantKey: config.source.kind === 'catalog' ? npubOf(config.catalogKey) : '',
    paycoreKey: config.source.kind === 'paycore' ? npubOf(config.catalogKey) : '',
    voice: privatePart?.voice ?? '',
    instructions: privatePart?.instructions ?? '',
    notes: privatePart?.notes ?? '',
  };
}

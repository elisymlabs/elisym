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
import type { PayCoreStoreAuth } from './paycore';
import { npubOf, parsePublicKey } from './signer';
import type { Signer } from './signer';

/**
 * The product source as the form offers it: the config's kinds, plus `paycore`,
 * a merchant's PayCore store, saved as a `catalog` source (C1): its products
 * from the store key S, its policies from the server key K.
 */
export type FormSourceKind = ProductSourceKind | 'paycore';

/** The PayCore store a `paycore` form sells from, as the owner's 30490 for it says. */
export type PayCoreLink = Pick<PayCoreStoreAuth, 'key' | 'active' | 'mode' | 'operator'>;

/** The currency a PayCore store sells in: its prices are in USD. */
export const PAYCORE_CURRENCY = 'USD';

/** The settings form, as typed: every field a string so it can be edited freely. */
export interface StoreForm {
  name: string;
  language: string;
  currency: string;
  /** One origin per line (or comma separated). */
  origins: string;
  linkOrigins: string;
  displayName: string;
  greeting: string;
  launcherText: string;
  contact: string;
  source: FormSourceKind;
  platform: ConnectorPlatform;
  /** Shopify / WooCommerce: the shop's address. */
  shopUrl: string;
  /** Google: the product feed's address (kept by the connector, not in the signed settings). */
  feedUrl: string;
  /** The connector's currency override, when the shop reports another than it sells in. */
  connectorCurrency: string;
  /** Shopify: import the shop's policy pages. */
  importPolicies: boolean;
  /** `catalog`: the merchant K (npub or hex). */
  merchantKey: string;
  /** `paycore`: the store sold from, found through the owner's 30490s. */
  payCore?: PayCoreLink;
  voice: string;
  instructions: string;
  notes: string;
  /**
   * A policy key the read config names other than its source's default (one
   * signed elsewhere, such as with the SDK): kept as long as the source and
   * its key stay the same.
   */
  keptPolicy?: KeptPolicy;
}

export interface KeptPolicy {
  source: FormSourceKind;
  catalogKey: string;
  policyKey: string;
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
  greeting: '',
  launcherText: '',
  contact: '',
  source: 'admin',
  platform: 'shopify',
  shopUrl: '',
  feedUrl: '',
  connectorCurrency: '',
  importPolicies: true,
  merchantKey: '',
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
  greeting: 'Greeting',
  launcherText: 'Chat button text',
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

/** A scheme already given: `https://`, `http://`, or any other `name://`. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//iu;
/** A host as people type it: at least one dot, as in `shop.example` or `www.shop.example/path`. */
const BARE_HOST_RE = /^[^\s/:]+\.[^\s/:]+(?::\d+)?(?:\/.*)?$/u;

/**
 * An address as typed, with `https://` put in front when it has no scheme and looks like a
 * host (`elisym.network`). Anything else is left as it is, for the caller to accept or refuse
 * (`http://` stays refused).
 */
export function withHttps(value: string): string {
  return !SCHEME_RE.test(value) && BARE_HOST_RE.test(value) ? `https://${value}` : value;
}

/**
 * Origins from free text: one per line or comma separated, each reduced to its origin. A bare
 * host (`shop.example`) is read as `https://shop.example`.
 */
export function parseOrigins(text: string, label: string): string[] {
  const origins: string[] = [];
  for (const entry of text.split(/[\s,]+/u)) {
    if (entry === '') {
      continue;
    }
    let url: URL;
    try {
      url = new URL(withHttps(entry));
    } catch {
      throw new FormError(
        `${label}: "${entry}" is not a web address. Use the form shop.example or https://shop.example`,
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
    throw new FormError(`${label}: paste the key, it starts with npub1.`);
  }
  return key;
}

/** Which key holds the products and which the policies, for the chosen source (1.4). */
export function sourceKeysOf(
  form: Pick<StoreForm, 'source' | 'merchantKey' | 'payCore' | 'keptPolicy'>,
  serverKey: string,
): { catalogKey: string; policyKey: string } {
  const defaults = defaultSourceKeysOf(form, serverKey);
  const kept = form.keptPolicy;
  return kept !== undefined &&
    kept.source === form.source &&
    kept.catalogKey === defaults.catalogKey
    ? { catalogKey: defaults.catalogKey, policyKey: kept.policyKey }
    : defaults;
}

function defaultSourceKeysOf(
  form: Pick<StoreForm, 'source' | 'merchantKey' | 'payCore'>,
  serverKey: string,
): { catalogKey: string; policyKey: string } {
  if (form.source === 'paycore') {
    if (form.payCore === undefined) {
      throw new FormError(
        'PayCore store: none is found for your key yet. Set one up in PayCore, then choose it here.',
      );
    }
    return { catalogKey: form.payCore.key, policyKey: serverKey };
  }
  if (form.source === 'catalog') {
    const merchantKey = keyOf(form.merchantKey, 'Merchant catalog key');
    return { catalogKey: merchantKey, policyKey: merchantKey };
  }
  return { catalogKey: serverKey, policyKey: serverKey };
}

/**
 * A 30497 the source needs. `mode` is undefined only for a PayCore store whose
 * authorization is not active (revoked, expired or deleted): linking it, a new
 * 30497 for its key, needs an active 30490 to mirror. A save that signs no new
 * 30497 for it (one is in force) is not held back.
 */
export interface NeededAuthorization {
  key: string;
  mode: CatalogAuthInput['mode'] | undefined;
  operator?: string;
}

/**
 * The 30497s the source needs, one per key: `hosted` for the server K;
 * `self-host` for a merchant K; for a PayCore store S the mode of its 30490
 * (the operator only when `hosted`). The server K is also needed whenever it
 * holds the policies of another catalog key (a PayCore store, read back as a
 * catalog or carried over by an owner move), so a save, a rotation or a move
 * keeps both.
 */
export function authorizationsOf(
  form: Pick<StoreForm, 'source' | 'merchantKey' | 'payCore' | 'keptPolicy'>,
  serverKey: string,
): NeededAuthorization[] {
  const { catalogKey, policyKey } = sourceKeysOf(form, serverKey);
  if (catalogKey === serverKey) {
    return [{ key: serverKey, mode: 'hosted' }];
  }
  const link = form.source === 'paycore' ? form.payCore : undefined;
  const product: NeededAuthorization =
    link === undefined
      ? { key: catalogKey, mode: 'self-host' }
      : {
          key: catalogKey,
          mode: link.active ? link.mode : undefined,
          ...(link.mode === 'hosted' && link.operator !== undefined
            ? { operator: link.operator }
            : {}),
        };
  return policyKey === serverKey ? [product, { key: serverKey, mode: 'hosted' }] : [product];
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
  const currency = form.currency.trim().toUpperCase();
  if (form.source === 'paycore' && currency !== PAYCORE_CURRENCY) {
    throw new FormError(
      `Currency: a PayCore store's prices are in ${PAYCORE_CURRENCY}, so the currency must be ${PAYCORE_CURRENCY}.`,
    );
  }
  const source: StoreConfigInput['source'] = {
    kind: form.source === 'paycore' ? 'catalog' : form.source,
  };
  if (form.source === 'connector') {
    source.platform = form.platform;
    if (form.platform !== 'google') {
      const shopUrl = normalizeShopUrl(withHttps(form.shopUrl.trim()));
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
  const greeting = optional(form.greeting);
  const launcherText = optional(form.launcherText);
  const contact = optional(form.contact);
  const input: StoreConfigInput = {
    assistant: keys.assistant,
    origins,
    linkOrigins: parseOrigins(form.linkOrigins, 'Link origins'),
    name: form.name.trim(),
    language: form.language.trim(),
    currency,
    source,
    catalogKey,
    ...(policyKey === catalogKey ? {} : { policyKey }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(greeting === undefined ? {} : { greeting }),
    ...(launcherText === undefined ? {} : { launcherText }),
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
  /** Catalog keys the owner already authorizes: their 30497 is not signed again. */
  authorized?: ReadonlySet<string>;
  /** The date of a 30497 signed here for a key: after its newest one (default: the config's date). */
  authCreatedAt?: (key: string) => number;
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
  const needed = authorizationsOf(options.form, options.keys.serverKey).filter(
    (authorization) => options.authorized?.has(authorization.key) !== true,
  );
  const templates = needed.map((authorization) => {
    const { key, mode, operator } = authorization;
    if (mode === undefined) {
      throw new FormError(
        'PayCore store: its authorization is not active, so it cannot be linked. Re-authorize it in PayCore, or choose another store.',
      );
    }
    return buildCatalogAuth({
      key,
      mode,
      ...(operator === undefined ? {} : { operator }),
      createdAt: options.authCreatedAt?.(key) ?? createdAt,
    });
  });
  const events = [await options.signer.signEvent(template)];
  for (const authorization of templates) {
    events.push(await options.signer.signEvent(authorization));
  }
  return events;
}

/** The form for a config read back from the relay. */
export function formOfConfig(
  config: StoreConfig,
  privatePart: StorePrivateConfig | undefined,
): StoreForm {
  const platform = config.source.platform ?? EMPTY_FORM.platform;
  const form: StoreForm = {
    name: config.name,
    language: config.language,
    currency: config.currency,
    origins: config.origins.join('\n'),
    linkOrigins: config.linkOrigins.join('\n'),
    displayName: config.displayName ?? '',
    greeting: config.greeting ?? '',
    launcherText: config.launcherText ?? '',
    contact: config.contact ?? '',
    source: config.source.kind,
    platform,
    shopUrl: config.source.shopUrl ?? '',
    feedUrl: '',
    connectorCurrency: '',
    importPolicies: true,
    merchantKey: config.source.kind === 'catalog' ? npubOf(config.catalogKey) : '',
    voice: privatePart?.voice ?? '',
    instructions: privatePart?.instructions ?? '',
    notes: privatePart?.notes ?? '',
  };
  // The read config's policy key stays while the source and its key do: a key other than the
  // default (one signed elsewhere, such as with the SDK) is never rewritten by a save.
  form.keptPolicy = {
    source: config.source.kind,
    catalogKey: config.catalogKey,
    policyKey: config.policyKey,
  };
  return form;
}

/** The link a form keeps for a PayCore store. */
export function linkOf(store: PayCoreStoreAuth): PayCoreLink {
  const link: PayCoreLink = { key: store.key, active: store.active };
  if (store.mode !== undefined) {
    link.mode = store.mode;
  }
  if (store.operator !== undefined) {
    link.operator = store.operator;
  }
  return link;
}

/**
 * The form for a read config that is a PayCore store (`detectPayCore`): the
 * `paycore` source, linked to its store key, active or not.
 */
export function withPayCore(form: StoreForm, store: PayCoreStoreAuth | undefined): StoreForm {
  if (store === undefined || form.source !== 'catalog') {
    return form;
  }
  const payCore = linkOf(store);
  return {
    ...form,
    source: 'paycore',
    merchantKey: '',
    payCore,
    ...(form.keptPolicy === undefined
      ? {}
      : { keptPolicy: { ...form.keptPolicy, source: 'paycore' } }),
  };
}

/** The connector settings the server keeps beside the signed ones: feed, currency, policies. */
export interface ConnectorFields {
  platform: ConnectorPlatform;
  url: string;
  currency?: string;
  importPolicies: boolean;
}

/** The form with what the server's connector record adds to the signed settings. */
export function withConnector(form: StoreForm, connector: ConnectorFields | null): StoreForm {
  if (connector === null) {
    return form;
  }
  return {
    ...form,
    feedUrl: connector.platform === 'google' ? connector.url : '',
    connectorCurrency: connector.currency ?? '',
    importPolicies: connector.importPolicies,
  };
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * The connector the form sets up, checked; undefined when the product source
 * is not a connector. The shop's address is the signed one, so the two never
 * disagree; a feed's lives only here.
 */
export function connectorOf(form: StoreForm): ConnectorFields | undefined {
  if (form.source !== 'connector') {
    return undefined;
  }
  let url: string | undefined;
  if (form.platform === 'google') {
    url = httpsUrl(form.feedUrl.trim());
    if (url === undefined) {
      throw new FormError('Feed address: paste the https address of your product feed.');
    }
  } else {
    url = normalizeShopUrl(withHttps(form.shopUrl.trim()));
    if (url === undefined) {
      throw new FormError("Shop address: paste your shop's https address.");
    }
  }
  const currency = form.connectorCurrency.trim().toUpperCase();
  if (currency !== '' && !CURRENCY_RE.test(currency)) {
    throw new FormError('Currency override: three letters, like USD or EUR.');
  }
  return {
    platform: form.platform,
    url,
    ...(currency === '' ? {} : { currency }),
    importPolicies: form.platform === 'shopify' ? form.importPolicies : false,
  };
}

/** The longest address the server keeps for a connector. */
const MAX_CONNECTOR_URL_CHARS = 2_048;

/** `value` when it is an https URL the server takes, else undefined. */
function httpsUrl(value: string): string | undefined {
  if (value.length > MAX_CONNECTOR_URL_CHARS) {
    return undefined;
  }
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

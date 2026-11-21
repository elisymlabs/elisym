/**
 * `askr init` (5.1): the profile's owner key, the store, its signed settings
 * and the hosted authorization of server K, and the connector the settings
 * name. Every step is idempotent: a re-run resumes after any failure. It never
 * chooses a plan; a new store ends pending.
 */
import type {
  ConnectorPlatform,
  ProductSource,
  StoreConfig,
  StorePrivateConfig,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey } from 'nostr-tools/pure';
import { CONTACT_URL } from './constants';
import { AskrExit, EXIT, type CommandOutcome } from './errors';
import { invalidFlag, readFlagFile } from './files';
import { type OwnerKey, readImportedKey, readOwnerKey, sameKey, saveOwnerKey } from './owner-key';
import { readSigned } from './read';
import type { ApiRefusal, Session } from './session';
import { type SettingsValues, configInputOf, signSettings } from './signing';
import {
  CONTACT_HINT,
  awaitingPlanOf,
  movedExit,
  readView,
  refusalExit,
  PAID_CHECKOUT,
  tierOf,
  stoppedKinds,
  upgradeOf,
  waitPublished,
} from './store';
import type { ConnectorView, StoreView } from './types';

export interface InitOptions {
  name?: string;
  origin?: string[];
  language?: string;
  currency?: string;
  source?: string;
  platform?: string;
  shopUrl?: string;
  feedUrl?: string;
  displayName?: string;
  greeting?: string;
  contact?: string;
  voiceFile?: string;
  instructionsFile?: string;
  ownerKeyFile?: string;
  update?: boolean;
}

const DEFAULT_LANGUAGE = 'en';
const DEFAULT_CURRENCY = 'USD';
const LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//iu;
const BARE_HOST_RE = /^[^\s/:]+\.[^\s/:]+(?::\d+)?(?:\/.*)?$/u;
const MAX_URL_CHARS = 2_048;
const NEXT_PLAN = `choose a plan: Free via askr plan free, only if the human chose Free; a paid plan: message us at ${CONTACT_URL} with your Store ID and the name of the plan the human chose`;
/** The same, when the server takes payments: a paid plan is a checkout link for the human. */
const NEXT_PLAN_BILLING = `choose a plan: Free via askr plan free, only if the human chose Free; a paid plan: ${PAID_CHECKOUT}`;
const STOPPED_HINT = 'report this to us with your Store ID';

/** The flags as checked before anything else happens. */
interface Flags {
  name?: string;
  origins?: string[];
  language?: string;
  currency?: string;
  source?: 'admin' | 'connector';
  platform?: ConnectorPlatform;
  shopUrl?: string;
  feedUrl?: string;
  displayName?: string;
  greeting?: string;
  contact?: string;
  voice?: string;
  instructions?: string;
}

/** `https://` in front of a bare host, as the admin reads one (`withHttps`). */
function withHttps(value: string): string {
  return !SCHEME_RE.test(value) && BARE_HOST_RE.test(value) ? `https://${value}` : value;
}

function originOf(value: string): string {
  let url: URL;
  try {
    url = new URL(withHttps(value.trim()));
  } catch {
    throw invalidFlag('--origin', `"${value}" is not a web address`);
  }
  if (url.protocol !== 'https:') {
    throw invalidFlag('--origin', `"${value}" must start with https://`);
  }
  return url.origin;
}

function httpsUrlOf(value: string, flag: string): string {
  try {
    if (value.length <= MAX_URL_CHARS && new URL(value).protocol === 'https:') {
      return value;
    }
  } catch {
    // Reported below.
  }
  throw invalidFlag(flag, 'an https address');
}

/** `--greeting ""` clears it; a value is trimmed. */
function optionalText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.trim();
}

async function checkFlags(session: Session, options: InitOptions): Promise<Flags> {
  const { LIMITS, CONNECTOR_PLATFORMS } = session.askr;
  const flags: Flags = {};
  // An imported key is kept out of what the voice and instructions files send, as the local ones are.
  const imported =
    options.ownerKeyFile === undefined ? [] : [await readImportedKey(options.ownerKeyFile)];
  if (options.name !== undefined) {
    const name = options.name.trim();
    if (name === '' || name.length > LIMITS.TITLE_CHARS) {
      throw invalidFlag('--name', `1 to ${LIMITS.TITLE_CHARS} characters`);
    }
    flags.name = name;
  }
  if (options.origin !== undefined && options.origin.length > 0) {
    const origins = [...new Set(options.origin.map((value) => originOf(value)))];
    if (origins.length > LIMITS.MAX_ORIGINS) {
      throw invalidFlag('--origin', `at most ${LIMITS.MAX_ORIGINS} origins`);
    }
    flags.origins = origins;
  }
  if (options.language !== undefined) {
    if (!LANGUAGE_RE.test(options.language) || options.language.length > LIMITS.LOCALE_CHARS) {
      throw invalidFlag('--language', 'a BCP 47 tag such as en or de-CH');
    }
    flags.language = options.language;
  }
  if (options.currency !== undefined) {
    const currency = options.currency.trim().toUpperCase();
    if (!CURRENCY_RE.test(currency)) {
      throw invalidFlag('--currency', 'an ISO 4217 code such as USD or EUR');
    }
    flags.currency = currency;
  }
  if (options.source !== undefined) {
    if (options.source !== 'admin' && options.source !== 'connector') {
      throw invalidFlag('--source', 'admin or connector');
    }
    flags.source = options.source;
  }
  if (options.platform !== undefined) {
    const platform = CONNECTOR_PLATFORMS.find((known) => known === options.platform);
    if (platform === undefined) {
      throw invalidFlag('--platform', CONNECTOR_PLATFORMS.join(', '));
    }
    flags.platform = platform;
  }
  if (options.shopUrl !== undefined) {
    const shopUrl = session.askr.normalizeShopUrl(withHttps(options.shopUrl.trim()));
    if (shopUrl === undefined) {
      throw invalidFlag('--shop-url', 'the https address of the shop, like https://shop.example');
    }
    flags.shopUrl = shopUrl;
  }
  if (options.feedUrl !== undefined) {
    flags.feedUrl = httpsUrlOf(options.feedUrl.trim(), '--feed-url');
  }
  const displayName = optionalText(options.displayName);
  if (displayName !== undefined) {
    if (displayName.length > LIMITS.TITLE_CHARS) {
      throw invalidFlag('--display-name', `at most ${LIMITS.TITLE_CHARS} characters`);
    }
    flags.displayName = displayName;
  }
  const greeting = optionalText(options.greeting);
  if (greeting !== undefined) {
    if (greeting.length > LIMITS.GREETING_CHARS) {
      throw invalidFlag('--greeting', `at most ${LIMITS.GREETING_CHARS} characters`);
    }
    flags.greeting = greeting;
  }
  const contact = optionalText(options.contact);
  if (contact !== undefined) {
    flags.contact = contact === '' ? '' : httpsUrlOf(contact, '--contact');
  }
  if (options.voiceFile !== undefined) {
    flags.voice = await readFlagFile(
      options.voiceFile,
      '--voice-file',
      session.deps.home,
      imported,
    );
    if (flags.voice.length > LIMITS.CONFIG_VOICE_CHARS) {
      throw invalidFlag('--voice-file', `at most ${LIMITS.CONFIG_VOICE_CHARS} characters`);
    }
  }
  if (options.instructionsFile !== undefined) {
    flags.instructions = await readFlagFile(
      options.instructionsFile,
      '--instructions-file',
      session.deps.home,
      imported,
    );
    if (flags.instructions.length > LIMITS.CONFIG_INSTRUCTIONS_CHARS) {
      throw invalidFlag(
        '--instructions-file',
        `at most ${LIMITS.CONFIG_INSTRUCTIONS_CHARS} characters`,
      );
    }
  }
  return flags;
}

function missingNameOrOrigins(): AskrExit {
  return new AskrExit(EXIT.BAD_INPUT, 'missing_flag', {
    hint: 'a new store needs --name and at least one --origin',
  });
}

function otherKey(path: string): AskrExit {
  return new AskrExit(EXIT.KEY, 'profile_has_other_key', {
    hint: 'this profile already holds another owner key: use --profile <name> for the imported store',
    fields: { ownerKeyFile: path },
  });
}

/**
 * An imported key must be a store's owner key: a file holding only a public
 * key (a Store ID in hex, an `owner` field) would otherwise be taken as a new
 * secret key whose store anyone can control. Checked before it is saved.
 */
async function requireStoreOf(session: Session, secretKey: Uint8Array): Promise<void> {
  session.signAs(secretKey);
  const read = await session.call('GET', '/v1/admin/store');
  if (read.ok) {
    return;
  }
  if (read.status === 409 && read.code === 'moved') {
    throw new AskrExit(EXIT.REFUSED, 'moved_store', {
      hint: "this key's store moved to another owner key and now lives there: import that key's file instead, or sign in to the admin with it",
    });
  }
  if (read.status === 404 && read.code === 'no_store') {
    throw new AskrExit(EXIT.KEY, 'no_store_for_key', {
      hint: "no store has this key: the file must hold the store's secret key (nsec), not its Store ID or public key",
    });
  }
  throw refusalExit(session, read);
}

/**
 * The profile's key: the one it holds, the imported one (once the server
 * shows it owns a store), or a new one saved before any call (step 2).
 */
async function ownerKeyFor(session: Session, options: InitOptions): Promise<OwnerKey> {
  const imported =
    options.ownerKeyFile === undefined ? undefined : await readImportedKey(options.ownerKeyFile);
  const existing = await readOwnerKey(session.deps.home, session.profile);
  if (existing !== undefined) {
    if (imported !== undefined && !sameKey(imported, existing.secretKey)) {
      throw otherKey(existing.path);
    }
    return existing;
  }
  if (imported !== undefined) {
    await requireStoreOf(session, imported);
  }
  const candidate = imported ?? generateSecretKey();
  const saved = await saveOwnerKey(
    session.deps.home,
    session.profile,
    candidate,
    session.nowSecs(),
    session.deps.keyFileOps,
  );
  if (imported !== undefined && !sameKey(imported, saved.secretKey)) {
    throw otherKey(saved.path);
  }
  return saved;
}

/** The store of this key: opened, or created pending (step 3). */
async function openStore(session: Session): Promise<{ view: StoreView; created: boolean }> {
  const read = await session.call<StoreView>('GET', '/v1/admin/store');
  if (read.ok) {
    return { view: read.body, created: false };
  }
  if (read.status !== 404 || read.code !== 'no_store') {
    throw refusalExit(session, read);
  }
  const made = await session.call<StoreView>('POST', '/v1/admin/store');
  if (made.ok) {
    return { view: made.body, created: true };
  }
  if (made.status === 429) {
    throw new AskrExit(EXIT.REFUSED, 'rate_limited', {
      hint: 'too many new stores from this network; try again in an hour',
    });
  }
  throw refusalExit(session, made);
}

/** Settings in one comparable form: what a config says, private part included. */
function comparable(values: SettingsValues, assistant: string): string {
  return JSON.stringify({
    assistant,
    origins: values.origins,
    linkOrigins: values.linkOrigins,
    name: values.name,
    displayName: values.displayName,
    greeting: values.greeting,
    language: values.language,
    currency: values.currency,
    source: {
      kind: values.source.kind,
      platform: values.source.platform,
      shopUrl: values.source.shopUrl,
    },
    catalogKey: values.catalogKey,
    policyKey: values.policyKey,
    contact: values.contact,
    private: {
      voice: values.private.voice,
      instructions: values.private.instructions,
      notes: values.private.notes,
    },
  });
}

function valuesOfConfig(config: StoreConfig, privatePart: StorePrivateConfig): SettingsValues {
  return {
    name: config.name,
    origins: config.origins,
    linkOrigins: config.linkOrigins,
    language: config.language,
    currency: config.currency,
    source: config.source,
    catalogKey: config.catalogKey,
    policyKey: config.policyKey,
    ...(config.displayName === undefined ? {} : { displayName: config.displayName }),
    ...(config.greeting === undefined ? {} : { greeting: config.greeting }),
    ...(config.contact === undefined ? {} : { contact: config.contact }),
    private: privatePart,
  };
}

function sameOrigins(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((origin) => right.includes(origin));
}

/** Empty text given as a flag clears an optional field. */
function optionalField(flag: string | undefined, previous: string | undefined): string | undefined {
  const value = flag ?? previous;
  return value === undefined || value === '' ? undefined : value;
}

interface Merged {
  values: SettingsValues;
  /** Google's feed address, kept by the connector only. */
  feedUrl?: string;
}

/** The previous config with the flags applied, checked as the admin checks before it signs (step 7). */
function merge(
  session: Session,
  flags: Flags,
  view: StoreView,
  previous: { config: StoreConfig; privatePart: StorePrivateConfig } | undefined,
): Merged {
  const serverKey = view.catalogKey;
  const config = previous?.config;
  const name = flags.name ?? config?.name;
  const origins = flags.origins ?? config?.origins;
  if (name === undefined || origins === undefined) {
    throw missingNameOrOrigins();
  }
  const kind = flags.source ?? (config?.source.kind === 'connector' ? 'connector' : 'admin');
  const source: ProductSource = { kind };
  let feedUrl: string | undefined;
  if (kind === 'connector') {
    const platform =
      flags.platform ?? (config?.source.kind === 'connector' ? config.source.platform : undefined);
    if (platform === undefined) {
      throw new AskrExit(EXIT.BAD_INPUT, 'missing_flag', {
        hint: '--source connector needs --platform shopify, woocommerce or google',
      });
    }
    source.platform = platform;
    if (platform === 'google') {
      feedUrl =
        flags.feedUrl ?? (view.connector?.platform === 'google' ? view.connector.url : undefined);
      if (feedUrl === undefined) {
        throw new AskrExit(EXIT.BAD_INPUT, 'missing_flag', {
          hint: '--platform google needs --feed-url with the https address of the product feed',
        });
      }
    } else {
      const shopUrl = flags.shopUrl ?? config?.source.shopUrl;
      if (shopUrl === undefined) {
        throw new AskrExit(EXIT.BAD_INPUT, 'missing_flag', {
          hint: `--platform ${platform} needs --shop-url with the https address of the shop`,
        });
      }
      const shopOrigin = new URL(shopUrl).origin;
      if (!origins.includes(shopOrigin)) {
        throw invalidFlag(
          '--shop-url',
          `add ${shopOrigin} as an --origin, so the chat can add to its cart`,
        );
      }
      source.shopUrl = shopUrl;
    }
  }
  // As the admin's `sourceKeysOf`: server K holds the products and, unless the previous config
  // kept another policy key for the same source and key, the policies.
  const values: SettingsValues = {
    name,
    origins,
    linkOrigins: config?.linkOrigins ?? [],
    language: flags.language ?? config?.language ?? DEFAULT_LANGUAGE,
    currency: flags.currency ?? config?.currency ?? DEFAULT_CURRENCY,
    source,
    catalogKey: serverKey,
    policyKey:
      config !== undefined && config.source.kind === kind && config.catalogKey === serverKey
        ? config.policyKey
        : serverKey,
    private: {
      voice: flags.voice ?? previous?.privatePart.voice ?? '',
      instructions: flags.instructions ?? previous?.privatePart.instructions ?? '',
      notes: previous?.privatePart.notes ?? '',
    },
  };
  const displayName = optionalField(flags.displayName, config?.displayName);
  const greeting = optionalField(flags.greeting, config?.greeting);
  const contact = optionalField(flags.contact, config?.contact);
  if (displayName !== undefined) {
    values.displayName = displayName;
  }
  if (greeting !== undefined) {
    values.greeting = greeting;
  }
  if (contact !== undefined) {
    values.contact = contact;
  }
  const checked = session.askr.StoreConfigInputSchema.safeParse(
    configInputOf(values, view.nextAssistant ?? view.assistant, session.nowSecs()),
  );
  if (!checked.success) {
    const [issue] = checked.error.issues;
    throw new AskrExit(EXIT.BAD_INPUT, 'invalid_settings', {
      hint: `${String(issue?.path[0] ?? 'settings')}: ${issue?.message ?? 'not valid'}`,
    });
  }
  return feedUrl === undefined ? { values } : { values, feedUrl };
}

function eventsRefusal(session: Session, result: ApiRefusal): AskrExit {
  if (result.code === 'bad_event') {
    const reason = typeof result.detail.reason === 'string' ? result.detail.reason : 'unknown';
    if (reason === 'config_assistant') {
      return session.notDone('bad_event', {
        hint: 'the assistant key rotated meanwhile: run the resume command, it signs for the new one',
        fields: { reason },
      });
    }
    if (reason === 'stale_config') {
      return session.notDone('bad_event', {
        hint: 'the server holds newer settings (saved in the admin meanwhile?): run the resume command, it merges onto them',
        fields: { reason },
      });
    }
    return new AskrExit(EXIT.REFUSED, 'bad_event', {
      hint:
        reason === 'future'
          ? "check this computer's clock: a signed event is dated in the future"
          : 'the server refused a signed event',
      fields: { reason },
    });
  }
  if (result.code === 'too_many_events') {
    return new AskrExit(EXIT.REFUSED, 'too_many_events', {
      hint: 'too many signed changes are waiting: wait until they are published, then run again',
    });
  }
  return refusalExit(session, result);
}

/** The connector follows the settings, on every run, as an admin save does (step 9). */
async function reconcileConnector(
  session: Session,
  merged: Merged,
  before: ConnectorView | null,
): Promise<ConnectorView | null> {
  const { source } = merged.values;
  if (source.kind !== 'connector' || source.platform === undefined) {
    if (before !== null) {
      const removed = await session.call('DELETE', '/v1/admin/connector');
      if (!removed.ok) {
        throw refusalExit(session, removed);
      }
    }
    return null;
  }
  const url = source.platform === 'google' ? merged.feedUrl : source.shopUrl;
  if (url === undefined) {
    return before;
  }
  const result = await session.call<{ connector: ConnectorView | null }>(
    'PUT',
    '/v1/admin/connector',
    {
      platform: source.platform,
      url,
      ...(before?.currency === undefined ? {} : { currency: before.currency }),
      importPolicies: source.platform === 'shopify' ? (before?.importPolicies ?? true) : false,
    },
  );
  if (!result.ok) {
    throw refusalExit(session, result);
  }
  return result.body.connector;
}

export async function runInit(session: Session, options: InitOptions): Promise<CommandOutcome> {
  const flags = await checkFlags(session, options);
  // No key and none to import: certainly a new store, which needs its name and sites.
  const newStore =
    options.ownerKeyFile === undefined &&
    (await readOwnerKey(session.deps.home, session.profile)) === undefined;
  if (newStore && (flags.name === undefined || flags.origins === undefined)) {
    throw missingNameOrOrigins();
  }
  const key = await ownerKeyFor(session, options);
  session.signAs(key.secretKey);
  const opened = await openStore(session);
  let view = opened.view;
  const signed = await readSigned(session, key.owner, key.secretKey);
  if (view.movedFrom !== null && signed.config === undefined) {
    throw movedExit();
  }
  if (signed.config?.source.kind === 'catalog') {
    throw new AskrExit(EXIT.REFUSED, 'catalog_source', {
      hint: 'this store takes its products from its own catalog key: manage it in the admin',
    });
  }
  if (signed.config !== undefined && options.update !== true) {
    const nameChanged = flags.name !== undefined && flags.name !== signed.config.name;
    const originsChanged =
      flags.origins !== undefined && !sameOrigins(flags.origins, signed.config.origins);
    if (nameChanged || originsChanged) {
      throw new AskrExit(EXIT.EXISTING_STORE, 'existing_store', {
        hint: 'update it with --update, or use --profile <name> for a separate store',
        fields: {
          existingStore: key.storeId,
          name: signed.config.name,
          origins: signed.config.origins,
        },
      });
    }
  }
  if (signed.config !== undefined && signed.privatePart === undefined) {
    throw new AskrExit(EXIT.REFUSED, 'config_unreadable', {
      hint: "the store's assistant settings cannot be read back: open the admin",
    });
  }
  const previous =
    signed.config !== undefined && signed.privatePart !== undefined
      ? { config: signed.config, privatePart: signed.privatePart }
      : undefined;
  const merged = merge(session, flags, view, previous);
  const assistant = view.nextAssistant ?? view.assistant;
  const now = session.nowSecs();
  const stopped = stoppedKinds(view);
  const configChanged =
    previous === undefined ||
    stopped.includes(session.askr.KIND_CONFIG) ||
    comparable(merged.values, assistant) !==
      comparable(valuesOfConfig(previous.config, previous.privatePart), previous.config.assistant);
  const authMissing =
    !signed.authorized.has(view.catalogKey) || stopped.includes(session.askr.KIND_CATALOG_AUTH);
  const events: NostrEvent[] = signSettings({
    askr: session.askr,
    secretKey: key.secretKey,
    ...(configChanged
      ? {
          config: configInputOf(
            merged.values,
            assistant,
            Math.max(now, (previous?.config.createdAt ?? 0) + 1),
          ),
        }
      : {}),
    ...(authMissing
      ? {
          authorize: {
            key: view.catalogKey,
            createdAt: Math.max(now, (signed.authNewestAt.get(view.catalogKey) ?? 0) + 1),
          },
        }
      : {}),
  });
  if (events.length > 0) {
    const posted = await session.call('POST', '/v1/admin/store/events', { events });
    if (!posted.ok) {
      throw eventsRefusal(session, posted);
    }
  }
  const connector = await reconcileConnector(session, merged, view.connector);
  let published = false;
  if (view.status === 'active') {
    view = await readView(session);
    const waited = await waitPublished(
      session,
      view,
      (stoppedView) =>
        new AskrExit(EXIT.REFUSED, 'publish_stopped', {
          hint: STOPPED_HINT,
          fields: { kinds: stoppedKinds(stoppedView) },
        }),
    );
    if (!waited.published) {
      throw session.notDone('publication_pending', {
        hint: 'the settings are stored but not published yet: run the resume command in about a minute',
        fields: { published: false },
      });
    }
    view = waited.view;
    published = true;
  }
  const awaitingPlan = awaitingPlanOf(view);
  const output: Record<string, unknown> = {
    ok: true,
    profile: session.profile,
    storeId: key.storeId,
    status: view.status,
    tier: tierOf(view),
    awaitingPlan,
    created: opened.created,
    config: configChanged ? 'signed' : 'unchanged',
    authorization: authMissing ? 'signed' : 'present',
    connector:
      connector === null ? null : { platform: connector.platform, enabled: connector.enabled },
    published,
    ownerKeyFile: key.path,
    adminUrl: session.adminUrl,
  };
  if (awaitingPlan) {
    output.next = view.billing?.checkoutAvailable === true ? NEXT_PLAN_BILLING : NEXT_PLAN;
    output.upgrade = upgradeOf(view.billing, session.adminUrl);
  } else if (view.status !== 'active') {
    output.hint = CONTACT_HINT;
  }
  return { exitCode: EXIT.OK, output };
}

import {
  ASKR_RELAYS,
  CONNECTOR_PLATFORMS,
  type CatalogItemInput,
  CatalogItemInputSchema,
  D_TAG_RE,
  KIND_CATALOG_AUTH,
  CONFIG_D_TAG,
  KIND_CONFIG,
  LIMITS,
  PolicyInputSchema,
  SHOPIFY_POLICY_SLUGS,
  type SyncDiff,
  type StoreConfig,
  type SyncRelayClient,
  decryptPrivateConfig,
  parseConfig,
  removePolicy,
  setPolicy,
  syncCatalog,
} from '@elisym/askr';
import { HEX_PUBKEY_RE, KIND_PRODUCT } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { decode } from 'nostr-tools/nip19';
import { verifyEvent } from 'nostr-tools/pure';
import * as z from 'zod';
import { type FreeTier, publicBaseOf } from '../config';
import { livePolicies } from '../connectors/policies';
import { type ConnectorService, shopIdentity } from '../connectors/service';
import { SYNC_HOLD_SECS, SYNC_RENEW_MS } from '../constants';
import type { GatewayRequest } from '../gateway/gateway';
import { WindowLimiter, ipKey } from '../gateway/limits';
import { budgetReached } from '../state/budget';
import { randomId } from '../state/pg-state';
import { type CatalogSyncEnd, proofOrigins, type StoreDirectory } from '../state/stores';
import type { StoreRecord } from '../state/types';
import { AUTH_WINDOW_SECS, checkNip98 } from './nip98';

export const ADMIN_PREFIX = '/v1/admin/';
const KIND_DELETION = 5;
/** New stores one client address may create per hour (the onboarding needs one). */
const NEW_STORES_PER_IP_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
/** Owner key replacements one client address may try per hour (K21): each reads shop sites. */
const RECOVERIES_PER_IP_PER_HOUR = 10;
const MAX_EVENTS_PER_REQUEST = 20;
const MAX_EVENT_BYTES = 64 * 1024;
/**
 * `GET /v1/admin/store/events` answers with at most this much event JSON:
 * well above a store's settings and authorizations, far below what one
 * request may post (20 events of 64 KiB).
 */
export const MAX_READ_BACK_BYTES = 1024 * 1024;
/** A stored event may be dated at most this far ahead (clock skew of the signer). */
const MAX_AHEAD_SECS = 10 * 60;
const POLICY_PATH_RE = /^\/v1\/admin\/policies\/([a-z0-9-]{1,64})$/;

const RecoverRequestSchema = z.object({
  from: z.string().max(100),
  dryRun: z.boolean().optional(),
});

/** A shop's address as the connector compares it (origin and path), https only. */
function httpsShopIdentity(url: string): string | undefined {
  return url.startsWith('https://') ? shopIdentity(url) : undefined;
}

/** An owner key as hex, from hex or an npub; undefined for anything else. */
function ownerKeyOf(value: string): string | undefined {
  const trimmed = value.trim();
  if (HEX_PUBKEY_RE.test(trimmed.toLowerCase())) {
    return trimmed.toLowerCase();
  }
  try {
    const decoded = decode(trimmed);
    return decoded.type === 'npub' ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

const EventSchema = z.object({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number().int(),
  kind: z.number().int(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string(),
});

const EventsRequestSchema = z.object({
  events: z.array(EventSchema).min(1).max(MAX_EVENTS_PER_REQUEST),
});

/** A bound on `hide`; the 8 MB body cap usually ends a long list first. */
const MAX_HIDE = 100_000;

/**
 * `replace` (default): `items` is the whole catalog. `upsert`: `items` are the
 * new and changed products and `hide` the removed ones; every other product
 * stays as it is, so the admin sends only what changed.
 */
const CatalogRequestSchema = z.object({
  items: z.array(z.unknown()),
  dryRun: z.boolean().optional(),
  mode: z.enum(['replace', 'upsert']).optional(),
  hide: z.array(z.string().regex(D_TAG_RE)).max(MAX_HIDE).optional(),
});

/**
 * Every product ID K lists on the relay, hidden ones included (a replace
 * counts hidden products too): a valid `d` whose newest signed version,
 * however dated, is not deleted (NIP-09) at or after it. The admin reads the
 * same IDs (`readCatalog`) and removes the ones its draft does not hold.
 */
async function listedOnRelay(client: SyncRelayClient, key: string): Promise<Set<string>> {
  const events = await client.query(ASKR_RELAYS, {
    kinds: [KIND_PRODUCT, KIND_DELETION],
    authors: [key],
  });
  const genuine = events.filter((event) => event.pubkey === key && verifyEvent(event));
  const newest = new Map<string, number>();
  for (const event of genuine) {
    const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
    if (event.kind === KIND_PRODUCT && d !== undefined && D_TAG_RE.test(d)) {
      newest.set(d, Math.max(newest.get(d) ?? -1, event.created_at));
    }
  }
  const deletedAt = new Map<string, number>();
  const prefix = `${KIND_PRODUCT}:${key}:`;
  for (const event of genuine) {
    if (event.kind !== KIND_DELETION) {
      continue;
    }
    for (const tag of event.tags) {
      if (tag[0] === 'a' && tag[1]?.startsWith(prefix)) {
        const d = tag[1].slice(prefix.length);
        deletedAt.set(d, Math.max(deletedAt.get(d) ?? -1, event.created_at));
      }
    }
  }
  return new Set([...newest].flatMap(([d, at]) => ((deletedAt.get(d) ?? -1) >= at ? [] : [d])));
}

const PolicyRequestSchema = z.object({ title: z.string(), body: z.string() });

/** An address the operator can write to: one @, a dot in the domain, no spaces, at most 254 chars. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MAX_EMAIL_LENGTH = 254;
const EmailSchema = z
  .string()
  .trim()
  .max(MAX_EMAIL_LENGTH)
  .regex(EMAIL_RE)
  .transform((email) => email.toLowerCase());
/** `PUT /v1/admin/store/contact`: null clears it. */
const ContactRequestSchema = z.object({ email: EmailSchema.nullable() });
/** `POST /v1/admin/store`: onboarding may give the contact email at once. */
const CreateRequestSchema = z.object({ email: EmailSchema.optional() });
/** Only Free is self-serve; a paid plan goes through us until a checkout answers here (6.1). */
const PlanRequestSchema = z.object({ plan: z.literal('free') });

/** What `POST /v1/admin/store/plan` did, beside the view it answers with (6.1). */
export type Activation = 'activated' | 'already_active';

const ConnectorRequestSchema = z.object({
  platform: z.enum(CONNECTOR_PLATFORMS),
  url: z.string().url().max(2048),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  importPolicies: z.boolean().optional(),
});

export interface AdminDeps {
  directory: StoreDirectory;
  /** The configured public base, e.g. `https://app.askr.elisym.network`: NIP-98 `u` is compared with it (7.3). */
  publicBase: string;
  syncClient: SyncRelayClient;
  /** Called after O-signed events were stored, so an active store's are published at once. */
  storeEventsChanged: () => void;
  connectors: ConnectorService;
  /** ASKR_FREE_TIER: the tier a merchant's explicit Free choice puts a store on, within the caps (6.1). */
  freeTier?: FreeTier;
  now?: () => number;
  /** Publishing pace for catalog syncs; tests raise it. */
  syncPace?: number;
  log?: (message: string) => void;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** Why an event O wants stored is refused, or undefined when it may be stored (7.3). */
function refusal(
  event: NostrEvent,
  store: StoreRecord,
  nextAssistant: string | undefined,
  now: number,
): string | undefined {
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) {
    return 'too_large';
  }
  if (event.pubkey !== store.owner || !verifyEvent(event)) {
    return 'signature';
  }
  if (event.created_at > now + MAX_AHEAD_SECS) {
    return 'future';
  }
  if (event.kind === KIND_CONFIG) {
    const assistant = parseConfig(event)?.assistant;
    return assistant === store.assistant || (assistant !== undefined && assistant === nextAssistant)
      ? undefined
      : 'config_assistant';
  }
  if (event.kind === KIND_CATALOG_AUTH) {
    const key = event.tags.find((tag) => tag[0] === 'd')?.[1];
    return key !== undefined && HEX_PUBKEY_RE.test(key) ? undefined : 'auth_key';
  }
  if (event.kind === KIND_DELETION) {
    const ours = [`${KIND_CONFIG}:${store.owner}:`, `${KIND_CATALOG_AUTH}:${store.owner}:`];
    const addresses = event.tags.filter((tag) => tag[0] === 'a');
    const onlyOurs =
      addresses.length > 0 &&
      event.tags.every((tag) => tag[0] !== 'e') &&
      addresses.every((tag) => ours.some((prefix) => tag[1]?.startsWith(prefix) === true));
    return onlyOurs ? undefined : 'deletion_target';
  }
  return 'kind';
}

/**
 * The admin API (7.3): every call, reads included, carries a NIP-98
 * authorization by O, accepted once within the window; it acts only on O's
 * own store. Catalog and policy writes are signed by the store's server K
 * and only for an `active` store (K19). Returns undefined for other paths.
 */
export function createAdminApi(
  deps: AdminDeps,
): (input: GatewayRequest) => Promise<Response | undefined> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  // `https://app.askr.elisym.network/` and without the slash name the same base.
  const publicBase = publicBaseOf(deps.publicBase);
  const log = deps.log ?? (() => undefined);

  /**
   * Run `work` holding the store's catalog sync guard, shared by every
   * instance through the database (7.3, 7.4): one catalog sync or connector
   * preview per store at a time. Undefined when another holds it. `work`
   * gets the guard's holder id and gives the guard up through `release`.
   */
  const withSyncGuard = async (
    owner: string,
    work: (holder: string, release: (ended?: CatalogSyncEnd) => Promise<void>) => Promise<Response>,
  ): Promise<Response | undefined> => {
    const holder = randomId();
    if (!(await deps.directory.claimCatalogSync(owner, holder, now(), SYNC_HOLD_SECS))) {
      return undefined;
    }
    const renewal = setInterval(() => {
      deps.directory.renewCatalogSync(owner, holder, now(), SYNC_HOLD_SECS).then(
        (held) => {
          if (!held) {
            log(`catalog sync guard of ${owner} was lost while its sync ran`);
          }
        },
        (error: unknown) => log(`catalog sync guard renewal failed: ${errorText(error)}`),
      );
    }, SYNC_RENEW_MS);
    let released = false;
    const release = async (ended?: CatalogSyncEnd) => {
      if (released) {
        return;
      }
      released = true;
      clearInterval(renewal);
      await deps.directory.releaseCatalogSync(owner, holder, now(), ended);
    };
    try {
      return await work(holder, release);
    } catch (error) {
      await release();
      throw error;
    }
  };

  /**
   * The newest genuine config `owner` signed: on the relay, or stored here
   * and not published yet.
   */
  const newestConfigOf = async (
    owner: string,
  ): Promise<{ config: StoreConfig; event: NostrEvent } | undefined> => {
    const relayEvents = await deps.syncClient.query(ASKR_RELAYS, {
      kinds: [KIND_CONFIG],
      authors: [owner],
      '#d': [CONFIG_D_TAG],
    });
    const stored = (await deps.directory.storedEvents(owner, MAX_READ_BACK_BYTES)).events;
    let newest: { config: StoreConfig; event: NostrEvent } | undefined;
    for (const event of [...relayEvents, ...stored]) {
      // Dated far ahead, a config would outrank every later one: a thief's trick, never the owner's.
      if (
        event.kind !== KIND_CONFIG ||
        event.pubkey !== owner ||
        event.created_at > now() + MAX_AHEAD_SECS ||
        !verifyEvent(event)
      ) {
        continue;
      }
      const config = parseConfig(event);
      if (
        config !== undefined &&
        (newest === undefined || config.createdAt > newest.config.createdAt)
      ) {
        newest = { config, event };
      }
    }
    return newest;
  };

  const recoveriesPerIp = new WindowLimiter(RECOVERIES_PER_IP_PER_HOUR, HOUR_MS);
  /** Replacements (store and new key) whose site reads run now, on this instance. */
  const proving = new Set<string>();

  /**
   * Replace a store's owner key (K21, 1.6): `owner` is the new key O', which
   * signed the request; `from` a key the store had. One of the sites the store
   * has had long enough, and listed lately (`proofOrigins`), must name O'.
   * `dryRun` checks everything but the site, so the admin can say what stands
   * in the way before the merchant edits their site. No limit per store: its
   * ID is public, and a limit anyone can use up would lock its owner out.
   */
  const recover = async (owner: string, body: string, clientAddress: string): Promise<Response> => {
    const parsed = RecoverRequestSchema.safeParse(parseJson(body));
    const asked = parsed.success ? ownerKeyOf(parsed.data.from) : undefined;
    if (asked === undefined || asked === owner) {
      return json({ error: 'bad_request' }, 400);
    }
    if (!recoveriesPerIp.hit(ipKey(clientAddress), now() * 1000)) {
      return json({ error: 'rate_limited' }, 429);
    }
    // A store that moved on is recovered where it is now: an owner can take it back from a thief.
    const from = (await deps.directory.movedTo(asked)) ?? asked;
    // The store is already on this key: a retry of a move whose answer was lost. Answer it again.
    if (from === owner) {
      const store = await deps.directory.store(owner);
      return store === undefined ? json({ error: 'no_store' }, 404) : json(await view(store), 200);
    }
    if (
      (await deps.directory.statusOf(owner)) !== undefined ||
      (await deps.directory.wasMoved(owner))
    ) {
      return json({ error: 'key_in_use' }, 409);
    }
    if ((await deps.directory.statusOf(from)) === undefined) {
      return json({ error: 'no_store' }, 404);
    }
    let settings: { config: StoreConfig; event: NostrEvent } | undefined;
    try {
      settings = await newestConfigOf(from);
    } catch {
      return json({ error: 'read_failed' }, 503);
    }
    const { origins, readyAt } = proofOrigins(await deps.directory.originsHeld(from), now());
    if (origins.length === 0) {
      return json({ error: 'no_site_yet', readyAt: readyAt ?? null }, 409);
    }
    if (parsed.success && parsed.data.dryRun === true) {
      return json({ ok: true }, 200);
    }
    // One proof at a time per store and new key: a double click reads the sites once, and
    // others' tries never hold up the owner's (moveStore settles a race between keys).
    const attempt = `${from}:${owner}`;
    if (proving.has(attempt)) {
      return json({ error: 'proof_running' }, 409);
    }
    proving.add(attempt);
    let proof: Awaited<ReturnType<typeof deps.connectors.proveSite>>;
    try {
      proof = await deps.connectors.proveSite(origins, owner);
    } finally {
      proving.delete(attempt);
    }
    if ('failures' in proof) {
      // Only the sites the settings list now are named: older ones stay private. A key that
      // signed nothing passes on the settings of the move before.
      const passedOn = (await deps.directory.movedFrom(from))?.config ?? null;
      const passedOnConfig = passedOn === null ? undefined : parseConfig(passedOn);
      const listed = new Set(settings?.config.origins ?? passedOnConfig?.origins ?? []);
      return json(
        {
          error: 'site_not_proven',
          failures: proof.failures.filter((failure) => listed.has(failure.origin)),
          unlisted: proof.failures.filter((failure) => !listed.has(failure.origin)).length,
        },
        409,
      );
    }
    // A key that signed nothing (moved on before it could) leaves the settings of the move before.
    const previous = settings?.event ?? (await deps.directory.movedFrom(from))?.config ?? undefined;
    const moved = await deps.directory.moveStore(from, owner, now(), previous);
    if (!moved.ok) {
      if (moved.reason === 'taken') {
        return json({ error: 'key_in_use' }, 409);
      }
      // Another replacement moved the store while this one read the site: retrying finds it.
      return moved.reason === 'moved'
        ? json({ error: 'moved_meanwhile' }, 409)
        : json({ error: 'no_store' }, 404);
    }
    log(`store ${from} moved to owner ${owner}, proven by ${proof.proven}`);
    const store = await deps.directory.store(owner);
    return store === undefined
      ? json({ error: 'no_store' }, 404)
      : json({ ...(await view(store)), proven: proof.proven }, 200);
  };

  const view = async (store: StoreRecord) => {
    const usage = await deps.directory.usage(store.owner, store.assistant, now());
    return {
      owner: store.owner,
      status: store.status,
      tier: store.tier ?? null,
      assistant: store.assistant,
      nextAssistant: (await deps.directory.nextAssistant(store.owner)) ?? null,
      catalogKey: store.catalogKey,
      usage,
      // The chat is paused once the plan's monthly budget is reached: the admin says so on every tab.
      budgetPaused: budgetReached(usage, store.tier) ? 'month' : null,
      catalogSync: await deps.directory.catalogSync(store.owner, now()),
      connector: (await deps.directory.connector(store.owner)) ?? null,
      events: await deps.directory.eventStatus(store.owner),
      movedFrom: (await deps.directory.movedFrom(store.owner))?.from ?? null,
      email: (await deps.directory.contactEmail(store.owner)) ?? null,
    };
  };

  const storeEvents = async (store: StoreRecord, body: string): Promise<Response> => {
    const parsed = EventsRequestSchema.safeParse(parseJson(body));
    if (!parsed.success) {
      return json({ error: 'bad_request' }, 400);
    }
    const nextAssistant = await deps.directory.nextAssistant(store.owner);
    const events: NostrEvent[] = parsed.data.events;
    for (const event of events) {
      const reason = refusal(event, store, nextAssistant, now());
      if (reason !== undefined) {
        return json({ error: 'bad_event', reason, id: event.id }, 400);
      }
    }
    const added = await deps.directory.addEvents(store.owner, events);
    if (!added.ok) {
      return added.reason === 'too_many_events'
        ? json({ error: 'too_many_events' }, 409)
        : json({ error: 'bad_event', reason: added.reason, id: added.id }, 400);
    }
    // Storing settings never activates a store: its owner chooses a plan (POST /store/plan, 6.1).
    deps.storeEventsChanged();
    return json({ stored: events.map((event) => event.id) }, 200);
  };

  /**
   * The answer for a store a Free choice does not (or no longer) apply to, by
   * its state now (6.1). A pending store without a tier qualifies under the
   * lock, so it lands here only if the store changed in a way the server cannot
   * tell: `read_failed`, retried.
   */
  const planRefused = async (store: StoreRecord): Promise<Response> => {
    if (store.status === 'active') {
      const activation: Activation = 'already_active';
      return json({ ...(await view(store)), activation }, 200);
    }
    if (store.status === 'suspended') {
      return json({ error: 'not_pending' }, 409);
    }
    if (store.tier !== undefined) {
      return json({ error: 'operator_managed' }, 409);
    }
    log(`store ${store.owner} is pending without a tier, yet its Free activation was refused`);
    return json({ error: 'read_failed' }, 503);
  };

  /**
   * The merchant chooses a plan (6.1): only Free is self-serve, and only for a
   * pending store that never had a tier and holds settings it can run on. Paid
   * plans go through us until a checkout answers here.
   */
  const choosePlan = async (store: StoreRecord, body: string): Promise<Response> => {
    const parsed = PlanRequestSchema.safeParse(parseJson(body));
    if (!parsed.success) {
      return json({ error: 'bad_request' }, 400);
    }
    if (store.status !== 'pending' || store.tier !== undefined) {
      return planRefused(store);
    }
    // Only settings a store can run on take a slot: a config that parses lists an origin.
    if (!(await deps.directory.hasStoredConfig(store.owner))) {
      return json({ error: 'no_settings' }, 409);
    }
    if (deps.freeTier === undefined) {
      return json({ error: 'free_unavailable' }, 409);
    }
    const { tier, perDay, maxActive } = deps.freeTier;
    const outcome = await deps.directory.activateFree(store.owner, tier, now(), {
      perDay,
      maxActive,
    });
    if (outcome === 'capacity_reached') {
      log(`store ${store.owner} not activated on ${tier}: a cap is reached`);
      return json({ error: 'capacity_reached' }, 409);
    }
    if (outcome === 'no_tier') {
      log(`store ${store.owner} not activated: the Free tier ${tier} does not exist`);
      return json({ error: 'free_unavailable' }, 409);
    }
    const current = await deps.directory.store(store.owner);
    if (current === undefined) {
      // Moved by a key replacement meanwhile: answered as every route answers a missing store.
      return (await deps.directory.wasMoved(store.owner))
        ? json({ error: 'moved' }, 409)
        : json({ error: 'no_store' }, 404);
    }
    if (outcome === null) {
      return planRefused(current);
    }
    log(`store ${store.owner} activated on ${tier}: its owner chose Free`);
    // So this instance publishes the stored events at once (the activation's notify also runs
    // the same handler, on every instance).
    deps.storeEventsChanged();
    const activation: Activation = 'activated';
    return json({ ...(await view(current)), activation }, 200);
  };

  const catalog = async (store: StoreRecord, body: string): Promise<Response> => {
    const parsed = CatalogRequestSchema.safeParse(parseJson(body));
    if (!parsed.success) {
      return json({ error: 'bad_request' }, 400);
    }
    const items = z.array(CatalogItemInputSchema).safeParse(parsed.data.items);
    if (!items.success) {
      return json({ error: 'invalid_items', issues: items.error.issues.slice(0, 20) }, 400);
    }
    const upsert = parsed.data.mode === 'upsert';
    if (!upsert && parsed.data.hide !== undefined) {
      return json({ error: 'bad_request' }, 400);
    }
    const hide = parsed.data.hide ?? [];
    const sent = new Set(items.data.map((item) => item.d));
    if (hide.some((d) => sent.has(d))) {
      return json({ error: 'bad_request', message: 'a product cannot be sent and hidden' }, 400);
    }
    const dryRun = parsed.data.dryRun === true;
    const change = upsert ? { mode: 'upsert' as const, hide } : {};
    const started = await withSyncGuard(store.owner, (holder, release) =>
      startSync(store, items.data, change, dryRun, holder, release),
    );
    return started ?? json({ error: 'sync_running' }, 409);
  };

  /**
   * The catalog's size after this request, or a refusal: a replace is its
   * items; an upsert is what K lists on the relay, changed as asked. Run
   * under the sync guard, so two requests cannot both pass against the same
   * catalog.
   */
  const overTier = async (
    store: StoreRecord,
    items: readonly CatalogItemInput[],
    change: { mode?: 'upsert'; hide?: string[] },
  ): Promise<Response | undefined> => {
    if (store.tier === undefined) {
      return undefined;
    }
    let total = items.length;
    if (change.mode === 'upsert') {
      let listed: Set<string>;
      try {
        listed = await listedOnRelay(deps.syncClient, store.catalogKey);
      } catch (error) {
        return json({ error: 'sync_refused', message: errorText(error) }, 409);
      }
      for (const d of change.hide ?? []) {
        listed.delete(d);
      }
      for (const item of items) {
        listed.add(item.d);
      }
      total = listed.size;
    }
    return total > store.tier.maxProducts
      ? json({ error: 'too_many_products', max: store.tier.maxProducts }, 400)
      : undefined;
  };

  const startSync = async (
    store: StoreRecord,
    items: CatalogItemInput[],
    change: { mode?: 'upsert'; hide?: string[] },
    dryRun: boolean,
    holder: string,
    release: (ended?: CatalogSyncEnd) => Promise<void>,
  ): Promise<Response> => {
    const refused = await overTier(store, items, change);
    if (refused !== undefined) {
      await release();
      return refused;
    }
    const options = {
      signer: store.catalogSecretKey,
      store: store.owner,
      items,
      ...change,
      client: deps.syncClient,
      ...(deps.syncPace === undefined ? {} : { pace: deps.syncPace }),
    };
    let diff: SyncDiff;
    try {
      diff = await syncCatalog({ ...options, dryRun: true });
    } catch (error) {
      await release();
      return json({ error: 'sync_refused', message: errorText(error) }, 409);
    }
    if (dryRun) {
      await release();
      return json({ diff }, 200);
    }
    // Publishing is paced (2.4), so a large catalog outlasts a request: it runs on, still holding
    // the guard, its status in GET /store on any instance.
    const syncId = randomId();
    await deps.directory.startCatalogSync(store.owner, holder, syncId, diff, now());
    void syncCatalog(options)
      .then(
        (done) => release({ state: 'done', diff: done }),
        (error: unknown) => release({ state: 'failed', diff, error: errorText(error) }),
      )
      .catch((error: unknown) => log(`catalog sync status not saved: ${errorText(error)}`));
    return json({ diff, started: true, syncId }, 202);
  };

  const policy = async (
    store: StoreRecord,
    method: string,
    slug: string,
    body: string,
  ): Promise<Response> => {
    const options = { signer: store.catalogSecretKey, store: store.owner, client: deps.syncClient };
    // While a Shopify connector is set to import policies, its slugs are its own: each sync
    // puts the shop's version back over a change made here. A connector saved but not enabled
    // yet counts too: enabling it would replace the change just the same.
    const connector = await deps.directory.connector(store.owner);
    const importedSlugs =
      connector?.platform === 'shopify' && connector.importPolicies
        ? SHOPIFY_POLICY_SLUGS.map((entry) => entry.slug)
        : [];
    if (importedSlugs.includes(slug)) {
      return json({ error: 'policy_imported' }, 409);
    }
    try {
      if (method === 'DELETE') {
        const event = await removePolicy({ ...options, slug });
        return json({ id: event.id }, 200);
      }
      const parsed = PolicyRequestSchema.safeParse(parseJson(body));
      const input = parsed.success
        ? PolicyInputSchema.safeParse({ slug, ...parsed.data })
        : undefined;
      if (!input?.success) {
        return json({ error: 'bad_request' }, 400);
      }
      // A new policy past the cap is refused, counting the places the import takes or will
      // take. Two at once may both pass: the worker reads only `policiesInUse` anyway, so the
      // cap holds where it matters.
      const counted = new Set([
        ...(await livePolicies(deps.syncClient, store.catalogKey)).keys(),
        ...importedSlugs,
      ]);
      if (!counted.has(slug) && counted.size >= LIMITS.MAX_POLICIES) {
        return json({ error: 'too_many_policies', max: LIMITS.MAX_POLICIES }, 409);
      }
      const event = await setPolicy({ ...options, policy: input.data });
      return json({ id: event.id }, 200);
    } catch (error) {
      return json({ error: 'publish_refused', message: errorText(error) }, 409);
    }
  };

  const storesPerIp = new WindowLimiter(NEW_STORES_PER_IP_PER_HOUR, HOUR_MS);

  return async ({ request, clientAddress }) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(ADMIN_PREFIX)) {
      return undefined;
    }
    const body = request.method === 'GET' ? '' : await request.text();
    const auth = checkNip98({
      header: request.headers.get('authorization'),
      method: request.method,
      publicUrl: `${publicBase}${url.pathname}${url.search}`,
      body,
      now: now(),
    });
    if (!auth.ok) {
      return json({ error: 'unauthorized', reason: auth.reason }, 401);
    }
    // Kept past the last second the authorization is valid in (created_at + window), with one
    // more window of slack for a sweeping instance whose clock runs ahead, so it is never accepted twice.
    const authExpiry = Math.max(auth.event.created_at, now()) + 2 * AUTH_WINDOW_SECS + 1;
    if (!(await deps.directory.recordAuthId(auth.event.id, authExpiry))) {
      return json({ error: 'unauthorized', reason: 'replay' }, 401);
    }
    const owner = auth.pubkey;
    const route = `${request.method} ${url.pathname}`;
    if (route === 'POST /v1/admin/store/recover') {
      return recover(owner, body, clientAddress);
    }
    if (route === 'POST /v1/admin/store') {
      // Onboarding (7.3): anyone may create a store, which starts pending (K19). Opening an
      // existing one is free; a new one counts per client address, so fresh keys cannot fill
      // the database with pending stores.
      const created =
        body.trim() === ''
          ? { success: true as const, data: {} }
          : CreateRequestSchema.safeParse(parseJson(body));
      if (!created.success) {
        return json({ error: 'bad_request' }, 400);
      }
      const existing = await deps.directory.store(owner);
      if (existing !== undefined) {
        return json(await view(existing), 200);
      }
      // A key a store moved away from never opens a store again: its embeds lead to the new one.
      if (await deps.directory.wasMoved(owner)) {
        return json({ error: 'moved' }, 409);
      }
      if (!storesPerIp.hit(ipKey(clientAddress), now() * 1000)) {
        return json({ error: 'rate_limited' }, 429);
      }
      const store = await deps.directory.createStore(owner, now());
      if (created.data.email !== undefined) {
        await deps.directory.setContactEmail(owner, created.data.email);
      }
      return json(await view(store), 200);
    }
    const store = await deps.directory.store(owner);
    if (store === undefined) {
      // A key the store moved away from: its admin says where to go, or how to take it back.
      return (await deps.directory.wasMoved(owner))
        ? json({ error: 'moved' }, 409)
        : json({ error: 'no_store' }, 404);
    }
    if (route === 'GET /v1/admin/store') {
      return json(await view(store), 200);
    }
    if (route === 'POST /v1/admin/store/events') {
      return storeEvents(store, body);
    }
    if (route === 'POST /v1/admin/store/plan') {
      return choosePlan(store, body);
    }
    if (route === 'GET /v1/admin/store/events') {
      // The read-back (7.3): a store that is not active has nothing on the relay yet, nor has an
      // active one whose events are still being published, so its admin shows the events O signed
      // from here. Only the caller's own store; the admin checks each
      // signature and author as it does the relay's.
      return json(await deps.directory.storedEvents(owner, MAX_READ_BACK_BYTES), 200);
    }
    if (route === 'GET /v1/admin/store/moved-settings') {
      // The private part of the settings the old owner key signed, which only A can read now that
      // the old key is gone: the admin signs it again as the new owner (K21).
      const moved = await deps.directory.movedFrom(owner);
      if (moved === undefined) {
        return json({ error: 'not_found' }, 404);
      }
      const config = moved.config === null ? undefined : parseConfig(moved.config);
      // Sealed for the A it names: the current one, or the next while a rotation was under way.
      const next = await deps.directory.nextAssistantSecret(owner);
      const keys =
        next === undefined ? [store.assistantSecretKey] : [store.assistantSecretKey, next];
      const privatePart =
        config === undefined
          ? undefined
          : keys.map((key) => decryptPrivateConfig(config, key)).find((part) => part !== undefined);
      // The key that signed them: the one moved from, or an earlier key of this store when that one
      // signed nothing. Any other signer is not this store's, and the settings are not given.
      const former = await deps.directory.formerOwners(owner);
      const signedBy =
        moved.config !== null && former.includes(moved.config.pubkey) ? moved.config.pubkey : null;
      return json(
        {
          from: moved.from,
          signedBy,
          config: signedBy === null ? null : moved.config,
          private: signedBy === null ? null : (privatePart ?? null),
        },
        200,
      );
    }
    if (route === 'PUT /v1/admin/store/contact') {
      const parsed = ContactRequestSchema.safeParse(parseJson(body));
      if (!parsed.success) {
        return json({ error: 'bad_email' }, 400);
      }
      await deps.directory.setContactEmail(owner, parsed.data.email ?? undefined);
      return json(await view(store), 200);
    }
    if (route === 'POST /v1/admin/store/assistant/rotate') {
      return json({ nextAssistant: await deps.directory.beginRotation(owner) }, 200);
    }
    if (route === 'PUT /v1/admin/connector') {
      const parsed = ConnectorRequestSchema.safeParse(parseJson(body));
      // A shop's address in one form, as the config holds it: the same shop typed another way
      // (a final slash, capitals) is no new shop and keeps syncing on.
      const url =
        parsed.success && parsed.data.platform !== 'google'
          ? httpsShopIdentity(parsed.data.url)
          : parsed.data?.url;
      if (!parsed.success || url === undefined) {
        return json({ error: 'bad_request' }, 400);
      }
      await deps.directory.setConnector(owner, {
        platform: parsed.data.platform,
        url,
        ...(parsed.data.currency === undefined ? {} : { currency: parsed.data.currency }),
        importPolicies: parsed.data.importPolicies ?? true,
      });
      await deps.connectors.refresh();
      return json({ connector: await deps.directory.connector(owner) }, 200);
    }
    if (route === 'POST /v1/admin/connector/disable') {
      // A pause: the connector stays as set up, and is turned on again after a preview, as at first.
      if (!(await deps.directory.disableConnector(owner))) {
        return json({ error: 'no_connector' }, 404);
      }
      await deps.connectors.refresh();
      return json({ connector: await deps.directory.connector(owner) }, 200);
    }
    if (route === 'DELETE /v1/admin/connector') {
      await deps.directory.removeConnector(owner);
      await deps.connectors.refresh();
      return json({ connector: null }, 200);
    }
    const connectorAction =
      route === 'POST /v1/admin/connector/preview' || route === 'POST /v1/admin/connector/enable';
    if (connectorAction) {
      // Only an active store is synced by connectors (K19).
      if (store.status !== 'active' || store.tier === undefined) {
        return json({ error: 'inactive' }, 409);
      }
      const connector = await deps.directory.connector(owner);
      if (connector === undefined) {
        return json({ error: 'no_connector' }, 404);
      }
      if (route === 'POST /v1/admin/connector/enable') {
        await deps.directory.enableConnector(owner);
        await deps.connectors.refresh();
        deps.connectors.runNow(owner);
        return json({ connector: await deps.directory.connector(owner) }, 200);
      }
      // The first import's preview (7.4): what a sync would publish, nothing published; one per
      // store at a time on any instance, under the catalog sync's guard.
      const { maxProducts } = store.tier;
      const previewed = await withSyncGuard(owner, async (_holder, release) => {
        try {
          const result = await deps.connectors.sync(store, connector, {
            dryRun: true,
            maxProducts,
          });
          return json({ result }, 200);
        } finally {
          await release();
        }
      });
      return previewed ?? json({ error: 'sync_running' }, 409);
    }
    const policyPath = POLICY_PATH_RE.exec(url.pathname);
    const isWrite =
      route === 'POST /v1/admin/catalog' ||
      (policyPath !== null && (request.method === 'PUT' || request.method === 'DELETE'));
    if (!isWrite) {
      return json({ error: 'not_found' }, 404);
    }
    // Only an active store publishes through the server K (K19).
    if (store.status !== 'active') {
      return json({ error: 'inactive' }, 409);
    }
    if (policyPath?.[1] !== undefined) {
      return policy(store, request.method, policyPath[1], body);
    }
    return catalog(store, body);
  };
}

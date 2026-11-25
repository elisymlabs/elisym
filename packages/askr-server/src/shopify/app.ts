import {
  ASKR_RELAYS,
  KIND_CONFIG,
  KIND_CONFIG_DELEGATION,
  KIND_POLICY,
  LIMITS,
  type StoreConfig,
  type StorePrivateConfig,
  type SyncRelayClient,
  configAddress,
  configCandidates,
  decryptPrivateConfig,
} from '@elisym/askr';
import { KIND_DELETION, KIND_PRODUCT } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import * as z from 'zod';
import { AUTH_WINDOW_SECS, checkNip98 } from '../admin/nip98';
import type { FreeTier, ShopifyAppSecrets } from '../config';
import type { ShopifyAppSource } from '../connectors/runner';
import { type Db, type Queryable, STORES_CHANNEL } from '../db/db';
import type { GatewayRequest } from '../gateway/gateway';
import { WindowLimiter } from '../gateway/limits';
import { noteOrigins } from '../state/origins';
import { type StoreDirectory, deleteStoreRows } from '../state/stores';
import { readPrimaryLocale, readShop, readShopPolicies, readShopProducts } from './admin-catalog';
import { SHOP_DOMAIN_RE, checkSessionToken, webhookSigned } from './auth';
import { ShopifyClient, ShopifyRefused } from './client';
import {
  type DelegateSettings,
  configLanguage,
  configName,
  delegateConfigTime,
  delegateInCharge,
  signDelegateConfig,
} from './delegate-config';
import type { ShopDirectory, ShopRecord } from './shops';

export const SHOPIFY_PREFIX = '/v1/shopify/';
export const WEBHOOK_PATH = '/v1/shopify/webhooks';
/** A webhook body read at most. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
/** Settings saves per shop per minute (plan 3.4). */
const SETTINGS_PER_MINUTE = 10;
const MINUTE_MS = 60_000;
/** How long one instance holds a webhook delivery it works on. */
const WEBHOOK_HOLD_SECS = 5 * 60;
/** Deliveries worked off are kept this long to dedupe redeliveries. */
const WEBHOOK_KEEP_SECS = 30 * 24 * 60 * 60;
/** Deliveries one job run works off at most. */
const WEBHOOKS_PER_RUN = 20;
/** `a` tags per deletion event the redact signs. */
const DELETION_BATCH = 100;
/** The topics worked off; every other delivery is answered 200 and not kept (`products/*`, Q2). */
const HANDLED_TOPICS = new Set(['app/uninstalled', 'shop/update', 'shop/redact']);

const BeginSchema = z.object({ shop: z.string() }).strict();
const EventSchema = z.object({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number().int(),
  kind: z.number().int(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string(),
});
const FinishSchema = z.object({ events: z.array(EventSchema).max(2) }).strict();

/**
 * What `PUT /v1/shopify/settings` may change (plan 3.4). Strict: the source, catalog key,
 * policy key and assistant are the server's, so a body naming them is refused.
 */
const SettingsSchema = z
  .object({
    origins: z.array(z.string()).max(LIMITS.MAX_ORIGINS),
    linkOrigins: z.array(z.string()).max(LIMITS.MAX_ORIGINS).optional(),
    name: z.string(),
    displayName: z.string().optional(),
    greeting: z.string().optional(),
    launcherText: z.string().optional(),
    language: z.string(),
    currency: z.string(),
    contact: z.string().optional(),
    private: z
      .object({
        voice: z.string().optional(),
        instructions: z.string().optional(),
        notes: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The shop a webhook body names, by topic: the shop object's `myshopify_domain`, or the
 * compliance topics' `shop_domain`. Checked against `X-Shopify-Shop-Domain`, so a body Shopify
 * signed for one shop is never worked off as another's (the HMAC covers the body only).
 */
function bodyNamesShop(payload: unknown, shop: string): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const named = ['myshopify_domain', 'shop_domain']
    .map((field) => Reflect.get(payload, field))
    .filter((value) => value !== undefined);
  return (
    named.length > 0 &&
    named.every((value) => typeof value === 'string' && value.toLowerCase() === shop)
  );
}

const METAFIELD_QUERY = `{ currentAppInstallation { id metafield(namespace: "askr", key: "store") { value } } }`;
const METAFIELD_SET = `mutation set($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { userErrors { message } }
}`;
const MetafieldAnswerSchema = z.object({
  currentAppInstallation: z.object({
    id: z.string(),
    metafield: z.object({ value: z.string() }).nullable(),
  }),
});

export interface ShopifyAppDeps {
  secrets: ShopifyAppSecrets;
  db: Db;
  shops: ShopDirectory;
  directory: StoreDirectory;
  client: ShopifyClient;
  syncClient: SyncRelayClient;
  /** The configured public base: the owner's NIP-98 `u` is compared with it. */
  publicBase: string;
  /** ASKR_FREE_TIER: the Free tier and its caps, shared with standalone signups (Q9). */
  freeTier?: FreeTier;
  /** Called when a store changed, so it is served, published and synced at once. */
  storesChanged: () => void;
  /** Called once a new webhook delivery is recorded; by default it runs the jobs at once. */
  webhookRecorded?: () => void;
  now?: () => number;
  log?: (message: string) => void;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
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

/** `https://<host>` for a bare host name Shopify sent, or undefined when it is not one. */
function originOfHost(host: string): string | undefined {
  try {
    const url = new URL(`https://${host.trim().toLowerCase()}`);
    return url.host === host.trim().toLowerCase() && url.pathname === '/'
      ? `https://${url.host}`
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the shop is still uninstalled and linked to `owner`, under its row lock: a redact
 * changes nothing once the shop installed the app again (`saveTokens` takes the same lock).
 */
async function stillUninstalled(tx: Queryable, shop: string, owner: string): Promise<boolean> {
  const [row] = await tx.query<{ owner: string | null; uninstalled_at: number | null }>(
    'select owner, uninstalled_at from shopify_shops where shop = $1 for update',
    [shop],
  );
  return row !== undefined && row.owner === owner && row.uninstalled_at !== null;
}

/**
 * Whether a body has its topic's shape (the HMAC covers the body, not the topic header): a
 * `shop/redact` body names `shop_domain` and `shop_id` only; the shop topics carry the shop object
 * (`myshopify_domain`, `domain`), never `shop_domain`.
 */
function bodyFitsTopic(payload: unknown, topic: string): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const has = (field: string) => Reflect.get(payload, field) !== undefined;
  return topic === 'shop/redact'
    ? has('shop_domain') && has('shop_id') && !has('myshopify_domain')
    : has('myshopify_domain') && has('domain') && !has('shop_domain');
}

/** The newest candidate config of a store's stored events that parses, with its event. */
function currentConfig(
  events: readonly NostrEvent[],
  owner: string,
  now: number,
): { event: NostrEvent; config: StoreConfig } | undefined {
  for (const candidate of configCandidates(events, owner, {
    now,
    isGenuine: (event) => verifyEvent(structuredClone(event)),
  })) {
    if (candidate.config !== undefined) {
      return { event: candidate.event, config: candidate.config };
    }
  }
  return undefined;
}

/**
 * The Shopify app's server side (askr-shopify plan 3): the embedded admin's routes under
 * `/v1/shopify/`, authenticated by App Bridge session tokens; Shopify's webhooks; the Admin API
 * reads the `via` connector syncs with; and the jobs that work off webhooks and expire
 * unfinished onboardings. Constructed only when the app's credentials are set.
 */
export class ShopifyApp {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly publicBase: string;
  private readonly settingsLimiter = new WindowLimiter(SETTINGS_PER_MINUTE, MINUTE_MS);
  /** One job run per process at a time; a kick during one runs it once more after. */
  private jobsRunning = false;
  private jobsAgain = false;

  constructor(private readonly deps: ShopifyAppDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = deps.log ?? (() => undefined);
    this.publicBase = deps.publicBase.replace(/\/+$/u, '');
  }

  /** An access token for an installed shop, refreshed as needed; undefined when there is none. */
  private token(shop: string): Promise<string | undefined> {
    return this.deps.shops.accessToken(shop, this.now(), (refreshToken) =>
      this.deps.client.refresh(shop, refreshToken, this.now()),
    );
  }

  /** The Admin API reads of a store's installed shop for its `via` connector (plan 3.5). */
  async sourceFor(owner: string): Promise<ShopifyAppSource | string> {
    const shop = await this.deps.shops.shopOfOwner(owner);
    if (shop === undefined || !shop.onboarded) {
      return 'The store is not linked to a Shopify shop';
    }
    if (shop.uninstalledAt !== null) {
      return 'The Shopify app is uninstalled from this shop';
    }
    const token = await this.token(shop.shop);
    if (token === undefined) {
      return 'The shop needs to open the Askr app in Shopify again';
    }
    return {
      readProducts: (signal) => readShopProducts(this.deps.client, shop.shop, token, { signal }),
      readPolicies: () => readShopPolicies(this.deps.client, shop.shop, token),
    };
  }

  /** Tokens for the shop of a session token: exchanged when missing, dead or uninstalled. */
  private async ensureTokens(shop: string, sessionToken: string): Promise<ShopRecord> {
    const known = await this.deps.shops.shop(shop);
    if (
      known !== undefined &&
      known.hasTokens &&
      !known.needsReauth &&
      known.uninstalledAt === null
    ) {
      return known;
    }
    const tokens = await this.deps.client.exchange(shop, sessionToken, this.now());
    const { reinstalled } = await this.deps.shops.saveTokens(shop, tokens, this.now());
    if (reinstalled) {
      this.log(`shop ${shop} installed the app again`);
      this.deps.storesChanged();
    }
    const saved = await this.deps.shops.shop(shop);
    if (saved === undefined) {
      throw new Error('the shop was not saved');
    }
    return saved;
  }

  /** Write the store's npub to the app installation's `askr.store` metafield when missing. */
  private async writeStoreMetafield(shop: string, owner: string): Promise<void> {
    const token = await this.token(shop);
    if (token === undefined) {
      return;
    }
    const value = npubEncode(owner);
    const answer = MetafieldAnswerSchema.parse(
      await this.deps.client.graphql(shop, token, METAFIELD_QUERY),
    );
    if (answer.currentAppInstallation.metafield?.value === value) {
      return;
    }
    await this.deps.client.graphql(shop, token, METAFIELD_SET, {
      metafields: [
        {
          ownerId: answer.currentAppInstallation.id,
          namespace: 'askr',
          key: 'store',
          type: 'single_line_text_field',
          value,
        },
      ],
    });
  }

  private async storeView(shop: ShopRecord) {
    const owner = shop.owner;
    const store = owner === null ? undefined : await this.deps.directory.store(owner);
    if (owner === null || store === undefined) {
      return { shop: shop.shop, onboarded: false, store: null };
    }
    const hold = await this.deps.directory.shopifyHold(owner);
    const delegation = await this.deps.shops.delegation(owner);
    const events = await this.deps.directory.authorityEvents(owner);
    const inCharge =
      delegation?.delegate !== null && delegation?.delegate !== undefined
        ? delegateInCharge(events, owner, delegation.delegate, delegation.active, this.now())
        : false;
    return {
      shop: shop.shop,
      onboarded: shop.onboarded,
      store: {
        owner,
        npub: npubEncode(owner),
        onboarding: hold.onboarding,
        status: store.status,
        tier: store.tier?.name ?? null,
        connector: (await this.deps.directory.connector(owner)) ?? null,
        catalogSync: await this.deps.directory.catalogSync(owner, this.now()),
        events: await this.deps.directory.eventStatus(owner),
        delegation: { active: delegation?.active ?? false, inCharge },
      },
    };
  }

  /** The routes of `/v1/shopify/`; undefined for other paths. */
  async handle({ request }: GatewayRequest): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(SHOPIFY_PREFIX)) {
      return undefined;
    }
    if (url.pathname === WEBHOOK_PATH) {
      return request.method === 'POST' ? this.webhook(request) : json({ error: 'not_found' }, 404);
    }
    const header = request.headers.get('authorization');
    const session = checkSessionToken({
      header,
      apiKey: this.deps.secrets.apiKey,
      apiSecret: this.deps.secrets.apiSecret,
      now: this.now(),
    });
    if (!session.ok) {
      return json({ error: 'unauthorized', reason: session.reason }, 401, {
        'x-shopify-retry-invalid-session-request': '1',
      });
    }
    const sessionToken = header?.slice('Bearer '.length) ?? '';
    const body = request.method === 'GET' ? '' : await request.text();
    if (body.length > MAX_BODY_BYTES) {
      return json({ error: 'too_large' }, 413);
    }
    const route = `${request.method} ${url.pathname}`;
    try {
      if (route === 'GET /v1/shopify/time') {
        return json({ now: this.now() }, 200);
      }
      const shop = await this.ensureTokens(session.shop, sessionToken);
      if (route === 'GET /v1/shopify/store') {
        if (shop.onboarded && shop.owner !== null) {
          await this.writeStoreMetafield(shop.shop, shop.owner).catch((error: unknown) =>
            this.log(`metafield of ${shop.shop} not written: ${errorText(error)}`),
          );
        }
        return json(await this.storeView(shop), 200);
      }
      if (route === 'POST /v1/shopify/onboard/begin') {
        return await this.begin(request, url, shop, body);
      }
      if (route === 'POST /v1/shopify/onboard/finish') {
        return await this.finish(shop, body);
      }
      if (route === 'POST /v1/shopify/plan/free') {
        return await this.freePlan(shop);
      }
      if (route === 'GET /v1/shopify/settings' || route === 'PUT /v1/shopify/settings') {
        return await this.settings(shop, request.method, body);
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof ShopifyRefused) {
        return json({ error: 'shopify_refused' }, 502);
      }
      throw error;
    }
  }

  /** Onboarding's first call (plan 3.3): O proves itself with a NIP-98 in its own header. */
  private async begin(
    request: Request,
    url: URL,
    shop: ShopRecord,
    body: string,
  ): Promise<Response> {
    const parsed = BeginSchema.safeParse(parseJson(body));
    if (!parsed.success || parsed.data.shop !== shop.shop) {
      return json({ error: 'bad_request' }, 400);
    }
    const auth = checkNip98({
      header: request.headers.get('x-askr-owner-authorization'),
      method: request.method,
      publicUrl: `${this.publicBase}${url.pathname}${url.search}`,
      body,
      now: this.now(),
    });
    if (!auth.ok) {
      return json({ error: 'unauthorized', reason: auth.reason }, 401);
    }
    const authExpiry = Math.max(auth.event.created_at, this.now()) + 2 * AUTH_WINDOW_SECS + 1;
    if (!(await this.deps.directory.recordAuthId(auth.event.id, authExpiry))) {
      return json({ error: 'unauthorized', reason: 'replay' }, 401);
    }
    const begun = await this.deps.shops.begin(shop.shop, auth.pubkey, this.now());
    if (!begun.ok) {
      return json({ error: begun.reason }, 409);
    }
    return json({ catalogKey: begun.catalogKey, delegate: begun.delegate, now: this.now() }, 200);
  }

  /** Onboarding's last call (plan 3.3): the shop's facts are read, then everything is stored. */
  private async finish(shop: ShopRecord, body: string): Promise<Response> {
    const parsed = FinishSchema.safeParse(parseJson(body));
    if (!parsed.success) {
      return json({ error: 'bad_request' }, 400);
    }
    const token = await this.token(shop.shop);
    if (token === undefined) {
      return json({ error: 'shopify_reauth' }, 409);
    }
    const facts = await readShop(this.deps.client, shop.shop, token);
    const primaryOrigin = originOfHost(new URL(facts.primaryOrigin).host);
    if (primaryOrigin === undefined) {
      return json({ error: 'shopify_refused' }, 502);
    }
    const finished = await this.deps.shops.finish(
      shop.shop,
      parsed.data.events,
      {
        primaryOrigin,
        myshopifyOrigin: `https://${shop.shop}`,
        name: configName(facts.name),
        currency: facts.currency,
        language: configLanguage(await readPrimaryLocale(this.deps.client, shop.shop, token)),
        shopId: facts.shopId,
      },
      this.now(),
    );
    if (!finished.ok) {
      const status = finished.reason === 'bad_events' ? 400 : 409;
      const error =
        finished.reason === 'expired' || finished.reason === 'replaced'
          ? `onboarding_${finished.reason}`
          : finished.reason;
      return json(
        { error, ...(finished.detail === undefined ? {} : { reason: finished.detail }) },
        status,
      );
    }
    this.log(`shop ${shop.shop} onboarded store ${finished.owner}`);
    this.deps.storesChanged();
    await this.writeStoreMetafield(shop.shop, finished.owner).catch((error: unknown) =>
      this.log(`metafield of ${shop.shop} not written: ${errorText(error)}`),
    );
    const saved = await this.deps.shops.shop(shop.shop);
    return json(await this.storeView(saved ?? shop), 200);
  }

  /**
   * `POST /v1/shopify/plan/free` (plan 3.6): the merchant's Free choice, with exactly the checks
   * of the standalone admin's: a pending store that never had a tier and holds settings it can
   * run on, the Free tier and its caps under the Free lock. Never for an uninstalled shop, so a
   * store is not turned on again while the app is gone.
   */
  private async freePlan(shop: ShopRecord): Promise<Response> {
    const owner = shop.owner;
    if (owner === null) {
      return json({ error: 'not_onboarded' }, 409);
    }
    const store = await this.deps.directory.store(owner);
    if (store === undefined) {
      return json({ error: 'no_store' }, 404);
    }
    if (!shop.onboarded || (await this.deps.directory.shopifyHold(owner)).onboarding) {
      return json({ error: 'shopify_onboarding' }, 409);
    }
    if (shop.uninstalledAt !== null) {
      return json({ error: 'uninstalled' }, 409);
    }
    if (store.status === 'active') {
      return json({ ...(await this.storeView(shop)), activation: 'already_active' }, 200);
    }
    if (store.status === 'suspended') {
      return json({ error: 'not_pending' }, 409);
    }
    if (store.tier !== undefined) {
      return json({ error: 'operator_managed' }, 409);
    }
    if (!(await this.deps.directory.hasStoredConfig(owner))) {
      return json({ error: 'no_settings' }, 409);
    }
    const freeTier = this.deps.freeTier;
    if (freeTier === undefined) {
      return json({ error: 'free_unavailable' }, 409);
    }
    const outcome = await this.deps.directory.activateFree(owner, freeTier.tier, this.now(), {
      perDay: freeTier.perDay,
      maxActive: freeTier.maxActive,
    });
    if (outcome === 'capacity_reached') {
      return json({ error: 'capacity_reached' }, 409);
    }
    if (outcome === 'no_tier') {
      return json({ error: 'free_unavailable' }, 409);
    }
    if (outcome === null) {
      return json({ error: 'read_failed' }, 503);
    }
    this.log(
      `store ${owner} of ${shop.shop} activated on ${freeTier.tier}: Free chosen in Shopify`,
    );
    this.deps.storesChanged();
    const saved = await this.deps.shops.shop(shop.shop);
    return json({ ...(await this.storeView(saved ?? shop)), activation: 'activated' }, 200);
  }

  /** `GET`/`PUT /v1/shopify/settings` (plan 3.4): D-signed settings, built by the server. */
  private async settings(shop: ShopRecord, method: string, body: string): Promise<Response> {
    const owner = shop.owner;
    if (owner === null) {
      return json({ error: 'not_onboarded' }, 409);
    }
    const store = await this.deps.directory.store(owner);
    const delegation = await this.deps.shops.delegation(owner);
    if (store === undefined || delegation === undefined) {
      return json({ error: 'no_store' }, 404);
    }
    // Between begin and finish (plan 5.2): every route but onboarding's refuses the store.
    if (delegation.onboarding || !shop.onboarded) {
      return json({ error: 'shopify_onboarding' }, 409);
    }
    const now = this.now();
    const events = await this.deps.directory.authorityEvents(owner);
    const current = currentConfig(events, owner, now);
    const delegate = delegation.delegate;
    const inCharge =
      delegate !== null && delegateInCharge(events, owner, delegate, delegation.active, now);
    if (method === 'GET') {
      const next = await this.deps.directory.nextAssistantSecret(owner);
      const keys =
        next === undefined ? [store.assistantSecretKey] : [store.assistantSecretKey, next];
      const privatePart =
        current === undefined
          ? undefined
          : keys
              .map((key) => decryptPrivateConfig(current.config, key))
              .find((part) => part !== undefined);
      return json(
        {
          config: current === undefined ? null : current.config,
          private: privatePart ?? null,
          inCharge,
        },
        200,
      );
    }
    if (!inCharge || delegate === null) {
      return json({ error: 'owner_managed' }, 409);
    }
    if (!this.settingsLimiter.hit(shop.shop, Date.now())) {
      return json({ error: 'rate_limited' }, 429);
    }
    const parsed = SettingsSchema.safeParse(parseJson(body));
    if (!parsed.success || shop.primaryOrigin === null) {
      return json({ error: 'bad_request' }, 400);
    }
    const saved = await this.saveDelegateConfig(owner, events, {
      settings: { ...parsed.data, linkOrigins: parsed.data.linkOrigins ?? [] },
      shopUrl: shop.primaryOrigin,
    });
    if (saved !== undefined) {
      return saved;
    }
    return json({ saved: true }, 200);
  }

  /**
   * Sign and store a D config (plan 3.4): the store's `next_assistant ?? assistant` and K, the
   * shop's primary origin among the origins and as the shop URL, dated after every stored config.
   * Answers a refusal, or undefined once stored.
   */
  private async saveDelegateConfig(
    owner: string,
    events: readonly NostrEvent[],
    input: { settings: DelegateSettings; shopUrl: string },
  ): Promise<Response | undefined> {
    const store = await this.deps.directory.store(owner);
    const delegateSecret = await this.deps.shops.delegateSecret(owner);
    if (store === undefined || delegateSecret === undefined) {
      return json({ error: 'no_store' }, 404);
    }
    const createdAt = delegateConfigTime(events, this.now());
    if (createdAt === undefined) {
      return json({ error: 'rate_limited' }, 429);
    }
    const origins = input.settings.origins.includes(input.shopUrl)
      ? input.settings.origins
      : [input.shopUrl, ...input.settings.origins];
    let event: NostrEvent;
    try {
      event = signDelegateConfig({
        settings: { ...input.settings, origins },
        keys: {
          assistant: (await this.deps.directory.nextAssistant(owner)) ?? store.assistant,
          catalogKey: store.catalogKey,
        },
        shopUrl: input.shopUrl,
        createdAt,
        delegateSecret,
      });
    } catch {
      return json({ error: 'bad_settings' }, 400);
    }
    const added = await this.deps.directory.addEvents(owner, [event]);
    if (!added.ok) {
      return json({ error: added.reason }, 409);
    }
    this.deps.storesChanged();
    return undefined;
  }

  /** Shopify's webhooks (plan 3.2): checked, recorded, answered; worked off by `runJobs`. */
  private async webhook(request: Request): Promise<Response> {
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.length > MAX_WEBHOOK_BYTES) {
      return json({ error: 'too_large' }, 413);
    }
    if (
      !webhookSigned(raw, request.headers.get('x-shopify-hmac-sha256'), this.deps.secrets.apiSecret)
    ) {
      return json({ error: 'unauthorized' }, 401);
    }
    const shop = request.headers.get('x-shopify-shop-domain') ?? '';
    const topic = request.headers.get('x-shopify-topic') ?? '';
    const id = request.headers.get('x-shopify-webhook-id') ?? '';
    if (!SHOP_DOMAIN_RE.test(shop) || topic === '' || id === '' || id.length > 200) {
      return json({ ok: true }, 200);
    }
    if (!HANDLED_TOPICS.has(topic)) {
      if (topic.startsWith('customers/')) {
        this.log(`webhook ${topic} for ${shop}: no customer data is kept`);
      }
      return json({ ok: true }, 200);
    }
    if ((await this.deps.shops.shop(shop)) === undefined) {
      return json({ ok: true }, 200);
    }
    const payload = parseJson(raw.toString('utf8'));
    if (!bodyNamesShop(payload, shop) || !bodyFitsTopic(payload, topic)) {
      this.log(`webhook ${topic} for ${shop} does not match its body; dropped`);
      return json({ ok: true }, 200);
    }
    if (await this.deps.shops.recordWebhook(id, shop, topic, payload, this.now())) {
      if (this.deps.webhookRecorded === undefined) {
        this.kickJobs();
      } else {
        this.deps.webhookRecorded();
      }
    }
    return json({ ok: true }, 200);
  }

  /**
   * Work off recorded webhooks, expire unfinished onboardings and forget old deliveries. Each
   * delivery is held by one instance while it runs; a failed one is taken again later.
   */
  /** Run the jobs now, or once more right after the run under way (a burst of deliveries). */
  kickJobs(): void {
    if (this.jobsRunning) {
      this.jobsAgain = true;
      return;
    }
    this.jobsRunning = true;
    this.runJobs()
      .catch((error: unknown) => this.log(`shopify jobs failed: ${errorText(error)}`))
      .finally(() => {
        this.jobsRunning = false;
        if (this.jobsAgain) {
          this.jobsAgain = false;
          this.kickJobs();
        }
      });
  }

  async runJobs(): Promise<void> {
    const expired = await this.deps.shops.expireOnboardings(this.now());
    if (expired > 0) {
      this.log(`deleted ${expired} unfinished Shopify onboarding(s)`);
    }
    await this.deps.shops.pruneWebhooks(this.now() - WEBHOOK_KEEP_SECS);
    for (let index = 0; index < WEBHOOKS_PER_RUN; index += 1) {
      const delivery = await this.deps.shops.claimWebhook(this.now(), WEBHOOK_HOLD_SECS);
      if (delivery === undefined) {
        return;
      }
      try {
        await this.workOff(delivery.shop, delivery.topic);
        await this.deps.shops.webhookDone(delivery.id, this.now());
      } catch (error) {
        this.log(`webhook ${delivery.topic} for ${delivery.shop} failed: ${errorText(error)}`);
      }
    }
  }

  private async workOff(shop: string, topic: string): Promise<void> {
    if (topic === 'app/uninstalled') {
      await this.uninstalled(shop);
    } else if (topic === 'shop/update') {
      await this.shopUpdated(shop);
    } else if (topic === 'shop/redact') {
      await this.redact(shop);
    }
  }

  /**
   * Whether Shopify still accepts the shop's token: true when an Admin call succeeds, false when
   * Shopify refuses it or there is no usable token. Any other failure throws (retried later).
   */
  private async stillInstalled(shop: string): Promise<boolean> {
    const token = await this.token(shop);
    if (token === undefined) {
      return false;
    }
    try {
      await this.deps.client.graphql(shop, token, '{ shop { id } }');
      return true;
    } catch (error) {
      if (error instanceof ShopifyRefused) {
        return false;
      }
      throw error;
    }
  }

  /**
   * `app/uninstalled` (plan 3.7): the store goes back to pending without a plan (unless the
   * operator manages it or it is suspended), the `via` connector stops and the tokens go.
   */
  private async uninstalled(shop: string): Promise<void> {
    // The HMAC covers the body, not the topic: Shopify itself confirms the uninstall, since it
    // revokes the shop's token then. A token that still works means the app is installed.
    if (await this.stillInstalled(shop)) {
      this.log(`webhook app/uninstalled for ${shop}, but the app is still installed: ignored`);
      return;
    }
    const owner = await this.deps.db.transaction(async (tx) => {
      const [row] = await tx.query<{ owner: string | null }>(
        'select owner from shopify_shops where shop = $1 for update',
        [shop],
      );
      if (row === undefined) {
        return null;
      }
      await tx.query(
        `update shopify_shops set uninstalled_at = $2, access_token = null, refresh_token = null,
           token_expires_at = null
         where shop = $1`,
        [shop, this.now()],
      );
      if (row.owner === null) {
        return null;
      }
      await tx.query(
        `update stores set status = 'pending', tier = null, plan_source = null
         where owner = $1 and status <> 'suspended'
           and (plan_source is null or plan_source in ('shopify', 'free'))`,
        [row.owner],
      );
      await tx.query(
        `update connectors set enabled = false where owner = $1 and via = 'shopify_app'`,
        [row.owner],
      );
      await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, row.owner]);
      return row.owner;
    });
    if (owner !== null) {
      this.log(`shop ${shop} uninstalled the app; store ${owner} is pending`);
      this.deps.storesChanged();
    }
  }

  /**
   * `shop/update` (plan 3.5): a new primary domain moves the `via` connector, the shop's primary
   * origin and, while D is in charge, D's config (origins and shop URL) along with it.
   */
  private async shopUpdated(shop: string): Promise<void> {
    const row = await this.deps.shops.shop(shop);
    if (row === undefined || row.owner === null || !row.onboarded || row.uninstalledAt !== null) {
      return;
    }
    // The webhook only says something changed: the domain is read from Shopify itself. With no
    // usable token (an installed shop whose refresh token died) the delivery stays open until the
    // next admin open exchanges a new one.
    const token = await this.token(shop);
    if (token === undefined) {
      throw new Error('no usable token for the shop yet');
    }
    const facts = await readShop(this.deps.client, shop, token);
    const origin = originOfHost(new URL(facts.primaryOrigin).host);
    if (origin === undefined || origin === row.primaryOrigin) {
      return;
    }
    const owner = row.owner;
    const now = this.now();
    const events = await this.deps.directory.authorityEvents(owner);
    const delegation = await this.deps.shops.delegation(owner);
    const delegate = delegation?.delegate ?? null;
    const inCharge =
      delegate !== null &&
      delegateInCharge(events, owner, delegate, delegation?.active ?? false, now);
    if (inCharge) {
      const current = currentConfig(events, owner, now);
      const store = await this.deps.directory.store(owner);
      if (current !== undefined && store !== undefined) {
        const next = await this.deps.directory.nextAssistantSecret(owner);
        const keys =
          next === undefined ? [store.assistantSecretKey] : [store.assistantSecretKey, next];
        const privatePart = keys
          .map((key) => decryptPrivateConfig(current.config, key))
          .find((part): part is StorePrivateConfig => part !== undefined);
        const origins = current.config.origins.filter((held) => held !== row.primaryOrigin);
        const refused = await this.saveDelegateConfig(owner, events, {
          settings: {
            origins: [origin, ...origins].slice(0, LIMITS.MAX_ORIGINS),
            linkOrigins: current.config.linkOrigins,
            name: current.config.name,
            language: current.config.language,
            currency: current.config.currency,
            ...(current.config.displayName === undefined
              ? {}
              : { displayName: current.config.displayName }),
            ...(current.config.greeting === undefined ? {} : { greeting: current.config.greeting }),
            ...(current.config.launcherText === undefined
              ? {}
              : { launcherText: current.config.launcherText }),
            ...(current.config.contact === undefined ? {} : { contact: current.config.contact }),
            ...(privatePart === undefined ? {} : { private: privatePart }),
          },
          shopUrl: origin,
        });
        if (refused !== undefined) {
          throw new Error(`the delegate config was not saved (${refused.status})`);
        }
      }
    }
    await this.deps.db.transaction(async (tx) => {
      // Its own statement, never `setConnector`, which disables a connector whose URL changes.
      await tx.query(`update connectors set url = $2 where owner = $1 and via = 'shopify_app'`, [
        owner,
        origin,
      ]);
      await tx.query('update shopify_shops set primary_origin = $2 where shop = $1', [
        shop,
        origin,
      ]);
      await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
    });
    // Read from Shopify by the server itself: the shop's own site (1.5).
    await noteOrigins(this.deps.db, owner, [origin], now);
    this.log(`shop ${shop} moved to ${origin}`);
    this.deps.storesChanged();
  }

  /**
   * `shop/redact` (plan 3.7), 48 h after an uninstall, for a shop still uninstalled. D in charge
   * (by stored and freshly read relay events): D deletes its config and K its listings and
   * policies, each confirmed by the relay, then the store and the shop go. The merchant managing
   * with O: the shop is only unlinked, and the store stays theirs.
   */
  private async redact(shop: string): Promise<void> {
    const row = await this.deps.shops.shop(shop);
    if (row === undefined || row.uninstalledAt === null) {
      return;
    }
    const owner = row.owner;
    if (owner === null) {
      // One statement with its own check: a reinstall or a begin meanwhile keeps the row.
      await this.deps.db.query(
        `delete from shopify_shops
         where shop = $1 and owner is null and uninstalled_at is not null`,
        [shop],
      );
      return;
    }
    const delegation = await this.deps.shops.delegation(owner);
    const delegate = delegation?.delegate ?? null;
    const relayEvents = await this.deps.syncClient.query(ASKR_RELAYS, {
      kinds: [KIND_CONFIG, KIND_CONFIG_DELEGATION, KIND_DELETION],
      authors: [owner],
    });
    const genuine = relayEvents.filter(
      (event) => event.pubkey === owner && verifyEvent(structuredClone(event)),
    );
    const events = [...(await this.deps.directory.authorityEvents(owner)), ...genuine];
    const inCharge =
      delegate !== null &&
      delegateInCharge(events, owner, delegate, delegation?.active ?? false, this.now());
    if (!inCharge) {
      const unlinked = await this.deps.db.transaction(async (tx) => {
        if (!(await stillUninstalled(tx, shop, owner))) {
          return false;
        }
        await tx.query(
          `update stores set config_delegate = null, config_delegate_secret = null,
             pending_delegate = null, pending_delegate_secret = null, delegate_active = false
           where owner = $1`,
          [owner],
        );
        await tx.query(`delete from connectors where owner = $1 and via = 'shopify_app'`, [owner]);
        await tx.query('delete from shopify_shops where shop = $1', [shop]);
        await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
        return true;
      });
      if (!unlinked) {
        this.log(`shop ${shop} installed the app again during its redact: kept`);
        return;
      }
      this.log(`shop ${shop} redacted: store ${owner} is managed with its owner key, unlinked`);
      this.deps.storesChanged();
      return;
    }
    const store = await this.deps.directory.store(owner);
    const delegateSecret = await this.deps.shops.delegateSecret(owner);
    if (store === undefined || delegateSecret === undefined) {
      throw new Error('the store or its delegate is missing');
    }
    const now = this.now();
    const ownConfigDeletion = finalizeEvent(
      {
        kind: KIND_DELETION,
        created_at: now,
        tags: [['a', configAddress(getPublicKey(delegateSecret))]],
        content: '',
      },
      delegateSecret,
    );
    await this.deps.syncClient.publish(ASKR_RELAYS, ownConfigDeletion);
    const published = await this.deps.syncClient.query(ASKR_RELAYS, {
      kinds: [KIND_PRODUCT, KIND_POLICY],
      authors: [store.catalogKey],
    });
    const addresses = [
      ...new Set(
        published.flatMap((event) => {
          const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
          return event.pubkey === store.catalogKey && d !== undefined
            ? [`${event.kind}:${store.catalogKey}:${d}`]
            : [];
        }),
      ),
    ];
    for (let start = 0; start < addresses.length; start += DELETION_BATCH) {
      const deletion = finalizeEvent(
        {
          kind: KIND_DELETION,
          created_at: now,
          tags: addresses.slice(start, start + DELETION_BATCH).map((address) => ['a', address]),
          content: '',
        },
        store.catalogSecretKey,
      );
      await this.deps.syncClient.publish(ASKR_RELAYS, deletion);
    }
    const deleted = await this.deps.db.transaction(async (tx) => {
      // A reinstall while the deletions went out keeps the store: D's next config, dated after
      // the deletion, is served again, and the connector publishes the catalog again.
      if (!(await stillUninstalled(tx, shop, owner))) {
        return false;
      }
      await tx.query('delete from shopify_shops where shop = $1', [shop]);
      await deleteStoreRows(tx, owner);
      await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
      return true;
    });
    if (!deleted) {
      this.log(`shop ${shop} installed the app again during its redact: store ${owner} kept`);
      return;
    }
    this.log(`shop ${shop} redacted: store ${owner} and its catalog deleted`);
    this.deps.storesChanged();
  }
}

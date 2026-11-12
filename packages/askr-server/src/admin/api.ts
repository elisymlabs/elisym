import {
  CONNECTOR_PLATFORMS,
  type CatalogItemInput,
  CatalogItemInputSchema,
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  PolicyInputSchema,
  type SyncDiff,
  type SyncRelayClient,
  parseConfig,
  removePolicy,
  setPolicy,
  syncCatalog,
} from '@elisym/askr';
import { HEX_PUBKEY_RE } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import { z } from 'zod';
import { publicBaseOf } from '../config';
import type { ConnectorService } from '../connectors/service';
import type { GatewayRequest } from '../gateway/gateway';
import { randomId } from '../state/pg-state';
import type { CatalogSyncStatus, StoreDirectory } from '../state/stores';
import type { StoreRecord } from '../state/types';
import { AUTH_WINDOW_SECS, checkNip98 } from './nip98';

export const ADMIN_PREFIX = '/v1/admin/';
const KIND_DELETION = 5;
const MAX_EVENTS_PER_REQUEST = 20;
const MAX_EVENT_BYTES = 64 * 1024;
/** A stored event may be dated at most this far ahead (clock skew of the signer). */
const MAX_AHEAD_SECS = 10 * 60;
const POLICY_PATH_RE = /^\/v1\/admin\/policies\/([a-z0-9-]{1,64})$/;
/**
 * A catalog sync or connector preview holds its store's guard this long past
 * its last renewal, so one whose instance died frees the store soon (7.3).
 */
const SYNC_HOLD_SECS = 2 * 60;
/** ...and renews it this often while it runs. */
const SYNC_RENEW_MS = 30_000;

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

const CatalogRequestSchema = z.object({
  items: z.array(z.unknown()),
  dryRun: z.boolean().optional(),
});

const PolicyRequestSchema = z.object({ title: z.string(), body: z.string() });

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
  /** The configured public base, e.g. `https://api.askr.elisym.network`: NIP-98 `u` is compared with it (7.3). */
  publicBase: string;
  syncClient: SyncRelayClient;
  /** Called after O-signed events were stored, so an active store's are published at once. */
  storeEventsChanged: () => void;
  connectors: ConnectorService;
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
  // `https://api.askr.elisym.network/` and without the slash name the same base.
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
    work: (
      holder: string,
      release: (ended?: CatalogSyncStatus) => Promise<void>,
    ) => Promise<Response>,
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
    const release = async (ended?: CatalogSyncStatus) => {
      if (released) {
        return;
      }
      released = true;
      clearInterval(renewal);
      await deps.directory.releaseCatalogSync(owner, holder, ended);
    };
    try {
      return await work(holder, release);
    } catch (error) {
      await release();
      throw error;
    }
  };

  const view = async (store: StoreRecord) => ({
    owner: store.owner,
    status: store.status,
    tier: store.tier ?? null,
    assistant: store.assistant,
    nextAssistant: (await deps.directory.nextAssistant(store.owner)) ?? null,
    catalogKey: store.catalogKey,
    usage: await deps.directory.usage(store.owner, store.assistant, now()),
    catalogSync: await deps.directory.catalogSync(store.owner, now()),
    connector: (await deps.directory.connector(store.owner)) ?? null,
    events: await deps.directory.eventStatus(store.owner),
  });

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
    deps.storeEventsChanged();
    return json({ stored: events.map((event) => event.id) }, 200);
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
    if (store.tier !== undefined && items.data.length > store.tier.maxProducts) {
      return json({ error: 'too_many_products', max: store.tier.maxProducts }, 400);
    }
    const dryRun = parsed.data.dryRun === true;
    const started = await withSyncGuard(store.owner, (holder, release) =>
      startSync(store, items.data, dryRun, holder, release),
    );
    return started ?? json({ error: 'sync_running' }, 409);
  };

  const startSync = async (
    store: StoreRecord,
    items: CatalogItemInput[],
    dryRun: boolean,
    holder: string,
    release: (ended?: CatalogSyncStatus) => Promise<void>,
  ): Promise<Response> => {
    const options = {
      signer: store.catalogSecretKey,
      store: store.owner,
      items,
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
    await deps.directory.startCatalogSync(store.owner, holder, diff, now());
    void syncCatalog(options)
      .then(
        (done) => release({ state: 'done', diff: done }),
        (error: unknown) => release({ state: 'failed', diff, error: errorText(error) }),
      )
      .catch((error: unknown) => log(`catalog sync status not saved: ${errorText(error)}`));
    return json({ diff, started: true }, 202);
  };

  const policy = async (
    store: StoreRecord,
    method: string,
    slug: string,
    body: string,
  ): Promise<Response> => {
    const options = { signer: store.catalogSecretKey, store: store.owner, client: deps.syncClient };
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
      const event = await setPolicy({ ...options, policy: input.data });
      return json({ id: event.id }, 200);
    } catch (error) {
      return json({ error: 'publish_refused', message: errorText(error) }, 409);
    }
  };

  return async ({ request }) => {
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
    if (route === 'POST /v1/admin/store') {
      // Onboarding (7.3): anyone may create a store, which starts pending (K19).
      return json(await view(await deps.directory.createStore(owner, now())), 200);
    }
    const store = await deps.directory.store(owner);
    if (store === undefined) {
      return json({ error: 'no_store' }, 404);
    }
    if (route === 'GET /v1/admin/store') {
      return json(await view(store), 200);
    }
    if (route === 'POST /v1/admin/store/events') {
      return storeEvents(store, body);
    }
    if (route === 'POST /v1/admin/store/assistant/rotate') {
      return json({ nextAssistant: await deps.directory.beginRotation(owner) }, 200);
    }
    if (route === 'PUT /v1/admin/connector') {
      const parsed = ConnectorRequestSchema.safeParse(parseJson(body));
      if (!parsed.success) {
        return json({ error: 'bad_request' }, 400);
      }
      await deps.directory.setConnector(owner, {
        platform: parsed.data.platform,
        url: parsed.data.url,
        ...(parsed.data.currency === undefined ? {} : { currency: parsed.data.currency }),
        importPolicies: parsed.data.importPolicies ?? true,
      });
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

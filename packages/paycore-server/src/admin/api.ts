import { KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import * as z from 'zod';
import { publicBaseOf } from '../config';
import type { Db } from '../db/db';
import { type GatewayRequest, WindowLimiter, ipKey } from '../gateway/http';
import { activePayouts } from '../node/load';
import {
  type OwnerEventKind,
  type OwnerEventRefusal,
  commitOwnerEvent,
  committedOwnerEvents,
  prepareOwnerEvent,
} from '../owner-events';
import {
  ConfigInputSchema,
  canonicalPayouts,
  CreateStoreInputSchema,
  HandInputSchema,
  ProductInputSchema,
  type Refusal,
  type StoreDirectory,
  type StoreRecord,
} from '../state/stores';
import { authIdExpiry } from './auth-ids';
import { checkNip98 } from './nip98';
import { merchantResult } from './request-results';
import { type AdminRequest, REQUEST_WAIT_MS, getRequest, waitResult } from './requests';

export const ADMIN_PREFIX = '/v1/admin/';
/** New stores one client address may create per hour (onboarding needs one). */
export const NEW_STORES_PER_IP_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
const PRODUCT_PATH_RE = /^\/v1\/admin\/products\/([^/]+)$/;
const HAND_PATH_RE = /^\/v1\/admin\/orders\/([^/]+)\/hand$/;
const REQUEST_PATH_RE = /^\/v1\/admin\/requests\/([0-9a-f]{1,64})$/;
/** An order key: `<buyer pubkey>:<order id>`; the id is the buyer's (at most 64 characters). */
const ORDER_KEY_RE = /^[0-9a-f]{64}:.{1,64}$/su;

const PrepareSchema = z
  .object({ kind: z.union([z.literal(KIND_PAYTO), z.literal(KIND_STORE_AUTH)]) })
  .strict();
/** The kind picks the relays' newest to judge staleness; the rest is checked by `commitOwnerEvent`. */
/** The admin's config: the whole config (built from the last GET plus the edit) and the revision it read. */
const AdminConfigSchema = ConfigInputSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
});
const CommitSchema = z
  .object({
    event: z.looseObject({ kind: z.union([z.literal(KIND_PAYTO), z.literal(KIND_STORE_AUTH)]) }),
  })
  .strict();

export interface AdminDeps {
  directory: StoreDirectory;
  db: Db;
  /** PAYCORE_PUBLIC_BASE: NIP-98 `u` is compared with it. */
  publicBase: string;
  /** PAYCORE_OPERATOR: the 30490 `operator`. */
  operator: string;
  now?: () => number;
  /** How long a request route waits for the holder; then 202 with the request id. */
  requestWaitMs?: number;
  /** The holder's answer to request `id`, or undefined still pending after `timeoutMs` (tests drive it). */
  waitResult?: (owner: string, id: string, timeoutMs: number) => Promise<AdminRequest | undefined>;
  /**
   * `created_at` of O's newest event of `kind` the relays serve (undefined:
   * none, or not read). Unset: not read; prepare then dates a new payout list
   * after the recorded one, and commit judges staleness by what is committed.
   */
  newestOnRelays?: (owner: string, kind: OwnerEventKind) => Promise<number | undefined>;
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

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

const REFUSAL_STATUS: Record<string, number> = {
  no_store: 404,
  not_found: 404,
  suspended: 409,
  inactive: 409,
  product_cap: 409,
  no_draft: 409,
  stale_config: 409,
  expired: 409,
  stale: 409,
  clock: 409,
  no_payouts: 409,
  unsigned_payout: 409,
  bad_payouts: 409,
};

function refused(refusal: Refusal | OwnerEventRefusal): Response {
  const { ok: _ok, ...body } = refusal;
  return json(body, REFUSAL_STATUS[refusal.error] ?? 400);
}

/** A request as the merchant sees it: its result whitelisted (A15), a failure always with a code. */
function requestView(request: AdminRequest) {
  const result = merchantResult(request.kind, request.result);
  return {
    id: request.id,
    kind: request.kind,
    state: request.state,
    result:
      request.state === 'failed' && result?.code === undefined
        ? { ...result, code: 'failed' }
        : result,
    createdAt: request.createdAt,
    appliedAt: request.appliedAt ?? null,
  };
}

/**
 * The admin API: every call, reads included, carries a NIP-98 authorization
 * by O against PAYCORE_PUBLIC_BASE, accepted once (`admin_auth_ids`); it acts
 * only on O's own store. Ledger-changing work is queued for the store's holder
 * as an `admin_requests` row; such a route waits for the holder, else answers
 * 202 with the request id (`GET requests/:id`). No answer holds a secret, but
 * the new webhook secret, once, in its own response. Returns undefined for
 * other paths.
 */
export function createAdminApi(
  deps: AdminDeps,
): (input: GatewayRequest) => Promise<Response | undefined> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const publicBase = publicBaseOf(deps.publicBase);
  const waitMs = deps.requestWaitMs ?? REQUEST_WAIT_MS;
  const wait =
    deps.waitResult ??
    ((owner: string, id: string, timeoutMs: number) => waitResult(deps.db, owner, id, timeoutMs));
  const ownerEvents = { db: deps.db, operator: deps.operator, now };
  const storesPerIp = new WindowLimiter(NEW_STORES_PER_IP_PER_HOUR, HOUR_MS);
  const directory = deps.directory;

  const view = async (store: StoreRecord) => {
    const [settings, webhookSecretSet, state, alerts, committed] = await Promise.all([
      directory.settings(store.owner),
      directory.hasWebhookSecret(store.owner),
      directory.ledgerState(store.owner),
      directory.openAlertKinds(store.owner),
      committedOwnerEvents(deps.db, store.owner),
    ]);
    const draft = settings === undefined ? undefined : canonicalPayouts(settings.draftPayouts);
    return {
      owner: store.owner,
      storePubkey: store.storePubkey,
      status: store.status,
      // A15: the open alerts' kinds; their messages (raw error texts) stay with the operator.
      alerts,
      tier: store.tier?.name ?? null,
      // The cap that applies: the tier's, or the pending one (as `putProduct` judges it).
      maxProducts: store.tier?.maxProducts ?? directory.pendingMaxProducts,
      suspendingSince: store.suspendingSince ?? null,
      createdAt: store.createdAt,
      config: settings ?? null,
      // The payouts buyers see (P9): the ledger's recorded payout list.
      activePayouts:
        state?.payto === undefined
          ? null
          : { createdAt: state.payto.createdAt, payouts: activePayouts(state, store.owner) },
      // The draft differs from the newest committed payout list (not `state.payto`, unset until activation).
      payouts: {
        needsSigning: draft !== undefined && draft.text !== committed.paytoPayouts,
      },
      ownerEvents: { payto: committed.payto, auth: committed.auth },
      webhookSecretSet,
    };
  };

  /** Wait for the holder to apply `id`: 200 applied, 422 failed, 202 still pending. */
  const answerRequest = async (
    owner: string,
    pending: boolean,
    id: string,
    extra: Record<string, unknown> = {},
  ): Promise<Response> => {
    // A pending store has no holder yet: its requests wait for its activation.
    const done = pending ? undefined : await wait(owner, id, waitMs);
    if (done === undefined || done.state === 'pending') {
      return json({ ...extra, request: { id, state: 'pending' } }, 202);
    }
    return json({ ...extra, request: requestView(done) }, done.state === 'applied' ? 200 : 422);
  };

  const newest = async (owner: string, kind: OwnerEventKind) => {
    const read = await deps.newestOnRelays?.(owner, kind);
    return read === undefined ? {} : { newestOnRelays: read };
  };

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
    if (
      !(await directory.recordAuthId(auth.event.id, authIdExpiry(auth.event.created_at, now())))
    ) {
      return json({ error: 'unauthorized', reason: 'replay' }, 401);
    }
    const owner = auth.pubkey;
    const route = `${request.method} ${url.pathname}`;

    if (route === 'POST /v1/admin/store') {
      const input = CreateStoreInputSchema.safeParse(parseJson(body));
      if (!input.success) {
        return json({ error: 'bad_request' }, 400);
      }
      const existing = await directory.store(owner);
      if (existing !== undefined) {
        return json(await view(existing), 200);
      }
      // Opening an existing store is free; a new one counts per client address.
      if (!storesPerIp.hit(ipKey(clientAddress), now() * 1000)) {
        return json({ error: 'rate_limited' }, 429);
      }
      const { store } = await directory.createStore(owner, input.data);
      return json(await view(store), 200);
    }

    const store = await directory.store(owner);
    if (store === undefined) {
      return json({ error: 'no_store' }, 404);
    }

    if (route === 'GET /v1/admin/store') {
      return json(await view(store), 200);
    }
    if (route === 'PUT /v1/admin/store/config') {
      const input = AdminConfigSchema.safeParse(parseJson(body));
      if (!input.success) {
        return json({ error: 'bad_request' }, 400);
      }
      const { expectedRevision, ...config } = input.data;
      const result = await directory.putConfig(owner, config, expectedRevision);
      return result.ok
        ? json({ config: result.settings, requestId: result.requestId ?? null }, 200)
        : refused(result);
    }
    if (route === 'POST /v1/admin/store/suspend') {
      const result = await directory.requestSuspend(owner);
      return result.ok
        ? answerRequest(owner, store.status === 'pending', result.requestId)
        : refused(result);
    }
    if (route === 'GET /v1/admin/products') {
      return json({ products: await directory.products(owner) }, 200);
    }
    const productPath = PRODUCT_PATH_RE.exec(url.pathname);
    if (productPath?.[1] !== undefined) {
      const d = decodeSegment(productPath[1]);
      if (d === undefined) {
        return json({ error: 'bad_request' }, 400);
      }
      if (request.method === 'GET') {
        const product = await directory.product(owner, d);
        return product === undefined ? json({ error: 'not_found' }, 404) : json({ product }, 200);
      }
      if (request.method === 'PUT') {
        const input = ProductInputSchema.safeParse(parseJson(body));
        if (!input.success) {
          return json(
            {
              error: 'bad_product',
              problems: input.error.issues.map(
                (issue) => `${issue.path.join('.') || 'product'}: ${issue.message}`,
              ),
            },
            400,
          );
        }
        const result = await directory.putProduct(owner, d, input.data);
        return result.ok
          ? json({ product: result.product, requestId: result.requestId ?? null }, 200)
          : refused(result);
      }
      if (request.method === 'DELETE') {
        const result = await directory.deleteProduct(owner, d);
        return result.ok
          ? json({ outcome: result.outcome, requestId: result.requestId ?? null }, 200)
          : refused(result);
      }
      return json({ error: 'not_found' }, 404);
    }
    if (route === 'POST /v1/admin/owner-events/prepare') {
      const input = PrepareSchema.safeParse(parseJson(body));
      if (!input.success) {
        return json({ error: 'bad_request' }, 400);
      }
      const result = await prepareOwnerEvent(
        ownerEvents,
        owner,
        input.data.kind,
        await newest(owner, input.data.kind),
      );
      return result.ok
        ? json({ template: result.template, expiresAt: result.expiresAt }, 200)
        : refused(result);
    }
    if (route === 'POST /v1/admin/owner-events/commit') {
      const input = CommitSchema.safeParse(parseJson(body));
      if (!input.success) {
        return json({ error: 'malformed' }, 400);
      }
      const kind = input.data.event.kind;
      const result = await commitOwnerEvent(
        ownerEvents,
        owner,
        input.data.event,
        await newest(owner, kind),
      );
      if (!result.ok) {
        return refused(result);
      }
      if (result.requestId === undefined) {
        return json({ id: result.id, alreadyCommitted: true }, 200);
      }
      return answerRequest(owner, store.status === 'pending', result.requestId, {
        id: result.id,
        ...(result.alreadyCommitted ? { alreadyCommitted: true } : {}),
      });
    }
    if (route === 'POST /v1/admin/webhook/secret') {
      const result = await directory.rotateWebhookSecret(owner);
      // The only answer that holds a secret: shown once, kept sealed only.
      return result.ok
        ? json({ secret: result.secret, requestId: result.requestId ?? null }, 200)
        : refused(result);
    }
    if (route === 'GET /v1/admin/orders') {
      const orders = await directory.orders(owner);
      return orders === undefined ? json({ error: 'no_store' }, 404) : json(orders, 200);
    }
    const handPath = HAND_PATH_RE.exec(url.pathname);
    if (handPath?.[1] !== undefined && request.method === 'POST') {
      const key = decodeSegment(handPath[1]);
      const input = HandInputSchema.safeParse(parseJson(body));
      if (key === undefined || !ORDER_KEY_RE.test(key) || !input.success) {
        return json({ error: 'bad_request' }, 400);
      }
      const result = await directory.requestHandAnswer(owner, key, input.data);
      return result.ok
        ? answerRequest(owner, store.status === 'pending', result.requestId)
        : refused(result);
    }
    const requestPath = REQUEST_PATH_RE.exec(url.pathname);
    if (requestPath?.[1] !== undefined && request.method === 'GET') {
      const found = await getRequest(deps.db, owner, requestPath[1]);
      return found === undefined
        ? json({ error: 'not_found' }, 404)
        : json({ request: requestView(found) }, 200);
    }
    return json({ error: 'not_found' }, 404);
  };
}

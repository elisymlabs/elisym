/**
 * Hosted mode's client for PayCore's server (`packages/paycore-server/src/admin/api.ts`).
 * Every admin call, reads included, carries a fresh NIP-98 authorization by O
 * over the exact URL, method and body string sent. Authorizations alone are
 * dated by the server's clock: local time plus an offset learned from every
 * answer's `Date` header (exposed by the server's CORS); a call refused as
 * `stale` is signed again once, with the offset that answer brought. Owner
 * events are never dated this way: a far-future `Date` must not get them
 * signed ahead.
 */
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { OPERATOR_RE } from './hosted-config';
import { nip98Header } from './nip98';
import type { Signer } from './signer';
import type {
  CommitAnswer,
  ConfigInput,
  CreateStoreInput,
  HandInput,
  Meta,
  Network,
  OrdersView,
  OwnerEventKind,
  ProductInput,
  ProductRecord,
  RequestAnswer,
  RequestView,
  StoreConfig,
  StoreView,
} from './types';

/** A refusal by the server, `network` when no answer came, or `unexpected` for an unreadable one. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The `reason` of an `unauthorized` refusal. */
  readonly reason: string | undefined;
  readonly detail: Record<string, unknown>;

  constructor(status: number, code: string, detail: Record<string, unknown> = {}) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.reason = typeof detail.reason === 'string' ? detail.reason : undefined;
  }
}

/** The server's endpoints, typed. Screens take a `Pick` of this, so tests hand them fakes. */
export interface HostedApi {
  /** `GET /v1/meta`: public, unsigned. */
  meta(): Promise<Meta>;
  store(): Promise<StoreView>;
  /** Create the store, or open the one O already has. */
  createStore(input: CreateStoreInput): Promise<StoreView>;
  putConfig(input: ConfigInput): Promise<{ config: StoreConfig; requestId: string | null }>;
  suspend(): Promise<RequestAnswer>;
  products(): Promise<{ products: ProductRecord[] }>;
  product(d: string): Promise<{ product: ProductRecord }>;
  putProduct(
    d: string,
    input: ProductInput,
  ): Promise<{ product: ProductRecord; requestId: string | null }>;
  deleteProduct(d: string): Promise<{ outcome: string; requestId: string | null }>;
  prepareOwnerEvent(kind: OwnerEventKind): Promise<{ template: EventTemplate; expiresAt: number }>;
  commitOwnerEvent(event: NostrEvent): Promise<CommitAnswer>;
  /** The new webhook secret, in this one answer only. */
  rotateWebhookSecret(): Promise<{ secret: string; requestId: string | null }>;
  orders(): Promise<OrdersView>;
  handAnswer(orderKey: string, input: HandInput): Promise<RequestAnswer>;
  request(id: string): Promise<{ request: RequestView }>;
}

export interface HostedApiOptions {
  /** The API base, exactly as `/v1/meta` names its `publicBase`. */
  base: string;
  signer: Signer;
  fetch?: typeof fetch;
  /** Seconds. */
  localNow?: () => number;
}

const NETWORKS: readonly Network[] = ['mainnet', 'devnet'];
const HTTP_UNPROCESSABLE = 422;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** `/v1/meta` in its documented shape, or undefined: it gates the whole admin, so it is read strictly. */
export function parseMeta(value: unknown): Meta | undefined {
  if (!isRecord(value) || !isRecord(value.networks)) {
    return undefined;
  }
  const { publicBase, operator, inboxRelays, pendingMaxProducts } = value;
  if (
    typeof publicBase !== 'string' ||
    typeof operator !== 'string' ||
    !OPERATOR_RE.test(operator) ||
    !isStringArray(inboxRelays) ||
    typeof pendingMaxProducts !== 'number' ||
    !Number.isSafeInteger(pendingMaxProducts)
  ) {
    return undefined;
  }
  const networks: Meta['networks'] = {};
  for (const [name, entry] of Object.entries(value.networks)) {
    const network = NETWORKS.find((known) => known === name);
    if (network === undefined || !isRecord(entry) || !isStringArray(entry.coins)) {
      return undefined;
    }
    networks[network] = { coins: entry.coins };
  }
  return { publicBase, operator, networks, inboxRelays, pendingMaxProducts };
}

/** The server's clock less the local one, in seconds, from a `Date` header; undefined when there is none. */
export function serverOffset(date: string | null, localNow: number): number | undefined {
  if (date === null) {
    return undefined;
  }
  const parsedMs = Date.parse(date);
  return Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) - localNow : undefined;
}

/** The answer's text; empty when the body could not be read. */
async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

interface CallOptions {
  /** A 422 that carries its `request` is the request's failed outcome, not a refusal. */
  requestOutcome?: boolean;
}

export function createHostedApi(options: HostedApiOptions): HostedApi {
  const { base, signer } = options;
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const localNow = options.localNow ?? (() => Math.floor(Date.now() / 1000));
  let offset = 0;

  /** Send once; learn the clock from whatever answers. */
  const send = async (url: string, init: RequestInit) => {
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        // Never from a cache (an old `Date` would skew the clock), no cookies, no redirects.
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
    } catch {
      throw new ApiError(0, 'network');
    }
    const learned = serverOffset(response.headers.get('date'), localNow());
    if (learned !== undefined) {
      offset = learned;
    }
    return { response, learned: learned !== undefined };
  };

  const signedSend = async (method: string, url: string, body: string) => {
    const headers: Record<string, string> = {
      authorization: await nip98Header({
        signEvent: (template) => signer.signEvent(template),
        url,
        method,
        body,
        createdAt: localNow() + offset,
      }),
    };
    if (body !== '') {
      headers['content-type'] = 'application/json';
    }
    return send(url, { method, headers, ...(body === '' ? {} : { body }) });
  };

  const call = async <T>(
    method: string,
    path: string,
    payload?: unknown,
    callOptions: CallOptions = {},
  ): Promise<T> => {
    const url = `${base}${path}`;
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const first = await signedSend(method, url, body);
    let { response } = first;
    let text = await readText(response);
    let parsed = parseJson(text);
    const stale =
      response.status === 401 &&
      isRecord(parsed) &&
      parsed.error === 'unauthorized' &&
      parsed.reason === 'stale';
    // Once, and only when this answer told the server's time: the next one is dated by it.
    if (stale && first.learned) {
      ({ response } = await signedSend(method, url, body));
      text = await readText(response);
      parsed = parseJson(text);
    }
    const outcome =
      callOptions.requestOutcome === true &&
      response.status === HTTP_UNPROCESSABLE &&
      isRecord(parsed) &&
      isRecord(parsed.request);
    if (!response.ok && !outcome) {
      const detail = isRecord(parsed) ? parsed : {};
      throw new ApiError(
        response.status,
        typeof detail.error === 'string' ? detail.error : 'unexpected',
        detail,
      );
    }
    if (!isRecord(parsed)) {
      throw new ApiError(response.status, 'unexpected');
    }
    // The server this admin ships with answers in the documented shape.
    const answer: T = JSON.parse(text);
    return answer;
  };

  return {
    async meta() {
      const { response } = await send(`${base}/v1/meta`, { method: 'GET' });
      const meta = response.ok ? parseMeta(parseJson(await readText(response))) : undefined;
      if (meta === undefined) {
        throw new ApiError(response.status, 'unexpected');
      }
      return meta;
    },
    store: () => call('GET', '/v1/admin/store'),
    createStore: (input) => call('POST', '/v1/admin/store', input),
    putConfig: (input) => call('PUT', '/v1/admin/store/config', input),
    suspend: () => call('POST', '/v1/admin/store/suspend', undefined, { requestOutcome: true }),
    products: () => call('GET', '/v1/admin/products'),
    product: (d) => call('GET', `/v1/admin/products/${segment(d)}`),
    putProduct: (d, input) => call('PUT', `/v1/admin/products/${segment(d)}`, input),
    deleteProduct: (d) => call('DELETE', `/v1/admin/products/${segment(d)}`),
    prepareOwnerEvent: (kind) => call('POST', '/v1/admin/owner-events/prepare', { kind }),
    commitOwnerEvent: (event) =>
      call('POST', '/v1/admin/owner-events/commit', { event }, { requestOutcome: true }),
    rotateWebhookSecret: () => call('POST', '/v1/admin/webhook/secret'),
    orders: () => call('GET', '/v1/admin/orders'),
    handAnswer: (orderKey, input) =>
      call('POST', `/v1/admin/orders/${segment(orderKey)}/hand`, input, { requestOutcome: true }),
    request: (id) => call('GET', `/v1/admin/requests/${segment(id)}`),
  };
}

import { type StoreConfig, buildTicket, checkTicket, parseAddress } from '@elisym/comcore';
import { HEX_PUBKEY_RE } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { z } from 'zod';
import type { ServerState } from '../state/types';
import { WindowLimiter, ipKey } from './limits';

/** Tickets per IP (or IPv6 /64) per minute. */
const TICKETS_PER_IP_PER_MINUTE = 20;
const CLICKS_PER_IP_PER_MINUTE = 60;
const MINUTE_MS = 60_000;
const MAX_BODY_BYTES = 16 * 1024;
/** Short, so a widget release reaches every store's site within minutes. */
const WIDGET_MAX_AGE_SECS = 300;

const SessionRequestSchema = z.object({
  store: z.string().regex(HEX_PUBKEY_RE),
  visitor: z.string().regex(HEX_PUBKEY_RE),
});

const ClickRequestSchema = z.object({
  ticket: z.object({
    id: z.string(),
    pubkey: z.string(),
    created_at: z.number().int(),
    kind: z.number().int(),
    tags: z.array(z.array(z.string())),
    content: z.string(),
    sig: z.string(),
  }),
  address: z.string().max(512),
});

export interface GatewayDeps {
  state: ServerState;
  /** G's secret key: signs tickets. */
  gatewaySecretKey: Uint8Array;
  /** The store's current config (30496), as the worker's catalog cache reads it. */
  configFor: (owner: string) => StoreConfig | undefined;
  /** One turn's reservation: no ticket is issued once it no longer fits the budget (5.8). */
  reserveUsd: string;
  /** An active store read in full that has nothing to serve (no config, or one naming another assistant). */
  isUnservable: (owner: string) => boolean;
  /**
   * Whether an address is a listing in the store's cached catalog: only those
   * clicks are counted, so the counter cannot be grown with made-up addresses.
   */
  isListed: (owner: string, address: string) => boolean;
  /** The built `widget.js`, served at `GET /widget.js`; absent means not served here. */
  widgetScript?: string;
  now?: () => number;
}

export interface GatewayRequest {
  request: Request;
  /** The client address as the HTTP server saw it (behind the proxy: the forwarded one). */
  clientAddress: string;
}

function json(body: unknown, status: number, origin?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}),
    },
  });
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The gateway (3): `POST /v1/session` issues a session ticket signed by G to a
 * widget on an allowed origin of an active store with budget left, under
 * per-IP and per-store limits; `POST /v1/click` counts a handoff (advisory).
 */
export function createGateway(deps: GatewayDeps): (input: GatewayRequest) => Promise<Response> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const gatewayKey = getPublicKey(deps.gatewaySecretKey);
  const ticketsPerIp = new WindowLimiter(TICKETS_PER_IP_PER_MINUTE, MINUTE_MS);
  const ticketsPerStore = new WindowLimiter(0, MINUTE_MS);
  const clicksPerIp = new WindowLimiter(CLICKS_PER_IP_PER_MINUTE, MINUTE_MS);

  const allowedOrigin = (config: StoreConfig | undefined, origin: string | null) =>
    config !== undefined && origin !== null && config.origins.includes(origin) ? origin : undefined;

  const session = async ({ request, clientAddress }: GatewayRequest): Promise<Response> => {
    const parsed = SessionRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return json({ error: 'bad_request' }, 400);
    }
    const { store: owner, visitor } = parsed.data;
    // Refusals are readable by the page (no data, no credentials), so the widget shows its unavailable state instead of retrying.
    const requestOrigin = request.headers.get('origin') ?? undefined;
    const nowSecs = now();
    if (!ticketsPerIp.hit(ipKey(clientAddress), nowSecs * 1000)) {
      return json({ error: 'rate_limited' }, 429, requestOrigin);
    }
    const record = deps.state.store(owner);
    if (record === undefined) {
      return json({ error: 'forbidden' }, 403, requestOrigin);
    }
    // Only active stores are leased, so a store that is not has no config here (3, 4.1).
    if (record.status !== 'active') {
      return json({ unavailable: true, reason: 'inactive', contact: null }, 503, requestOrigin);
    }
    const config = deps.configFor(owner);
    if (config === undefined) {
      if (deps.isUnservable(owner)) {
        return json({ unavailable: true, reason: 'inactive', contact: null }, 503, requestOrigin);
      }
      // Active but its catalog is not loaded yet (a relay outage at boot): the widget retries later.
      return json({ error: 'not_ready' }, 503, requestOrigin);
    }
    const origin = allowedOrigin(config, request.headers.get('origin'));
    if (origin === undefined) {
      return json({ error: 'forbidden' }, 403, requestOrigin);
    }
    if (!ticketsPerStore.hit(owner, nowSecs * 1000, record.tier.ticketsPerStorePerMinute)) {
      return json({ error: 'rate_limited' }, 429, origin);
    }
    if (deps.state.budgetExhausted(owner, nowSecs, deps.reserveUsd)) {
      return json(
        { unavailable: true, reason: 'budget', contact: config.contact ?? null },
        503,
        origin,
      );
    }
    const ticket = finalizeEvent(
      buildTicket({ visitor, store: owner, now: nowSecs }),
      deps.gatewaySecretKey,
    );
    return json(
      { ticket, assistant: config.assistant, branding: record.tier.branding },
      200,
      origin,
    );
  };

  const click = async ({ request, clientAddress }: GatewayRequest): Promise<Response> => {
    const parsed = ClickRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return json({ error: 'bad_request' }, 400);
    }
    const ticket: NostrEvent = parsed.data.ticket;
    const owner = ticket.tags.find((tag) => tag[0] === 'store')?.[1];
    const visitor = ticket.tags.find((tag) => tag[0] === 'p')?.[1];
    const config = owner === undefined ? undefined : deps.configFor(owner);
    const origin = allowedOrigin(config, request.headers.get('origin'));
    if (owner === undefined || visitor === undefined || origin === undefined) {
      return json({ error: 'forbidden' }, 403);
    }
    // The limit runs before the signature check, so the gateway's CPU is bounded per IP too.
    if (!clicksPerIp.hit(ipKey(clientAddress), now() * 1000)) {
      return json({ error: 'rate_limited' }, 429, origin);
    }
    // An expired ticket still counts: a visitor may click a card long after the last ask, and clicks are advisory.
    const check = checkTicket(ticket, {
      gatewayKeys: [gatewayKey],
      store: owner,
      sender: visitor,
      now: now(),
    });
    const address = parseAddress(parsed.data.address);
    if (check === 'invalid' || address === undefined) {
      return json({ error: 'forbidden' }, 403, origin);
    }
    if (deps.isListed(owner, parsed.data.address)) {
      deps.state.countClick(owner, parsed.data.address);
    }
    return new Response(null, {
      status: 204,
      headers: { 'access-control-allow-origin': origin, vary: 'origin' },
    });
  };

  return async (input) => {
    const url = new URL(input.request.url);
    if (input.request.method === 'OPTIONS') {
      const origin = input.request.headers.get('origin');
      return new Response(null, {
        status: 204,
        headers: {
          ...(origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}),
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        },
      });
    }
    if (input.request.method === 'GET' && url.pathname === '/widget.js' && deps.widgetScript) {
      return new Response(deps.widgetScript, {
        status: 200,
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': `public, max-age=${WIDGET_MAX_AGE_SECS}`,
          'cross-origin-resource-policy': 'cross-origin',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    if (input.request.method === 'POST' && url.pathname === '/v1/session') {
      return session(input);
    }
    if (input.request.method === 'POST' && url.pathname === '/v1/click') {
      return click(input);
    }
    return json({ error: 'not_found' }, 404);
  };
}

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
    const config = deps.configFor(owner);
    const origin = allowedOrigin(config, request.headers.get('origin'));
    const record = deps.state.store(owner);
    if (config === undefined || record === undefined || origin === undefined) {
      return json({ error: 'forbidden' }, 403);
    }
    const nowSecs = now();
    if (!ticketsPerIp.hit(ipKey(clientAddress), nowSecs * 1000)) {
      return json({ error: 'rate_limited' }, 429, origin);
    }
    if (!ticketsPerStore.hit(owner, nowSecs * 1000, record.tier.ticketsPerStorePerMinute)) {
      return json({ error: 'rate_limited' }, 429, origin);
    }
    if (record.status !== 'active' || deps.state.budgetExhausted(owner, nowSecs)) {
      return json({ unavailable: 'budget', contact: config.contact ?? null }, 503, origin);
    }
    const ticket = finalizeEvent(
      buildTicket({ visitor, store: owner, now: nowSecs }),
      deps.gatewaySecretKey,
    );
    return json({ ticket, assistant: config.assistant }, 200, origin);
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
    if (!clicksPerIp.hit(ipKey(clientAddress), now() * 1000)) {
      return json({ error: 'rate_limited' }, 429, origin);
    }
    deps.state.countClick(owner, parsed.data.address);
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
    if (input.request.method === 'POST' && url.pathname === '/v1/session') {
      return session(input);
    }
    if (input.request.method === 'POST' && url.pathname === '/v1/click') {
      return click(input);
    }
    return json({ error: 'not_found' }, 404);
  };
}

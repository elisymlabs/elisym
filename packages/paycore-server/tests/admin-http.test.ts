import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WindowLimiter,
  bodyLimitOf,
  clientAddressOf,
  corsHeadersOf,
  ipKey,
  isCorsPath,
  serveGateway,
} from '../src/gateway/http';

describe('admin HTTP', () => {
  it('never reads an admin body without a NIP-98 header', () => {
    expect(bodyLimitOf('/v1/admin/store', undefined)).toBe('unauthorized');
    expect(bodyLimitOf('/v1/admin/store', 'Bearer x')).toBe('unauthorized');
    expect(bodyLimitOf('/v1/admin/store', 'Nostr abc=')).toBe(256 * 1024);
    expect(bodyLimitOf('/health', undefined)).toBe(16 * 1024);
  });

  it('takes the proxy-appended hop only behind the proxy', () => {
    const request = {
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
      socket: { remoteAddress: '10.0.0.2' },
    };
    expect(clientAddressOf(request, true)).toBe('2.2.2.2');
    expect(clientAddressOf(request, false)).toBe('10.0.0.2');
  });

  it('counts IPv6 by /64 and limits per window', () => {
    expect(ipKey('2001:db8:0:1::5')).toBe(ipKey('2001:db8:0:1:ffff::1'));
    expect(ipKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
    const limiter = new WindowLimiter(2, 1_000);
    expect([limiter.hit('a', 0), limiter.hit('a', 1), limiter.hit('a', 2)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limiter.hit('a', 1_000)).toBe(true);
  });
});

const ADMIN_ORIGIN = 'https://admin.paycore.example';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

/** A gateway on a free port whose handler answers 404 JSON, or throws on `/v1/admin/boom`. */
async function gateway(adminOrigin: string | undefined): Promise<string> {
  const server = serveGateway(
    async ({ request }) => {
      if (new URL(request.url).pathname === '/v1/admin/boom') {
        throw new Error('boom');
      }
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    },
    { port: 0, trustProxy: false, ...(adminOrigin === undefined ? {} : { adminOrigin }) },
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
}

function corsOf(response: Response): Record<string, string> {
  return Object.fromEntries(
    [...response.headers].filter(([name]) => name.startsWith('access-control-') || name === 'vary'),
  );
}

const ANSWER_HEADERS = {
  vary: 'origin',
  'access-control-allow-origin': ADMIN_ORIGIN,
  'access-control-expose-headers': 'date',
};

describe('admin HTTP: CORS (A2)', () => {
  it('answers a preflight from the admin origin with 204 and no body, before any auth check', async () => {
    const base = await gateway(ADMIN_ORIGIN);
    // The move route: its second NIP-98 header (the new owner key's) is allowed too.
    for (const [path, method, headers] of [
      ['/v1/admin/store/config', 'PUT', 'authorization, content-type'],
      ['/v1/meta', 'PUT', 'authorization, content-type'],
      ['/v1/admin/store/move', 'POST', 'authorization, content-type, x-new-owner-authorization'],
    ] as const) {
      const response = await fetch(`${base}${path}`, {
        method: 'OPTIONS',
        headers: {
          origin: ADMIN_ORIGIN,
          'access-control-request-method': method,
          'access-control-request-headers': headers,
        },
      });
      expect(response.status, path).toBe(204);
      expect(await response.text()).toBe('');
      expect(corsOf(response), path).toEqual({
        ...ANSWER_HEADERS,
        'access-control-allow-methods': 'GET, POST, PUT, DELETE',
        'access-control-allow-headers': 'authorization, content-type, x-new-owner-authorization',
        'access-control-max-age': '600',
      });
    }
  });

  it('gives another origin, or a request without one, no CORS headers', async () => {
    const base = await gateway(ADMIN_ORIGIN);
    for (const origin of [
      'https://evil.example',
      `${ADMIN_ORIGIN}/`,
      'https://ADMIN.paycore.example',
    ]) {
      const preflight = await fetch(`${base}/v1/admin/store`, {
        method: 'OPTIONS',
        headers: { origin },
      });
      expect(corsOf(preflight), origin).toEqual({ vary: 'origin' });
      const answer = await fetch(`${base}/v1/admin/store`, { headers: { origin } });
      expect(corsOf(answer), origin).toEqual({ vary: 'origin' });
    }
    expect(corsOf(await fetch(`${base}/v1/meta`))).toEqual({ vary: 'origin' });
  });

  it('puts the headers on the early 401 and 413, a 404, a 500, and exposes a Date', async () => {
    const base = await gateway(ADMIN_ORIGIN);
    const headers = { origin: ADMIN_ORIGIN };
    const unauthorized = await fetch(`${base}/v1/admin/store`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(unauthorized.status).toBe(401);
    expect(corsOf(unauthorized)).toEqual(ANSWER_HEADERS);
    const tooLarge = await fetch(`${base}/v1/admin/products/x`, {
      method: 'PUT',
      headers: { ...headers, authorization: 'Nostr abc=' },
      body: 'x'.repeat(300 * 1024),
    });
    expect(tooLarge.status).toBe(413);
    expect(corsOf(tooLarge)).toEqual(ANSWER_HEADERS);
    const notFound = await fetch(`${base}/v1/admin/nothing`, { headers });
    expect(notFound.status).toBe(404);
    expect(corsOf(notFound)).toEqual(ANSWER_HEADERS);
    expect(Number.isNaN(Date.parse(notFound.headers.get('date') ?? ''))).toBe(false);
    const failed = await fetch(`${base}/v1/admin/boom`, { headers });
    expect(failed.status).toBe(500);
    expect(corsOf(failed)).toEqual(ANSWER_HEADERS);
  });

  it('adds nothing outside the admin API and /v1/meta, nor without PAYCORE_ADMIN_ORIGIN', async () => {
    const withOrigin = await gateway(ADMIN_ORIGIN);
    const outside = await fetch(`${withOrigin}/healthz`, { headers: { origin: ADMIN_ORIGIN } });
    expect(corsOf(outside)).toEqual({});
    const preflightOutside = await fetch(`${withOrigin}/v1/other`, {
      method: 'OPTIONS',
      headers: { origin: ADMIN_ORIGIN },
    });
    expect(preflightOutside.status).toBe(404);
    expect(corsOf(preflightOutside)).toEqual({});
    const without = await gateway(undefined);
    const preflight = await fetch(`${without}/v1/admin/store`, {
      method: 'OPTIONS',
      headers: { origin: ADMIN_ORIGIN },
    });
    expect(preflight.status).toBe(204);
    expect(corsOf(preflight)).toEqual({});
    expect(
      corsOf(await fetch(`${without}/v1/meta`, { headers: { origin: ADMIN_ORIGIN } })),
    ).toEqual({});
  });

  it('builds the headers from the exact origin only', () => {
    const input = { adminOrigin: ADMIN_ORIGIN, path: '/v1/meta', preflight: false };
    expect(corsHeadersOf({ ...input, origin: ADMIN_ORIGIN })).toEqual(ANSWER_HEADERS);
    expect(corsHeadersOf({ ...input, origin: undefined })).toEqual({ vary: 'origin' });
    expect(corsHeadersOf({ ...input, path: '/v1/metadata', origin: ADMIN_ORIGIN })).toEqual({});
    expect(isCorsPath('/v1/admin/x')).toBe(true);
    expect(isCorsPath('/v1/adminx')).toBe(false);
  });
});

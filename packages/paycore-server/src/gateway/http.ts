/**
 * The HTTP server (copied from askr-server `gateway/http.ts` and `limits.ts`,
 * trimmed to the admin API): body caps read before routing, the client
 * address behind the proxy, and the per-IP window limiter.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { isIPv6 } from 'node:net';

/** A request as the handlers see it. */
export interface GatewayRequest {
  request: Request;
  /** The client address as the HTTP server saw it (behind the proxy: the forwarded one). */
  clientAddress: string;
}

const MAX_BODY_BYTES = 16 * 1024;
/** An admin call: a product (64 KiB description) or a config, with room to spare. */
const MAX_ADMIN_BODY_BYTES = 256 * 1024;
const ADMIN_PATH_PREFIX = '/v1/admin/';
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'DELETE']);
/** The shape of a NIP-98 header; checked before an admin body is read, the signature after. */
const NOSTR_AUTH_RE = /^Nostr [A-Za-z0-9+/=]+$/;
/** The public meta route (A2: CORS like the admin API). */
export const META_PATH = '/v1/meta';
/** How long a browser may keep a preflight answer. */
const CORS_MAX_AGE_SECS = 600;

/** Whether `path` answers the admin origin with CORS headers: the admin API and `/v1/meta`. */
export function isCorsPath(path: string): boolean {
  return path.startsWith(ADMIN_PATH_PREFIX) || path === META_PATH;
}

/**
 * The CORS headers of an answer (A2): for exactly `adminOrigin` (the `Origin`
 * header compared byte for byte) on a CORS path, else none but `vary`. A
 * preflight adds the methods, headers and max age. No credentials.
 */
export function corsHeadersOf(input: {
  adminOrigin: string | undefined;
  origin: string | undefined;
  path: string;
  preflight: boolean;
}): Record<string, string> {
  if (input.adminOrigin === undefined || !isCorsPath(input.path)) {
    return {};
  }
  if (input.origin !== input.adminOrigin) {
    return { vary: 'origin' };
  }
  return {
    vary: 'origin',
    'access-control-allow-origin': input.adminOrigin,
    'access-control-expose-headers': 'date',
    ...(input.preflight
      ? {
          'access-control-allow-methods': 'GET, POST, PUT, DELETE',
          'access-control-allow-headers': 'authorization, content-type, x-new-owner-authorization',
          'access-control-max-age': String(CORS_MAX_AGE_SECS),
        }
      : {}),
  };
}

/**
 * The body cap for a request by its normalized path, or `unauthorized` for an
 * admin body without a NIP-98 header, which is never read.
 */
export function bodyLimitOf(
  path: string,
  authorization: string | undefined,
): number | 'unauthorized' {
  if (!path.startsWith(ADMIN_PATH_PREFIX)) {
    return MAX_BODY_BYTES;
  }
  if (authorization === undefined || !NOSTR_AUTH_RE.test(authorization)) {
    return 'unauthorized';
  }
  return MAX_ADMIN_BODY_BYTES;
}

/**
 * The client address: the socket's, or behind our proxy the last
 * `x-forwarded-for` hop, the one the proxy itself appended (a client can only
 * forge hops to the left of it).
 */
export function clientAddressOf(
  request: Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string | undefined } },
  trustProxy: boolean,
): string {
  const forwarded = request.headers['x-forwarded-for'];
  const last = typeof forwarded === 'string' ? forwarded.split(',').at(-1)?.trim() : undefined;
  if (trustProxy && last) {
    return last;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

/** An IPv6 address as its eight groups, lower case and without leading zeros. */
function ipv6Groups(bare: string): string[] {
  const [head = '', tail = ''] = bare.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const groups = bare.includes('::')
    ? [
        ...headGroups,
        ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'),
        ...tailGroups,
      ]
    : headGroups;
  return groups.map((group) => group.toLowerCase().replace(/^0+(?=.)/u, ''));
}

/**
 * The key a per-IP limit counts under: the IPv4 address (an IPv4-mapped IPv6
 * one unwrapped), or the IPv6 /64 prefix, since one IPv6 host can rotate
 * through a whole /64.
 */
export function ipKey(address: string): string {
  const bare = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/u, '');
  if (!isIPv6(bare)) {
    return bare;
  }
  return `${ipv6Groups(bare).slice(0, 4).join(':')}::/64`;
}

/** A fixed-window counter: at most `limit` hits per key per window. */
export class WindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Count a hit; false when the key is over its limit in the current window.
   * Windows are created in time order and share one length, so pruning stops
   * at the first live one.
   */
  hit(key: string, nowMs: number): boolean {
    for (const [stored, window] of this.windows) {
      if (nowMs - window.start < this.windowMs) {
        break;
      }
      this.windows.delete(stored);
    }
    const window = this.windows.get(key);
    if (!window) {
      this.windows.set(key, { start: nowMs, count: 1 });
      return this.limit > 0;
    }
    if (window.count >= this.limit) {
      return false;
    }
    window.count += 1;
    return true;
  }
}

/**
 * The body, or undefined past the cap. An oversized body is not destroyed at
 * once: the 413 goes out with `connection: close`, so a client that finished
 * sending reads it.
 */
function readBody(request: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: unknown) => {
      if (tooLarge) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        resolve(undefined);
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => {
      if (!tooLarge) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    request.on('error', reject);
  });
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(Buffer.from(await response.arrayBuffer()));
}

async function handleIncoming(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handler: (input: GatewayRequest) => Promise<Response>,
  options: GatewayOptions,
): Promise<void> {
  const method = incoming.method ?? 'GET';
  const hasBody = METHODS_WITH_BODY.has(method);
  // Parsed as the handler's Request parses it, so the cap follows the path that is routed.
  const url = new URL(`http://localhost${incoming.url ?? '/'}`);
  const preflight = method === 'OPTIONS' && isCorsPath(url.pathname);
  // Set first: every answer below carries them, the early 401/413 and a 500 included.
  const cors = corsHeadersOf({
    adminOrigin: options.adminOrigin,
    origin: incoming.headers.origin,
    path: url.pathname,
    preflight,
  });
  for (const [name, value] of Object.entries(cors)) {
    outgoing.setHeader(name, value);
  }
  if (preflight) {
    outgoing.statusCode = 204;
    outgoing.end();
    return;
  }
  const limit = bodyLimitOf(url.pathname, incoming.headers.authorization);
  if (hasBody && limit === 'unauthorized') {
    outgoing.statusCode = 401;
    outgoing.setHeader('content-type', 'application/json');
    outgoing.setHeader('connection', 'close');
    outgoing.end(JSON.stringify({ error: 'unauthorized', reason: 'missing' }));
    return;
  }
  const body = hasBody && limit !== 'unauthorized' ? await readBody(incoming, limit) : undefined;
  if (hasBody && body === undefined) {
    outgoing.statusCode = 413;
    outgoing.setHeader('connection', 'close');
    outgoing.end();
    return;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    }
  }
  const request = new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  const response = await handler({
    request,
    clientAddress: clientAddressOf(incoming, options.trustProxy),
  });
  await writeResponse(response, outgoing);
}

export interface GatewayOptions {
  port: number;
  trustProxy: boolean;
  /** PAYCORE_ADMIN_ORIGIN: the one origin answered with CORS headers; unset: none. */
  adminOrigin?: string | undefined;
}

/** Serve a fetch-style handler over `node:http` (runs on Node and on Bun). */
export function serveGateway(
  handler: (input: GatewayRequest) => Promise<Response>,
  options: GatewayOptions,
): Server {
  const server = createServer((incoming, outgoing) => {
    handleIncoming(incoming, outgoing, handler, options).catch(() => {
      outgoing.statusCode = 500;
      outgoing.end();
    });
  });
  server.listen(options.port);
  return server;
}

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { GatewayRequest } from './gateway';

const MAX_BODY_BYTES = 16 * 1024;
/** Other admin calls: at most 20 O-signed events of 64 KiB each (7.3). */
const MAX_ADMIN_BODY_BYTES = 2 * 1024 * 1024;
/** `POST /v1/admin/catalog` carries a whole catalog (7.3). */
const MAX_CATALOG_BODY_BYTES = 8 * 1024 * 1024;
const ADMIN_PATH_PREFIX = '/v1/admin/';
const CATALOG_PATH = '/v1/admin/catalog';
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'DELETE']);
/** The shape of a NIP-98 header; checked before an admin body is read, the signature after. */
const NOSTR_AUTH_RE = /^Nostr [A-Za-z0-9+/=]+$/;

/**
 * The body cap for a request, by its normalized path (the one the handlers
 * route on, so `/v1/admin/../v1/session` is the gateway's), or `unauthorized`
 * for an admin body without a NIP-98 header, which is never read.
 */
export function bodyLimitOf(
  method: string,
  path: string,
  authorization: string | undefined,
): number | 'unauthorized' {
  if (!path.startsWith(ADMIN_PATH_PREFIX)) {
    return MAX_BODY_BYTES;
  }
  if (authorization === undefined || !NOSTR_AUTH_RE.test(authorization)) {
    return 'unauthorized';
  }
  return method === 'POST' && path === CATALOG_PATH ? MAX_CATALOG_BODY_BYTES : MAX_ADMIN_BODY_BYTES;
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

/**
 * The body, or undefined past the cap. An oversized body is not destroyed at
 * once: the 413 goes out with `connection: close`, so a client that finished
 * sending reads it; one still sending a very large body may see a reset.
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
  trustProxy: boolean,
): Promise<void> {
  const method = incoming.method ?? 'GET';
  const hasBody = METHODS_WITH_BODY.has(method);
  // Parsed as the handler's Request parses it, so the cap follows the path that is routed.
  const url = new URL(`http://localhost${incoming.url ?? '/'}`);
  const limit = bodyLimitOf(method, url.pathname, incoming.headers.authorization);
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
  const response = await handler({ request, clientAddress: clientAddressOf(incoming, trustProxy) });
  await writeResponse(response, outgoing);
}

/** Serve a fetch-style handler over `node:http` (runs on Node and on Bun). */
export function serveGateway(
  handler: (input: GatewayRequest) => Promise<Response>,
  options: { port: number; trustProxy: boolean },
): Server {
  const server = createServer((incoming, outgoing) => {
    handleIncoming(incoming, outgoing, handler, options.trustProxy).catch(() => {
      outgoing.statusCode = 500;
      outgoing.end();
    });
  });
  server.listen(options.port);
  return server;
}

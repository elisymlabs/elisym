import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { GatewayRequest } from './gateway';

const MAX_BODY_BYTES = 16 * 1024;

/**
 * The client address: the socket's, or behind the proxy (Caddy overwrites the
 * header, so a client cannot spoof it) the first `x-forwarded-for` hop.
 */
export function clientAddressOf(request: IncomingMessage, trustProxy: boolean): string {
  const forwarded = request.headers['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
  if (trustProxy && first) {
    return first;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
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
  const body = incoming.method === 'POST' ? await readBody(incoming) : undefined;
  if (incoming.method === 'POST' && body === undefined) {
    outgoing.statusCode = 413;
    outgoing.end();
    return;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    }
  }
  const request = new Request(`http://localhost${incoming.url ?? '/'}`, {
    method: incoming.method ?? 'GET',
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

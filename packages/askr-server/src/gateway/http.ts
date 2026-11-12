import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { GatewayRequest } from './gateway';

const MAX_BODY_BYTES = 16 * 1024;

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
function readBody(request: IncomingMessage): Promise<string | undefined> {
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
      if (size > MAX_BODY_BYTES) {
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
  const body = incoming.method === 'POST' ? await readBody(incoming) : undefined;
  if (incoming.method === 'POST' && body === undefined) {
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

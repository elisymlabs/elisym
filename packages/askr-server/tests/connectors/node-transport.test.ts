import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Server, createServer } from 'node:https';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { brotliCompressSync, createGzip, deflateSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FetchGuardError,
  type ResolvedAddress,
  type Transport,
  type TransportResponse,
  createNodeTransport,
  guardedFetch,
  nodeTransport,
} from '../../src/connectors/fetch-guard';
import { PUBLIC_IP } from './helpers';

// A self-signed certificate for `shop.test` (valid to 2126), checked in for these tests only.
const TLS_DIR = join(import.meta.dirname, 'fixtures', 'tls');
const CERT = readFileSync(join(TLS_DIR, 'shop-test.cert.pem'), 'utf8');
const KEY = readFileSync(join(TLS_DIR, 'shop-test.key.pem'), 'utf8');
const LOOPBACK: ResolvedAddress = { address: '127.0.0.1', family: 4 };
const BOMB_CAP = 64 * 1024;

interface Seen {
  host: string | undefined;
  servername: string | undefined;
  remoteAddress: string | undefined;
}

let server: Server;
let port = 0;
const seen: Seen[] = [];
let bombProduced = 0;
let bombClosed: Promise<void> = Promise.resolve();

function sendEncoded(response: ServerResponse, encoding: string, body: Buffer): void {
  response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': encoding });
  response.end(body);
}

/** An endless gzip stream of zeros: about 1000:1, so the wire stays small while decoded bytes grow. */
function sendBomb(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
  const zeros = new Readable({
    read() {
      bombProduced += 64 * 1024;
      this.push(Buffer.alloc(64 * 1024));
    },
  });
  bombClosed = new Promise((resolve) => {
    response.on('close', () => {
      zeros.destroy();
      resolve();
    });
  });
  zeros.pipe(createGzip()).pipe(response);
}

function handle(request: IncomingMessage, response: ServerResponse): void {
  const servername: unknown = Reflect.get(request.socket, 'servername');
  seen.push({
    host: request.headers.host,
    servername: typeof servername === 'string' ? servername : undefined,
    remoteAddress: request.socket.remoteAddress,
  });
  const text = Buffer.from('decoded text '.repeat(50));
  switch (request.url) {
    case '/gzip':
      return sendEncoded(response, 'gzip', gzipSync(text));
    case '/deflate':
      return sendEncoded(response, 'deflate', deflateSync(text));
    case '/br':
      return sendEncoded(response, 'br', brotliCompressSync(text));
    case '/bomb':
      return sendBomb(response);
    default:
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('hello from the pinned address');
  }
}

beforeAll(async () => {
  server = createServer({ key: KEY, cert: CERT }, handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server has no port');
  }
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const testTransport = createNodeTransport({ ca: CERT });

async function read(response: TransportResponse): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function get(transport: Transport, url: string, address: ResolvedAddress = LOOPBACK) {
  return transport({
    url: new URL(url),
    address,
    headers: { 'accept-encoding': 'gzip, deflate, br' },
    signal: AbortSignal.timeout(10_000),
  });
}

describe('nodeTransport (a real TLS connection to a local server)', () => {
  it('connects to the pinned address for a hostname DNS cannot resolve', async () => {
    // `.test` never resolves (RFC 6761): the only way to reach the server is the pinned lookup.
    const response = await get(testTransport, `https://shop.test:${port}/`);
    expect(response.status).toBe(200);
    expect(await read(response)).toBe('hello from the pinned address');
    const last = seen.at(-1);
    expect(last?.host).toBe(`shop.test:${port}`);
    expect(last?.servername).toBe('shop.test');
    expect(last?.remoteAddress).toBe('127.0.0.1');
  });

  it('still verifies the certificate against the URL hostname, not the pinned address', async () => {
    await expect(get(testTransport, `https://other.test:${port}/`)).rejects.toThrow(
      /altnames|does not match|ERR_TLS_CERT_ALTNAME_INVALID/u,
    );
  });

  it('the production transport trusts only the system store', async () => {
    await expect(get(nodeTransport, `https://shop.test:${port}/`)).rejects.toThrow(
      /self.signed|unable to verify|certificate/iu,
    );
  });

  it.each(['gzip', 'deflate', 'br'])('decodes a %s body', async (encoding) => {
    const response = await get(testTransport, `https://shop.test:${port}/${encoding}`);
    expect(await read(response)).toBe('decoded text '.repeat(50));
  });
});

describe('guardedFetch over the real transport', () => {
  /** Stands in for port 443 and a public answer: the guard passes, the connection goes to the local server. */
  const toLocalServer: Transport = (request) => {
    const url = new URL(request.url);
    url.port = String(port);
    return testTransport({ ...request, url, address: LOOPBACK });
  };
  const deps = { resolve: async () => [PUBLIC_IP], transport: toLocalServer };

  it('reads a compressed page whole', async () => {
    const response = await guardedFetch(
      'https://shop.test/gzip',
      { maxBytes: BOMB_CAP, timeoutMs: 10_000 },
      deps,
    );
    expect(response.body).toBe('decoded text '.repeat(50));
  });

  it('stops a gzip bomb at maxBytes of decoded data and drops the connection', async () => {
    bombProduced = 0;
    const started = Date.now();
    const failure = await guardedFetch(
      'https://shop.test/bomb',
      { maxBytes: BOMB_CAP, timeoutMs: 20_000 },
      deps,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(FetchGuardError);
    expect(failure instanceof FetchGuardError && failure.code).toBe('too_large');
    await bombClosed;
    expect(Date.now() - started).toBeLessThan(10_000);
    // The server stopped producing soon after the cap (stream buffers aside), far from endless.
    expect(bombProduced).toBeLessThan(64 * 1024 * 1024);
  });
});

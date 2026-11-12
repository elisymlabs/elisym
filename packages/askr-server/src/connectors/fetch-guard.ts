import { lookup as dnsLookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, type LookupFunction, isIP } from 'node:net';
import { type Readable, type Transform, pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { CONNECTOR_USER_AGENT, MAX_REDIRECTS } from './constants';

export type FetchGuardErrorCode =
  | 'invalid_url'
  | 'not_https'
  | 'port_not_allowed'
  | 'credentials_in_url'
  | 'blocked_address'
  | 'dns_failed'
  | 'too_many_redirects'
  | 'too_large'
  | 'timeout'
  | 'network';

export class FetchGuardError extends Error {
  constructor(
    readonly code: FetchGuardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FetchGuardError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Every address a hostname resolves to; all of them are checked, the first is connected to. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface TransportRequest {
  url: URL;
  /** The checked address: the connection goes here and nowhere else (no second DNS lookup). */
  address: ResolvedAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  /** The decoded (decompressed) body. */
  body: AsyncIterable<Uint8Array>;
  /** Stop reading and release the connection. */
  discard(): void;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface FetchGuardDeps {
  resolve?: Resolver;
  transport?: Transport;
}

export interface GuardedRequest {
  maxBytes: number;
  /** For the whole request, redirects included. */
  timeoutMs: number;
  accept?: string;
}

export interface GuardedResponse {
  /** The URL that answered, after redirects. */
  url: string;
  status: number;
  contentType: string;
  headers: Record<string, string | undefined>;
  body: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const IPV4_DENIED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  IPV4_DENIED.addSubnet(network, prefix, 'ipv4');
}

/**
 * IPv6 is allowed only inside global unicast 2000::/3, which already leaves out
 * loopback, unspecified, IPv4-mapped, NAT64, link-local, unique-local (and so
 * fd00:ec2::254) and multicast. Inside it, ranges that embed or tunnel to an
 * IPv4 address or are reserved for documentation are refused too.
 */
const IPV6_GLOBAL = new BlockList();
IPV6_GLOBAL.addSubnet('2000::', 3, 'ipv6');
const IPV6_DENIED = new BlockList();
for (const [network, prefix] of [
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) {
  IPV6_DENIED.addSubnet(network, prefix, 'ipv6');
}

/** Whether a literal IP address is publicly routable (7.4 fetch guards). */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/gu, '');
  if (bare.includes('%')) {
    return false;
  }
  try {
    const family = isIP(bare);
    if (family === 4) {
      return !IPV4_DENIED.check(bare, 'ipv4');
    }
    if (family === 6) {
      return IPV6_GLOBAL.check(bare, 'ipv6') && !IPV6_DENIED.check(bare, 'ipv6');
    }
  } catch {
    return false;
  }
  return false;
}

/** Parse and check a merchant-supplied URL: https, port 443, no credentials. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchGuardError('invalid_url', 'Not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new FetchGuardError('not_https', 'Only https URLs are fetched');
  }
  if (url.port !== '' && url.port !== '443') {
    throw new FetchGuardError('port_not_allowed', 'Only the default https port is fetched');
  }
  if (url.username !== '' || url.password !== '') {
    throw new FetchGuardError('credentials_in_url', 'URLs with credentials are not fetched');
  }
  if (url.hostname === '') {
    throw new FetchGuardError('invalid_url', 'The URL has no host');
  }
  return url;
}

function familyOf(address: string): 4 | 6 | undefined {
  const family = isIP(address);
  if (family === 4 || family === 6) {
    return family;
  }
  return undefined;
}

export const systemResolver: Resolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  const addresses: ResolvedAddress[] = [];
  for (const result of results) {
    const family = familyOf(result.address);
    if (family !== undefined) {
      addresses.push({ address: result.address, family });
    }
  }
  return addresses;
};

async function resolveChecked(url: URL, resolve: Resolver): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  const literalFamily = familyOf(host);
  if (literalFamily !== undefined) {
    if (!isPublicAddress(host)) {
      throw new FetchGuardError('blocked_address', 'The URL points to a non-public address');
    }
    return { address: host, family: literalFamily };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new FetchGuardError('dns_failed', `Could not resolve ${host}`);
  }
  const [first] = addresses;
  if (!first) {
    throw new FetchGuardError('dns_failed', `${host} has no address`);
  }
  // Every answer must be public: a mix lets a resolver round-robin us inward.
  if (!addresses.every((resolved) => isPublicAddress(resolved.address))) {
    throw new FetchGuardError('blocked_address', `${host} resolves to a non-public address`);
  }
  return first;
}

function decodedBody(response: IncomingMessage): Readable {
  const encoding = String(response.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase();
  let decoder: Transform | undefined;
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    decoder = createGunzip();
  } else if (encoding === 'deflate') {
    decoder = createInflate();
  } else if (encoding === 'br') {
    decoder = createBrotliDecompress();
  }
  if (decoder === undefined) {
    return response;
  }
  // The size cap is applied to the decoded bytes, so a compression bomb stops at the cap.
  return pipeline(response, decoder, () => undefined);
}

function flatHeaders(response: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

/**
 * The default transport: Node https with the connection pinned to the checked
 * address through a custom `lookup`, so the DNS answer that passed the check is
 * the one connected to (no rebinding between check and connect). TLS still
 * verifies the certificate against the URL's hostname (SNI is the hostname).
 */
export const nodeTransport: Transport = (request) =>
  new Promise((resolve, reject) => {
    const pinned = request.address;
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [pinned]);
      } else {
        callback(null, pinned.address, pinned.family);
      }
    };
    const outgoing = httpsRequest(
      request.url,
      {
        method: 'GET',
        headers: request.headers,
        signal: request.signal,
        agent: false,
        lookup,
      },
      (response) => {
        const body = decodedBody(response);
        resolve({
          status: response.statusCode ?? 0,
          headers: flatHeaders(response),
          body,
          discard: () => {
            body.destroy();
            response.destroy();
          },
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });

function abortError(): FetchGuardError {
  return new FetchGuardError('timeout', 'The request took too long');
}

/** Settle with `promise`, or reject as soon as `signal` aborts (a stuck resolver or peer). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readCapped(
  response: TransportResponse,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.discard();
    throw new FetchGuardError('too_large', 'The response is larger than allowed');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await raceAbort(iterator.next(), signal);
      if (step.done) {
        break;
      }
      total += step.value.byteLength;
      if (total > maxBytes) {
        throw new FetchGuardError('too_large', 'The response is larger than allowed');
      }
      chunks.push(step.value);
    }
  } catch (error) {
    response.discard();
    throw error;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(joined);
}

/**
 * GET a merchant-supplied URL under the 7.4 fetch guards: https on port 443
 * only; every resolved address public (private, loopback, link-local, CGNAT,
 * unique-local, IPv4-mapped, metadata and unspecified refused); redirects
 * followed by hand, at most `MAX_REDIRECTS`, each hop checked again; the body
 * streamed and cut off past `maxBytes`; one deadline for everything.
 */
export async function guardedFetch(
  rawUrl: string,
  request: GuardedRequest,
  deps: FetchGuardDeps = {},
): Promise<GuardedResponse> {
  const resolve = deps.resolve ?? systemResolver;
  const transport = deps.transport ?? nodeTransport;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    let url = checkUrl(rawUrl);
    for (let hop = 0; ; hop++) {
      const address = await raceAbort(resolveChecked(url, resolve), controller.signal);
      const response = await raceAbort(
        transport({
          url,
          address,
          headers: {
            'user-agent': CONNECTOR_USER_AGENT,
            accept: request.accept ?? '*/*',
            'accept-encoding': 'gzip, deflate, br',
          },
          signal: controller.signal,
        }),
        controller.signal,
      );
      const location = response.headers['location'];
      if (REDIRECT_STATUSES.has(response.status) && location !== undefined) {
        response.discard();
        if (hop >= MAX_REDIRECTS) {
          throw new FetchGuardError('too_many_redirects', 'Too many redirects');
        }
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          throw new FetchGuardError('invalid_url', 'The redirect target is not a valid URL');
        }
        url = checkUrl(next);
        continue;
      }
      const body = await readCapped(response, request.maxBytes, controller.signal);
      return {
        url: url.toString(),
        status: response.status,
        contentType: (response.headers['content-type'] ?? '').toLowerCase(),
        headers: response.headers,
        body,
      };
    }
  } catch (error) {
    if (error instanceof FetchGuardError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw abortError();
    }
    throw new FetchGuardError(
      'network',
      error instanceof Error ? error.message : 'The request failed',
    );
  } finally {
    clearTimeout(timer);
  }
}

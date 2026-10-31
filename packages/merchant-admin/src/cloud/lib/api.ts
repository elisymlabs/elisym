/**
 * The console's client for cloud-api (plan section 3): every request carries
 * a kind 27235 auth event for its exact URL, method and body, signed by the
 * owner key in the page. Auth events alone are dated by the server's clock (an
 * offset taken from each answer's `Date` header), so a skewed local clock still
 * signs in; owner events are never dated this way (section 3: a far-future
 * `Date` must not get them signed ahead).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { fieldOf } from './fields';
import type { OwnerSigner } from './owner-key';

export const HTTP_AUTH_KIND = 27235;
const SCHEME = 'Nostr ';

export interface ApiAnswer {
  status: number;
  body: unknown;
}

export type Fetcher = (request: Request) => Promise<Response>;

/** The auth header for one request, dated `createdAt`. */
export function authHeader(
  signer: OwnerSigner,
  url: string,
  method: string,
  body: Uint8Array | undefined,
  createdAt: number,
): string {
  const event = signer.sign({
    kind: HTTP_AUTH_KIND,
    created_at: createdAt,
    content: '',
    tags: [
      ['u', url],
      ['method', method.toUpperCase()],
      // Two equal requests in one second would otherwise be one event, the second refused as a replay.
      ['nonce', bytesToHex(crypto.getRandomValues(new Uint8Array(16)))],
      ...(body === undefined || body.length === 0 ? [] : [['payload', bytesToHex(sha256(body))]]),
    ],
  });
  const json = new TextEncoder().encode(JSON.stringify(event));
  let binary = '';
  for (const byte of json) {
    binary += String.fromCharCode(byte);
  }
  return `${SCHEME}${btoa(binary)}`;
}

/** The server's clock less the local one, in seconds, from a `Date` header; undefined when there is none. */
export function serverOffset(date: string | null, localNow: number): number | undefined {
  if (date === null) {
    return undefined;
  }
  const parsedMs = Date.parse(date);
  return Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) - localNow : undefined;
}

/** The `error` of an answer's JSON body, if any. */
export function errorCode(body: unknown): unknown {
  return fieldOf(body, 'error');
}

/** The answer for a request that reached no server (offline, refused, blocked): never a throw. */
export const UNREACHABLE: ApiAnswer = { status: 0, body: { error: 'unreachable' } };

/** An answer read as bytes (a file): `body` is its JSON when it is not one (a refusal). */
export interface BytesAnswer {
  status: number;
  bytes: Uint8Array<ArrayBuffer>;
  body: unknown;
}

export interface ConsoleApi {
  request(method: 'GET', path: string): Promise<ApiAnswer>;
  request(method: 'POST', path: string, body?: unknown): Promise<ApiAnswer>;
  /** A GET whose answer is a file, kept as its bytes (a text decode would corrupt it). */
  requestBytes(path: string): Promise<BytesAnswer>;
  /**
   * The server's clock now, from the last answer's `Date` (undefined before
   * any): what owner events are checked against, never what dates them.
   */
  serverNow(): number | undefined;
}

/**
 * A client bound to the API origin and the signer. The offset is learned from
 * every answer; a request refused as `stale` (its date outside the server's
 * window) is signed again once, with the offset that answer brought.
 */
export function createConsoleApi(options: {
  apiOrigin: string;
  signer: OwnerSigner;
  fetcher?: Fetcher;
  localNow?: () => number;
  /**
   * How long a request is waited for, its one retry included (none: as long as
   * the browser waits); past it, unreachable.
   */
  timeoutMs?: number;
}): ConsoleApi {
  const origin = new URL(options.apiOrigin).origin;
  const fetcher: Fetcher = options.fetcher ?? ((request) => fetch(request));
  const localNow = options.localNow ?? (() => Math.floor(Date.now() / 1000));
  let offset = 0;
  let learnedAny = false;

  async function send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    wantBytes: boolean,
    timeoutMs: number | undefined,
  ) {
    // Signed as cloud-api reads the URL it receives: the origin, the encoded path and the query.
    const parsed = new URL(path, origin);
    if (parsed.origin !== origin) {
      throw new Error('a cloud-api path stays on its origin');
    }
    const url = `${parsed.origin}${parsed.pathname}${parsed.search}`;
    const bytes = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
    const request = new Request(url, {
      method,
      // Never from the browser cache: a cached answer would replay an old Date (the clock offset).
      cache: 'no-store',
      headers: {
        authorization: authHeader(options.signer, url, method, bytes, localNow() + offset),
        ...(bytes === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(bytes === undefined ? {} : { body: bytes }),
      // The race below bounds the wait; the signal also drops the request where the browser has it.
      ...(timeoutMs === undefined || typeof AbortSignal.timeout !== 'function'
        ? {}
        : { signal: AbortSignal.timeout(timeoutMs) }),
    });
    let response: Response;
    let received: Uint8Array<ArrayBuffer>;
    try {
      const answered = async () => {
        const got = await fetcher(request);
        // A connection lost while the body arrives is as unreachable as one never made.
        return { got, body: new Uint8Array(await got.arrayBuffer()) };
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = (limitMs: number) =>
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), limitMs);
        });
      const result = await (timeoutMs === undefined
        ? answered()
        : Promise.race([answered(), timedOut(timeoutMs)]).finally(() => clearTimeout(timer)));
      response = result.got;
      received = result.body;
    } catch {
      return { ...UNREACHABLE, bytes: new Uint8Array(new ArrayBuffer(0)), learned: false };
    }

    const learned = serverOffset(response.headers.get('date'), localNow());
    if (learned !== undefined) {
      offset = learned;
      learnedAny = true;
    }
    // A file asked as bytes is never decoded (the archive holds a passphrase: no second copy as text).
    let answer: unknown;
    if (!(wantBytes && response.ok)) {
      const text = new TextDecoder().decode(received);
      answer = text;
      try {
        answer = JSON.parse(text);
      } catch {
        // Not JSON: kept as text.
      }
    }
    return {
      status: response.status,
      body: answer,
      bytes: received,
      learned: learned !== undefined,
    };
  }

  async function signedOnce(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    wantBytes: boolean,
  ) {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new Error('a cloud-api path starts with one /');
    }
    const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
    const left = () => (deadline === undefined ? undefined : deadline - Date.now());
    const first = await send(method, path, body, wantBytes, left());
    const stale = first.status === 401 && first.learned && errorCode(first.body) === 'stale';
    if (!stale) {
      return first;
    }
    const remaining = left();
    return remaining !== undefined && remaining <= 0
      ? { ...UNREACHABLE, bytes: new Uint8Array(new ArrayBuffer(0)), learned: false }
      : await send(method, path, body, wantBytes, remaining);
  }

  return {
    async request(method: 'GET' | 'POST', path: string, body?: unknown) {
      const answer = await signedOnce(method, path, body, false);
      return { status: answer.status, body: answer.body };
    },
    async requestBytes(path: string) {
      const answer = await signedOnce('GET', path, undefined, true);
      return { status: answer.status, bytes: answer.bytes, body: answer.body };
    },
    serverNow() {
      return learnedAny ? localNow() + offset : undefined;
    },
  };
}

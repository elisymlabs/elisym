import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { type RequestOptions, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPrivateAddress } from './services/identity-verify';

/** Largest body a guarded fetch reads (a nostr.json or a DNS-over-HTTPS answer is far smaller). */
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface GuardedFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Every address of a host name; `node:dns` by default. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** The HTTPS client; `node:https` by default (tests replace it). */
  request?: (
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => {
    on(event: 'error', listener: (error: Error) => void): unknown;
    setTimeout(ms: number, listener: () => void): unknown;
    destroy(error?: Error): unknown;
    end(): unknown;
  };
}

async function resolveAll(hostname: string): Promise<string[]> {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

function refused(reason: string): Error {
  return new Error(`guarded fetch refused: ${reason}`);
}

/**
 * A `fetch` for server-side reads of attacker-named hosts (a store's domain, a
 * DoH endpoint): `https:` only, to a DNS name whose every address is public,
 * connected to that exact address (the TLS certificate is still checked for
 * the name), no redirect followed, the body capped. Resolving once and pinning
 * the address leaves no window for a rebinding answer between the check and the
 * connection. Works under Node and Bun (both implement `node:https`).
 */
export function createGuardedFetch(
  options: GuardedFetchOptions = {},
): (input: string, init?: RequestInit) => Promise<Response> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolve = options.resolve ?? resolveAll;
  const send = options.request ?? httpsRequest;
  return async (input, init = {}) => {
    const url = new URL(input);
    if (url.protocol !== 'https:') {
      throw refused('only https');
    }
    if (url.username !== '' || url.password !== '') {
      throw refused('credentials in the URL');
    }
    // An IP literal names no domain; a bracketed IPv6 host is one too.
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) {
      throw refused('an IP address');
    }
    const addresses = await resolve(url.hostname);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw refused('a private or unknown address');
    }
    const address = addresses[0] as string;
    const headers = new Headers(init.headers);
    headers.set('host', url.host);
    return await new Promise<Response>((resolveResponse, reject) => {
      const outgoing = send(
        {
          host: address,
          servername: url.hostname,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: init.method ?? 'GET',
          headers: Object.fromEntries(headers.entries()),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          // A status a Response cannot hold would throw inside a listener,
          // out of reach of this promise.
          if (status < 200 || status > 599) {
            response.resume();
            reject(refused(`status ${status}`));
            return;
          }
          if (status >= 300 && status < 400) {
            response.resume();
            // Never followed: another host could answer for this one.
            reject(refused('a redirect'));
            return;
          }
          const chunks: Uint8Array[] = [];
          let size = 0;
          response.on('data', (chunk: Uint8Array) => {
            size += chunk.length;
            if (size > maxBytes) {
              response.destroy();
              reject(refused('the body is too large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (typeof value === 'string') {
                responseHeaders.set(name, value);
              } else if (Array.isArray(value)) {
                responseHeaders.set(name, value.join(', '));
              }
            }
            const body = Buffer.concat(chunks);
            try {
              resolveResponse(
                new Response(status === 204 || status === 304 ? null : body, {
                  status,
                  headers: responseHeaders,
                }),
              );
            } catch (error) {
              reject(error);
            }
          });
          response.on('error', reject);
        },
      );
      outgoing.on('error', reject);
      outgoing.setTimeout(timeoutMs, () => outgoing.destroy(refused('timed out')));
      init.signal?.addEventListener('abort', () => outgoing.destroy(refused('aborted')), {
        once: true,
      });
      outgoing.end();
    });
  };
}

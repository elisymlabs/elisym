import { bytesToHex } from 'nostr-tools/utils';
import type { Signer } from './signer';
import { randomHex } from './signer';

export const KIND_HTTP_AUTH = 27235;
/** Bytes of the random `nonce` tag: every authorization gets a new event id (the server refuses a replayed id). */
const NONCE_BYTES = 16;

export async function sha256Hex(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return bytesToHex(new Uint8Array(digest));
}

function base64OfUtf8(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export interface Nip98Input {
  signer: Signer;
  /** The full URL the request goes to: the API base plus the path and query. */
  url: string;
  method: string;
  /** The exact body string sent; empty for none. */
  body: string;
  now?: number;
}

/**
 * The `Authorization` header for one admin call (7.3): a kind 27235 event
 * signed by O with `u`, `method`, a `payload` SHA-256 of the body when there
 * is one, and a random `nonce`, as `Nostr <base64 of the event JSON>`.
 */
export async function nip98Header(input: Nip98Input): Promise<string> {
  const tags: string[][] = [
    ['u', input.url],
    ['method', input.method.toUpperCase()],
  ];
  if (input.body !== '') {
    tags.push(['payload', await sha256Hex(input.body)]);
  }
  tags.push(['nonce', randomHex(NONCE_BYTES)]);
  const event = await input.signer.signEvent({
    kind: KIND_HTTP_AUTH,
    created_at: input.now ?? Math.floor(Date.now() / 1000),
    tags,
    content: '',
  });
  return `Nostr ${base64OfUtf8(JSON.stringify(event))}`;
}

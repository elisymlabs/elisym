import { createHash } from 'node:crypto';
import type { NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import { z } from 'zod';

export const KIND_HTTP_AUTH = 27235;
/** An authorization is accepted only this close to the server's clock (7.3). */
export const AUTH_WINDOW_SECS = 60;
const MAX_HEADER_BYTES = 8 * 1024;
const HEX_RE = /^[0-9a-f]+$/;

const AuthEventSchema = z.object({
  id: z.string().length(64).regex(HEX_RE),
  pubkey: z.string().length(64).regex(HEX_RE),
  created_at: z.number().int(),
  kind: z.literal(KIND_HTTP_AUTH),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string().length(128).regex(HEX_RE),
});

export type AuthCheck =
  | { ok: true; pubkey: string; event: NostrEvent }
  | {
      ok: false;
      reason: 'missing' | 'malformed' | 'signature' | 'stale' | 'url' | 'method' | 'payload';
    };

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * A NIP-98 authorization (7.3): `Authorization: Nostr <base64 event>`, kind
 * 27235, signed, within the window, `u` equal to the public base plus the
 * path and query (never the proxied internal URL), `method` equal, and a
 * `payload` equal to the body's SHA-256 whenever there is a body. Replay is
 * the caller's check, by event id.
 */
export function checkNip98(input: {
  header: string | null;
  method: string;
  publicUrl: string;
  body: string;
  now: number;
}): AuthCheck {
  if (input.header === null) {
    return { ok: false, reason: 'missing' };
  }
  const match = /^Nostr ([A-Za-z0-9+/=]+)$/.exec(input.header);
  const encoded = match?.[1];
  if (encoded === undefined || encoded.length > MAX_HEADER_BYTES) {
    return { ok: false, reason: 'malformed' };
  }
  let parsed;
  try {
    parsed = AuthEventSchema.safeParse(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!parsed.success) {
    return { ok: false, reason: 'malformed' };
  }
  const event: NostrEvent = parsed.data;
  if (!verifyEvent(event)) {
    return { ok: false, reason: 'signature' };
  }
  if (Math.abs(event.created_at - input.now) > AUTH_WINDOW_SECS) {
    return { ok: false, reason: 'stale' };
  }
  if (tagValue(event, 'u') !== input.publicUrl) {
    return { ok: false, reason: 'url' };
  }
  if (tagValue(event, 'method')?.toUpperCase() !== input.method.toUpperCase()) {
    return { ok: false, reason: 'method' };
  }
  const payload = tagValue(event, 'payload');
  if ((input.body !== '' || payload !== undefined) && payload !== sha256Hex(input.body)) {
    return { ok: false, reason: 'payload' };
  }
  return { ok: true, pubkey: event.pubkey, event };
}

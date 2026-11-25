import { createHmac, timingSafeEqual } from 'node:crypto';

/** A shop's myshopify host, the only form a shop is named by here. */
export const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/u;
/** Clock skew allowed on a session token's `exp` and `nbf` (plan 3.2). */
export const SESSION_TOKEN_SKEW_SECS = 10;
const MAX_TOKEN_CHARS = 8 * 1024;

export type SessionTokenCheck =
  | { ok: true; shop: string; sub: string | undefined }
  | {
      ok: false;
      reason: 'missing' | 'malformed' | 'signature' | 'audience' | 'expired' | 'early' | 'shop';
    };

function base64UrlJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string') {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.hostname : undefined;
  } catch {
    return undefined;
  }
}

function equalBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * An App Bridge session (ID) token from `Authorization: Bearer <token>` (plan 3.2): HS256 with
 * the app secret, `aud` the API key, `exp`/`nbf` within the skew, `iss` and `dest` on the same
 * `*.myshopify.com` host. The shop is that host.
 */
export function checkSessionToken(input: {
  header: string | null;
  apiKey: string;
  apiSecret: string;
  now: number;
}): SessionTokenCheck {
  if (input.header === null) {
    return { ok: false, reason: 'missing' };
  }
  const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(
    input.header,
  )?.[1];
  if (token === undefined || token.length > MAX_TOKEN_CHARS) {
    return { ok: false, reason: 'malformed' };
  }
  const [headerPart = '', payloadPart = '', signaturePart = ''] = token.split('.');
  const header = base64UrlJson(headerPart);
  const payload = base64UrlJson(payloadPart);
  if (
    typeof header !== 'object' ||
    header === null ||
    Reflect.get(header, 'alg') !== 'HS256' ||
    typeof payload !== 'object' ||
    payload === null
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const expected = createHmac('sha256', input.apiSecret)
    .update(`${headerPart}.${payloadPart}`)
    .digest();
  if (!equalBytes(Buffer.from(signaturePart, 'base64url'), expected)) {
    return { ok: false, reason: 'signature' };
  }
  const claim = (name: string): unknown => Reflect.get(payload, name);
  const aud = claim('aud');
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(input.apiKey)) {
    return { ok: false, reason: 'audience' };
  }
  const exp = claim('exp');
  const nbf = claim('nbf');
  if (typeof exp !== 'number' || input.now > exp + SESSION_TOKEN_SKEW_SECS) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof nbf !== 'number' || nbf > input.now + SESSION_TOKEN_SKEW_SECS) {
    return { ok: false, reason: 'early' };
  }
  const dest = hostOf(claim('dest'));
  const iss = hostOf(claim('iss'));
  if (dest === undefined || iss !== dest || !SHOP_DOMAIN_RE.test(dest)) {
    return { ok: false, reason: 'shop' };
  }
  const sub = claim('sub');
  return { ok: true, shop: dest, sub: typeof sub === 'string' ? sub : undefined };
}

/** Whether a webhook's `X-Shopify-Hmac-Sha256` is the base64 HMAC-SHA256 of the raw body. */
export function webhookSigned(rawBody: Buffer, header: string | null, apiSecret: string): boolean {
  if (header === null || header.length > 128) {
    return false;
  }
  const expected = createHmac('sha256', apiSecret).update(rawBody).digest();
  return equalBytes(Buffer.from(header, 'base64'), expected);
}

import { npubEncode } from 'nostr-tools/nip19';
import { FETCH_TIMEOUT_MS, MAX_VERIFICATION_BYTES } from './constants';
import { FetchGuardError } from './fetch-guard';
import { metaContents } from './html';
import type { ShopHttp } from './http';

export const VERIFICATION_META_NAME = 'askr-verification';
export const WELL_KNOWN_PATH = '/.well-known/askr';

export type VerificationFailureReason =
  /** A feed product links to an origin the store's config does not list. */
  | 'not_configured'
  /** Neither the meta tag nor `/.well-known/askr` names the owner. */
  | 'not_found'
  /** Neither page could be read. */
  | 'fetch_failed';

export interface VerificationFailure {
  origin: string;
  reason: VerificationFailureReason;
}

type PageRead = { kind: 'page'; body: string } | { kind: 'missing' } | { kind: 'failed' };

/**
 * A page of `origin` itself: a 200 whose final URL (after redirects) is still
 * on `origin`. A redirect to another origin proves nothing about this one.
 */
async function readOwnPage(http: ShopHttp, origin: string, path: string): Promise<PageRead> {
  try {
    const response = await http.get(`${origin}${path}`, {
      maxBytes: MAX_VERIFICATION_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      accept: 'text/html, text/plain',
    });
    if (response.status !== 200 || new URL(response.url).origin !== origin) {
      return { kind: 'missing' };
    }
    return { kind: 'page', body: response.body };
  } catch (error) {
    if (error instanceof FetchGuardError) {
      return { kind: 'failed' };
    }
    throw error;
  }
}

/**
 * Domain verification (7.4): `/.well-known/askr` containing the owner's npub,
 * or `<meta name="askr-verification" content="{npub}">` on the home page.
 * Returns the failure reason, or undefined when verified.
 */
export async function verifyOrigin(
  http: ShopHttp,
  origin: string,
  owner: string,
): Promise<VerificationFailureReason | undefined> {
  const npub = npubEncode(owner);
  const wellKnown = await readOwnPage(http, origin, WELL_KNOWN_PATH);
  if (wellKnown.kind === 'page' && wellKnown.body.split(/\s+/u).includes(npub)) {
    return undefined;
  }
  const home = await readOwnPage(http, origin, '/');
  if (home.kind === 'page' && metaContents(home.body, VERIFICATION_META_NAME).includes(npub)) {
    return undefined;
  }
  return wellKnown.kind === 'failed' && home.kind === 'failed' ? 'fetch_failed' : 'not_found';
}

/**
 * Verify every origin in `origins`: each must be one of the store's configured
 * `origin`/`link-origin` entries, and each must name the owner.
 */
export async function verifyOrigins(
  http: ShopHttp,
  origins: readonly string[],
  configured: readonly string[],
  owner: string,
): Promise<VerificationFailure[]> {
  const failures: VerificationFailure[] = [];
  for (const origin of new Set(origins)) {
    if (!configured.includes(origin)) {
      failures.push({ origin, reason: 'not_configured' });
      continue;
    }
    const reason = await verifyOrigin(http, origin, owner);
    if (reason !== undefined) {
      failures.push({ origin, reason });
    }
  }
  return failures;
}

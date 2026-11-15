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
  | 'fetch_failed'
  /**
   * The home page refused the connector (401, 403, 429 or 503), and
   * `/.well-known/askr` could not be read either: most often a bot check in
   * front of the whole shop, so neither proof can be seen.
   */
  | 'blocked';

export interface VerificationFailure {
  origin: string;
  reason: VerificationFailureReason;
}

type PageRead =
  | { kind: 'page'; body: string }
  | { kind: 'missing' }
  | { kind: 'blocked' }
  | { kind: 'failed' };

/** Statuses a bot check or a locked site answers with: the page is there, the reader is refused. */
const REFUSED_STATUSES = new Set([401, 403, 429, 503]);

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
    if (new URL(response.url).origin !== origin) {
      return { kind: 'missing' };
    }
    if (REFUSED_STATUSES.has(response.status)) {
      return { kind: 'blocked' };
    }
    if (response.status !== 200) {
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
  // A readable well-known path (missing, or without the npub) is still a way in: not blocked.
  if (home.kind === 'blocked' && (wellKnown.kind === 'blocked' || wellKnown.kind === 'failed')) {
    return 'blocked';
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

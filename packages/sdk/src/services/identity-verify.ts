/**
 * Lazy verification of external identity claims (NIP-39 github/x + NIP-05
 * website). Fetches ONE public proof endpoint per platform, on demand, for a
 * single agent - discovery listings never call this (cheapness contract).
 *
 * Browser-safe main-entry module: the only Node builtin (`node:dns`, the
 * NIP-05 SSRF guard) loads via a lazy dynamic import behind a runtime check,
 * same shape as the `@number0/iroh` import in transport/iroh.ts. Bundlers
 * that externalize `node:dns` to a throwing stub stay safe behind the check.
 */

import { nip19 } from 'nostr-tools';
import {
  DEFAULTS,
  GIST_ID_REGEX,
  GITHUB_USERNAME_REGEX,
  LIMITS,
  TWEET_ID_REGEX,
  X_USERNAME_REGEX,
  utf8ByteLength,
} from '../constants';
import type { AgentExternalIdentity, IdentityVerifyStatus, VerifiedIdentityResult } from '../types';

const HEX_PUBKEY_REGEX = /^[0-9a-f]{64}$/;

// --- NIP-05 identifier normalization (shared with agent-store schema and the
// --- kind-0 parser in discovery.ts - symmetric enforcement on write and read)

const NIP05_LOCAL_REGEX = /^[a-z0-9-_.]+$/;
/** One hostname label: ASCII lowercase alphanumeric/hyphen, no leading/trailing hyphen (permits `xn--` punycode). */
const HOSTNAME_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOTTED_DECIMAL_REGEX = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const MAX_HOSTNAME_LENGTH = 253;

/**
 * Hostname labels are ASCII-only: `xn--` punycode is permitted, raw Unicode is
 * rejected - an IDN lookalike would fetch the punycode host while displaying
 * the homograph. IP literals are rejected too: a nip05 host must be a DNS
 * name, which keeps the DNS-guard semantics deterministic.
 */
function isValidNip05Hostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > MAX_HOSTNAME_LENGTH) {
    return false;
  }
  if (DOTTED_DECIMAL_REGEX.test(hostname)) {
    return false;
  }
  // Bracketed IPv6 (or any colon form) fails the label charset below.
  const labels = hostname.split('.');
  return labels.every((label) => HOSTNAME_LABEL_REGEX.test(label));
}

/**
 * Normalize a website identity claim to a full NIP-05 identifier:
 * lowercases, expands a bare domain to the `_@domain` root form, validates
 * the local part and hostname. Returns `null` when invalid.
 */
export function normalizeNip05Identifier(value: string): string | null {
  if (value.length === 0 || value.length > LIMITS.MAX_IDENTITY_NIP05_LENGTH) {
    return null;
  }
  const lowered = value.toLowerCase();
  const identifier = lowered.includes('@') ? lowered : `_@${lowered}`;
  const atIndex = identifier.indexOf('@');
  if (identifier.indexOf('@', atIndex + 1) !== -1) {
    return null;
  }
  const local = identifier.slice(0, atIndex);
  const domain = identifier.slice(atIndex + 1);
  if (local.length === 0 || !NIP05_LOCAL_REGEX.test(local)) {
    return null;
  }
  if (!isValidNip05Hostname(domain)) {
    return null;
  }
  return identifier;
}

/** Split an already-normalized NIP-05 identifier into local part and domain. */
export function splitNip05Identifier(identifier: string): { local: string; domain: string } {
  const atIndex = identifier.indexOf('@');
  if (atIndex === -1) {
    throw new Error(`Not a normalized NIP-05 identifier: ${identifier}`);
  }
  return { local: identifier.slice(0, atIndex), domain: identifier.slice(atIndex + 1) };
}

// --- Runtime environment ---

function isNodeRuntime(): boolean {
  // Property access via globalThis, never a bare `process` identifier: a free
  // `process` in the browser-safe entry makes bundler polyfill plugins inject
  // shim imports into the built SDK (vite-plugin-node-polyfills scans free
  // identifiers), which breaks consumers with isolated node_modules layouts.
  const candidate = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof candidate?.versions?.node === 'string';
}

// --- DNS private-range guard (NIP-05 only - the one user-controlled host) ---

export type HostAddressResolver = (hostname: string) => Promise<string[]>;

async function resolveWithNodeDns(hostname: string): Promise<string[]> {
  const dns = await import('node:dns');
  const entries = await dns.promises.lookup(hostname, { all: true });
  return entries.map((entry) => entry.address);
}

function isPrivateIpv4(octets: number[]): boolean {
  const [first, second] = octets;
  if (first === undefined || second === undefined) {
    return true;
  }
  if (first === 0 || first === 10 || first === 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true; // link-local
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return true; // CGNAT shared address space
  }
  return false;
}

function parseIpv4Octets(text: string): number[] | null {
  const dotted = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted === null) {
    return null;
  }
  const octets = dotted.slice(1).map((octet) => Number.parseInt(octet, 10));
  return octets.some((octet) => octet > 255) ? null : octets;
}

/**
 * Expand an IPv6 textual address to its full 8 hextets so non-canonical
 * spellings (`0::1`, `0:0:0:0:0:0:0:1`) cannot dodge the range checks.
 * Returns null for anything that does not parse - the guard refuses those.
 */
function parseIpv6Hextets(lowered: string): number[] | null {
  const sections = lowered.split('::');
  if (sections.length > 2) {
    return null;
  }
  const groupsOf = (raw: string): number[] | null => {
    if (raw === '') {
      return [];
    }
    const out: number[] = [];
    for (const group of raw.split(':')) {
      if (group.includes('.')) {
        const octets = parseIpv4Octets(group);
        const [a, b, c, d] = octets ?? [];
        if (a === undefined || b === undefined || c === undefined || d === undefined) {
          return null;
        }
        out.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return null;
      }
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = groupsOf(sections[0] ?? '');
  const tail = sections.length === 2 ? groupsOf(sections[1] ?? '') : [];
  if (head === null || tail === null) {
    return null;
  }
  if (sections.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) {
      return null;
    }
    return [...head, ...(new Array(fill).fill(0) as number[]), ...tail];
  }
  return head.length === 8 ? head : null;
}

/**
 * True when the address is private / loopback / link-local / ULA - or cannot
 * be parsed at all (unparseable resolver output is rejected, never fetched).
 */
export function isPrivateAddress(address: string): boolean {
  const lowered = address.toLowerCase();
  const octets = parseIpv4Octets(lowered);
  if (octets !== null) {
    return isPrivateIpv4(octets);
  }
  if (!lowered.includes(':')) {
    return true; // neither IPv4 nor IPv6 - refuse
  }
  const hextets = parseIpv6Hextets(lowered);
  if (hextets === null) {
    return true; // unparseable resolver output - refuse
  }
  const first = hextets[0] ?? 0;
  if (hextets.slice(0, 6).every((hextet) => hextet === 0)) {
    // :: (unspecified), ::1 (loopback), and the whole deprecated
    // IPv4-compatible ::/96 block (::a.b.c.d) - refuse outright.
    return true;
  }
  if (
    hextets.slice(0, 4).every((hextet) => hextet === 0) &&
    hextets[4] === 0xffff &&
    hextets[5] === 0
  ) {
    return true; // SIIT ::ffff:0:a.b.c.d reserved space
  }
  if (hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff) {
    const high = hextets[6] ?? 0;
    const low = hextets[7] ?? 0;
    return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]); // IPv4-mapped
  }
  if (first >= 0xfc00 && first <= 0xfdff) {
    return true; // ULA fc00::/7
  }
  if (first >= 0xfe80 && first <= 0xfebf) {
    return true; // link-local fe80::/10
  }
  if (first >= 0xfec0 && first <= 0xfeff) {
    return true; // deprecated site-local fec0::/10
  }
  return false;
}

// --- Guarded proof fetch (shared by the three verifiers) ---

// Browser `fetch` brand-checks `this`: the verifier calls it as a method of
// its context object (`ctx.fetchImpl(...)`), which would pass `this = ctx`
// and throw "Illegal invocation" before any request is made. Wrap so the
// global is always invoked as a free function.
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

type ProofFetchResult =
  | { outcome: 'ok'; body: string }
  | { outcome: 'http-error'; status: number }
  // Network error, timeout, redirect, non-https URL, or body over the cap -
  // all map to `unverifiable` (a truncated body must never be searched).
  | { outcome: 'failed' };

interface GuardedFetchContext {
  fetchImpl: typeof fetch;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (response.body === null) {
    // Environments without response streaming (some fetch mocks): fall back
    // to text() and apply the cap after the fact.
    const text = await response.text();
    return utf8ByteLength(text) > maxBytes ? null : text;
  }
  // Blossom download() streaming posture: bound memory on the ACTUAL streamed
  // bytes, never the declared Content-Length.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
    chunk = await reader.read();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function guardedFetchProof(url: string, ctx: GuardedFetchContext): Promise<ProofFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { outcome: 'failed' };
  }
  if (parsed.protocol !== 'https:') {
    return { outcome: 'failed' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULTS.IDENTITY_PROOF_FETCH_TIMEOUT_MS);
  try {
    const response = await ctx.fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      // Verification must be live: never serve a proof from the browser HTTP
      // cache (the module-level TTL cache above is the only caching layer).
      cache: 'no-store',
    });
    if (!response.ok) {
      // Release the connection - the error body is never read.
      void response.body?.cancel().catch(() => undefined);
      return { outcome: 'http-error', status: response.status };
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > LIMITS.MAX_IDENTITY_PROOF_BYTES) {
      return { outcome: 'failed' };
    }
    const body = await readBodyCapped(response, LIMITS.MAX_IDENTITY_PROOF_BYTES);
    if (body === null) {
      return { outcome: 'failed' };
    }
    return { outcome: 'ok', body };
  } catch {
    return { outcome: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

// --- Proof body normalization + template matching ---

const HTML_TAG_REGEX = /<[^>]*>/g;
const MAX_ENTITY_CODE_POINT = 0x10ffff;

function decodeNumericEntity(codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > MAX_ENTITY_CODE_POINT) {
    return ' ';
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return ' ';
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
};

// Single pass over the body, so a decoded entity's output is never re-scanned
// (`&amp;quot;` yields the literal text `&quot;`, `&#x26;#34;` yields `&#34;`).
function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|(quot|amp|lt|gt));/gi,
    (match, hex: string | undefined, digits: string | undefined, named: string | undefined) => {
      if (hex !== undefined) {
        return decodeNumericEntity(Number.parseInt(hex, 16));
      }
      if (digits !== undefined) {
        return decodeNumericEntity(Number.parseInt(digits, 10));
      }
      if (named !== undefined) {
        return NAMED_ENTITIES[named.toLowerCase()] ?? match;
      }
      return match;
    },
  );
}

function normalizeQuotes(text: string): string {
  return text.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');
}

/**
 * Normalize a fetched proof body before template matching. For oEmbed html
 * payloads, tags are stripped to spaces and HTML entities decoded first
 * (live X payloads carry `&quot;` quotes and `<br>` line breaks); then, for
 * all platforms: quote-normalize (smart to straight), case-fold, collapse
 * whitespace.
 */
function normalizeProofBody(body: string, opts: { html: boolean }): string {
  const plain = opts.html ? decodeHtmlEntities(body.replace(HTML_TAG_REGEX, ' ')) : body;
  return normalizeQuotes(plain).toLowerCase().replace(/\s+/g, ' ').trim();
}

// NIP-39 proof template stems (normalized form, colon excluded - it is matched
// with tolerance). The CLI emits the exact upstream phrasing; matching requires
// the stem TOGETHER with the npub: a body that merely mentions the npub is not
// an endorsement (`unverifiable`), otherwise a "warning, scammer: npub1..."
// post would verify the scammer's claim to the author's account.
const GITHUB_TEMPLATE_STEM = 'verifying that i control the following nostr public key';
const X_TEMPLATE_STEM = 'verifying my account on nostr my public key';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type TemplateMatch = 'endorsed' | 'stem-only' | 'absent';

function classifyTemplateMatch(normalizedBody: string, stem: string, npub: string): TemplateMatch {
  if (!normalizedBody.includes(stem)) {
    return 'absent';
  }
  // npub is bech32 (lowercase alphanumeric) - safe to embed in a regex directly.
  const endorsement = new RegExp(`${escapeRegExp(stem)}\\s*:?\\s*["']?${npub}`);
  return endorsement.test(normalizedBody) ? 'endorsed' : 'stem-only';
}

function statusFromTemplateMatch(match: TemplateMatch): IdentityVerifyStatus {
  if (match === 'endorsed') {
    return 'verified';
  }
  // Stem present with a different or absent npub is a definitive mismatch.
  return match === 'stem-only' ? 'broken' : 'unverifiable';
}

// --- Per-platform verifiers (ONE endpoint each - no fallbacks by design) ---

interface VerifierContext {
  /** Agent pubkey, lowercase hex. */
  pubkey: string;
  npub: string;
  fetchImpl: typeof fetch;
  resolveHostAddresses: HostAddressResolver;
  nodeRuntime: boolean;
}

function lastPathSegment(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last === undefined ? null : last;
}

/**
 * GitHub: raw gist content. Ownership is enforced by GitHub's routing - a
 * wrong `<user>` for the gist id returns 404 (= broken). Works in the browser
 * too (`Access-Control-Allow-Origin: *`).
 */
async function verifyGithubIdentity(
  identity: AgentExternalIdentity,
  ctx: VerifierContext,
): Promise<IdentityVerifyStatus> {
  const gistId = lastPathSegment(identity.proofUrl);
  if (
    gistId === null ||
    !GITHUB_USERNAME_REGEX.test(identity.handle) ||
    !GIST_ID_REGEX.test(gistId)
  ) {
    return 'unverifiable';
  }
  const url = `https://gist.githubusercontent.com/${encodeURIComponent(identity.handle)}/${encodeURIComponent(gistId)}/raw`;
  const result = await guardedFetchProof(url, ctx);
  if (result.outcome === 'http-error') {
    return result.status === 404 ? 'broken' : 'unverifiable';
  }
  if (result.outcome === 'failed') {
    return 'unverifiable';
  }
  const normalized = normalizeProofBody(result.body, { html: false });
  return statusFromTemplateMatch(classifyTemplateMatch(normalized, GITHUB_TEMPLATE_STEM, ctx.npub));
}

/**
 * X: the documented oEmbed endpoint, Node only. In the browser we return
 * `unverifiable` WITHOUT fetching - publish.x.com's CORS behavior is
 * undocumented and deliberately not depended on. oEmbed ignores the username
 * in the request URL and returns the canonical author, so the `author_url`
 * comparison (case-insensitive) catches renames.
 */
async function verifyXIdentity(
  identity: AgentExternalIdentity,
  ctx: VerifierContext,
): Promise<IdentityVerifyStatus> {
  if (!ctx.nodeRuntime) {
    return 'unverifiable';
  }
  const tweetId = lastPathSegment(identity.proofUrl);
  if (
    tweetId === null ||
    !X_USERNAME_REGEX.test(identity.handle) ||
    !TWEET_ID_REGEX.test(tweetId)
  ) {
    return 'unverifiable';
  }
  const statusUrl = `https://x.com/${encodeURIComponent(identity.handle)}/status/${encodeURIComponent(tweetId)}`;
  const url = `https://publish.x.com/oembed?url=${encodeURIComponent(statusUrl)}`;
  const result = await guardedFetchProof(url, ctx);
  if (result.outcome === 'http-error') {
    // 404 = deleted or nonexistent tweet - definitively broken.
    return result.status === 404 ? 'broken' : 'unverifiable';
  }
  if (result.outcome === 'failed') {
    return 'unverifiable';
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.body);
  } catch {
    return 'unverifiable';
  }
  if (payload === null || typeof payload !== 'object') {
    return 'unverifiable';
  }
  const { author_url: authorUrl, html } = payload as { author_url?: unknown; html?: unknown };
  if (typeof authorUrl !== 'string' || typeof html !== 'string') {
    return 'unverifiable';
  }
  const canonicalAuthor = lastPathSegment(authorUrl);
  if (canonicalAuthor === null) {
    return 'unverifiable';
  }
  if (canonicalAuthor.toLowerCase() !== identity.handle.toLowerCase()) {
    return 'broken';
  }
  const normalized = normalizeProofBody(html, { html: true });
  return statusFromTemplateMatch(classifyTemplateMatch(normalized, X_TEMPLATE_STEM, ctx.npub));
}

async function verifyNostrJsonAtHost(
  host: string,
  local: string,
  ctx: VerifierContext,
): Promise<IdentityVerifyStatus> {
  if (ctx.nodeRuntime) {
    let addresses: string[];
    try {
      addresses = await ctx.resolveHostAddresses(host);
    } catch {
      return 'unverifiable'; // resolver error - skip the fetch
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      return 'unverifiable';
    }
  }
  const url = `https://${host}/.well-known/nostr.json?name=${encodeURIComponent(local)}`;
  const result = await guardedFetchProof(url, ctx);
  if (result.outcome === 'http-error') {
    return result.status === 404 ? 'broken' : 'unverifiable';
  }
  if (result.outcome === 'failed') {
    return 'unverifiable';
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.body);
  } catch {
    return 'unverifiable';
  }
  if (payload === null || typeof payload !== 'object') {
    return 'unverifiable';
  }
  const names = (payload as { names?: unknown }).names;
  if (names === null || typeof names !== 'object' || Array.isArray(names)) {
    return 'unverifiable';
  }
  if (!Object.hasOwn(names, local)) {
    return 'broken'; // name missing from a valid NIP-05 response
  }
  const mapped = (names as Record<string, unknown>)[local];
  if (typeof mapped !== 'string') {
    return 'unverifiable';
  }
  return mapped.toLowerCase() === ctx.pubkey ? 'verified' : 'broken';
}

/**
 * Website (NIP-05): `.well-known/nostr.json` with redirects refused (NIP-05:
 * redirects MUST be ignored). The only user-controlled-host fetch in the
 * feature: Node resolves the hostname first and refuses private ranges; the
 * pre-check is best-effort (fetch resolves again) - the load-bearing SSRF
 * barrier is https + certificate validation. Browser skips the guard (no
 * API for it; read-only GET + browser protections + CORS).
 *
 * ONLY the exact claimed host is consulted - no www/apex "twin" probing. www
 * and the apex are not guaranteed the same owner (`www.victim.com` can be a
 * dangling-CNAME takeover while the apex stays with the real owner, and
 * `www.com`/`www.co.uk` are registrable apexes), so trusting the twin as an
 * authoritative proof source would let a takeover of one host forge a claim
 * for the other and let an unclaimed twin poison a good proof with a false
 * `broken`. This matches standard NIP-05 (which fetches only the claimed
 * host, no redirects), so an operator whose host redirects apex<->www must
 * serve the file at, or claim, the exact host where it lives.
 */
async function verifyWebsiteIdentity(
  identity: AgentExternalIdentity,
  ctx: VerifierContext,
): Promise<IdentityVerifyStatus> {
  const identifier = normalizeNip05Identifier(identity.handle);
  if (identifier === null) {
    return 'unverifiable';
  }
  const { local, domain } = splitNip05Identifier(identifier);
  return verifyNostrJsonAtHost(domain, local, ctx);
}

async function verifyOneIdentity(
  identity: AgentExternalIdentity,
  ctx: VerifierContext,
): Promise<IdentityVerifyStatus> {
  switch (identity.platform) {
    case 'github':
      return verifyGithubIdentity(identity, ctx);
    case 'x':
      return verifyXIdentity(identity, ctx);
    case 'website':
      return verifyWebsiteIdentity(identity, ctx);
    default:
      // Runtime input can carry a platform outside the compile-time union.
      return 'unverifiable';
  }
}

// --- In-process TTL cache ---

interface VerifyCacheEntry {
  expiresAt: number;
  results: VerifiedIdentityResult[];
}

const verifyCache = new Map<string, VerifyCacheEntry>();

/**
 * Key includes a canonical serialization of the claim set, not just the
 * pubkey - keying by pubkey alone would serve stale results in a long-lived
 * process after the agent republishes kind 10011 within the TTL.
 */
function buildCacheKey(pubkey: string, identities: AgentExternalIdentity[]): string {
  const tuples = identities
    .map((identity) => `${identity.platform}:${identity.handle}:${identity.proofUrl}`)
    .sort();
  return JSON.stringify([pubkey, tuples]);
}

function cloneResults(results: VerifiedIdentityResult[]): VerifiedIdentityResult[] {
  return results.map((result) => ({ identity: { ...result.identity }, status: result.status }));
}

function readVerifyCache(key: string): VerifiedIdentityResult[] | null {
  const entry = verifyCache.get(key);
  if (entry === undefined) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    verifyCache.delete(key);
    return null;
  }
  return cloneResults(entry.results);
}

function writeVerifyCache(key: string, results: VerifiedIdentityResult[]): void {
  verifyCache.delete(key);
  // Bounded with oldest-first eviction (Map preserves insertion order).
  while (verifyCache.size >= LIMITS.MAX_IDENTITY_VERIFY_CACHE_ENTRIES) {
    const oldest = verifyCache.keys().next();
    if (oldest.done === true) {
      break;
    }
    verifyCache.delete(oldest.value);
  }
  const hasUnverifiable = results.some((result) => result.status === 'unverifiable');
  const ttlMs = hasUnverifiable
    ? DEFAULTS.IDENTITY_VERIFY_NEGATIVE_CACHE_TTL_MS
    : DEFAULTS.IDENTITY_VERIFY_CACHE_TTL_MS;
  verifyCache.set(key, { expiresAt: Date.now() + ttlMs, results: cloneResults(results) });
}

/** Drop every cached verification result (tests; not needed in production). */
export function clearIdentityVerifyCache(): void {
  verifyCache.clear();
}

// --- Public API ---

export interface VerifyIdentitiesOptions {
  /**
   * Skip the TTL cache entirely (no read, no write). The CLI `identity link`
   * / `identity status` paths verify live and set this.
   */
  bypassCache?: boolean;
  /** Test seam: fetch implementation. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Test seam / override for the NIP-05 DNS guard. Defaults to a lazy
   * `node:dns` lookup in Node; the guard is skipped in the browser.
   */
  resolveHostAddresses?: HostAddressResolver;
}

/**
 * Verify external identity claims for one agent. Returns one result per
 * claim, in input order. Fetches at most one endpoint per claim; results are
 * cached in-process (1 h, 5 min when any claim is `unverifiable`).
 */
export async function verifyAgentIdentities(
  pubkey: string,
  identities: AgentExternalIdentity[],
  opts: VerifyIdentitiesOptions = {},
): Promise<VerifiedIdentityResult[]> {
  const normalizedPubkey = pubkey.toLowerCase();
  if (!HEX_PUBKEY_REGEX.test(normalizedPubkey)) {
    throw new Error('verifyAgentIdentities requires a 64-char hex agent pubkey.');
  }
  const cacheKey = buildCacheKey(normalizedPubkey, identities);
  if (opts.bypassCache !== true) {
    const cached = readVerifyCache(cacheKey);
    if (cached !== null) {
      return cached;
    }
  }
  const ctx: VerifierContext = {
    pubkey: normalizedPubkey,
    npub: nip19.npubEncode(normalizedPubkey),
    fetchImpl: opts.fetchImpl ?? defaultFetch,
    resolveHostAddresses: opts.resolveHostAddresses ?? resolveWithNodeDns,
    nodeRuntime: isNodeRuntime(),
  };
  const results = await Promise.all(
    identities.map(async (identity) => ({
      identity,
      status: await verifyOneIdentity(identity, ctx),
    })),
  );
  if (opts.bypassCache !== true) {
    writeVerifyCache(cacheKey, results);
  }
  return results;
}

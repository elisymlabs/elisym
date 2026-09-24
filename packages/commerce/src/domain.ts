import * as nip19 from 'nostr-tools/nip19';
import { LIMITS } from './constants';
import { HEX_PUBKEY_RE } from './tags';

const HOSTNAME_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_PART_RE = /^[a-z0-9._-]{1,64}$/;
const MAX_HOSTNAME_LENGTH = 253;
/** Names that resolve to this machine or a private network, never to a public host (RFC 6761 and kin). */
const SPECIAL_USE_TOP_LEVELS: readonly string[] = [
  'localhost',
  'local',
  'internal',
  'arpa',
  'test',
  'invalid',
  'onion',
  'lan',
  'home',
  'corp',
  'intranet',
  'private',
];
const OWNER_NAME = 'owner';
const TXT_PREFIX = 'v=elisym1';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DNS_TYPE_TXT = 16;

/** The keys a merchant's domain vouches for. */
export interface DomainKeys {
  domain: string;
  /**
   * The NIP-05 name that was looked up (`_` for the domain itself). The answer
   * vouches for that name only: a profile under another name cannot borrow it.
   */
  name: string;
  storePubkey?: string;
  ownerPubkey?: string;
  source: 'nostr.json' | 'dns';
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A public DNS name: lowercase labels, at least two, no IP literal, no port. The
 * domain comes from a store's own profile - attacker-controlled - so nothing
 * else is fetched.
 */
export function isPublicHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > MAX_HOSTNAME_LENGTH) {
    return false;
  }
  const labels = hostname.split('.');
  if (labels.length < 2 || !labels.every((label) => HOSTNAME_LABEL_RE.test(label))) {
    return false;
  }
  const topLevel = labels[labels.length - 1] ?? '';
  // A URL parser reads a name whose last label is a number - decimal or `0x` hex -
  // as an IPv4 literal (`127.0.0.0x1` is 127.0.0.1), never a public name.
  return !/^(\d+|0x[0-9a-f]*)$/.test(topLevel) && !SPECIAL_USE_TOP_LEVELS.includes(topLevel);
}

/** Split `local@domain` (NIP-05; a bare domain means `_@domain`), lowercased, or `undefined`. */
export function splitNip05(identifier: string): { local: string; domain: string } | undefined {
  const lowered = identifier.trim().toLowerCase();
  const at = lowered.lastIndexOf('@');
  const local = at === -1 ? '_' : lowered.slice(0, at);
  const domain = at === -1 ? lowered : lowered.slice(at + 1);
  if (!LOCAL_PART_RE.test(local) || !isPublicHostname(domain)) {
    return undefined;
  }
  return { local, domain };
}

function readHexKey(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_PUBKEY_RE.test(value) ? value : undefined;
}

/** The store (under `local`) and the owner (under `owner`) a `nostr.json` names. */
export function readNostrJson(
  document: unknown,
  local: string,
): Pick<DomainKeys, 'storePubkey' | 'ownerPubkey'> {
  const names = fieldOf(document, 'names');
  if (typeof names !== 'object' || names === null) {
    return {};
  }
  const entries: Record<string, unknown> = { ...names };
  const keys: Pick<DomainKeys, 'storePubkey' | 'ownerPubkey'> = {};
  const storePubkey = readHexKey(entries[local]);
  const ownerPubkey = readHexKey(entries[OWNER_NAME]);
  if (storePubkey) {
    keys.storePubkey = storePubkey;
  }
  if (ownerPubkey) {
    keys.ownerPubkey = ownerPubkey;
  }
  return keys;
}

function npubToHex(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (HEX_PUBKEY_RE.test(value)) {
    return value;
  }
  try {
    const decoded = nip19.decode(value);
    return decoded.type === 'npub' ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

/** `v=elisym1; owner=npub1...; store=npub1...` - the DNS record for sites that cannot serve `/.well-known`. */
export function readElisymTxt(record: string): Pick<DomainKeys, 'storePubkey' | 'ownerPubkey'> {
  const parts = record.split(';').map((part) => part.trim());
  if (parts[0] !== TXT_PREFIX) {
    return {};
  }
  const fields = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const name = part.slice(0, eq).trim();
      // A key given twice vouches for nothing, as records that disagree do not.
      if (fields.has(name)) {
        return {};
      }
      fields.set(name, part.slice(eq + 1).trim());
    }
  }
  const keys: Pick<DomainKeys, 'storePubkey' | 'ownerPubkey'> = {};
  const storePubkey = npubToHex(fields.get('store'));
  const ownerPubkey = npubToHex(fields.get('owner'));
  if (storePubkey) {
    keys.storePubkey = storePubkey;
  }
  if (ownerPubkey) {
    keys.ownerPubkey = ownerPubkey;
  }
  return keys;
}

/** Read at most the byte cap, cancelling the stream past it: the host is not ours to trust. */
async function readCappedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > LIMITS.MAX_NIP05_DOCUMENT_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function fieldOf(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record: Record<string, unknown> = { ...value };
  return record[name];
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

async function fetchNostrJson(
  name: string,
  domain: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<Pick<DomainKeys, 'storePubkey' | 'ownerPubkey'>> {
  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
  // NIP-05: a redirect must not be followed - it would let another host answer for this one.
  const response = await fetchImpl(url, {
    redirect: 'error',
    signal: timeoutSignal(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    return {};
  }
  return readNostrJson(await readCappedJson(response), name);
}

async function fetchNostrJsonKeys(
  local: string,
  domain: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<DomainKeys | undefined> {
  const keys = await fetchNostrJson(local, domain, fetchImpl, timeoutMs);
  // Without the store under the asked name this answer vouches for nothing:
  // let the TXT record speak instead.
  if (!keys.storePubkey) {
    return undefined;
  }
  // A server that answers only the name asked for never lists `owner` beside `_`.
  if (!keys.ownerPubkey && local === '_') {
    try {
      const owner = await fetchNostrJson(OWNER_NAME, domain, fetchImpl, timeoutMs);
      if (owner.ownerPubkey) {
        keys.ownerPubkey = owner.ownerPubkey;
      }
    } catch {
      // The store entry still stands without the owner.
    }
  }
  return { domain, name: local, source: 'nostr.json', ...keys };
}

async function fetchTxtKeys(
  domain: string,
  name: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  dohEndpoint: string,
): Promise<DomainKeys | undefined> {
  const url = new URL(dohEndpoint);
  url.searchParams.set('name', `_elisym.${domain}`);
  url.searchParams.set('type', 'TXT');
  const response = await fetchImpl(url.toString(), {
    signal: timeoutSignal(timeoutMs),
    headers: { accept: 'application/dns-json' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  const answers = fieldOf(await readCappedJson(response), 'Answer');
  if (!Array.isArray(answers)) {
    return undefined;
  }
  let found: Pick<DomainKeys, 'storePubkey' | 'ownerPubkey'> | undefined;
  for (const answer of answers) {
    const type = fieldOf(answer, 'type');
    const data = fieldOf(answer, 'data');
    if (type !== DNS_TYPE_TXT || typeof data !== 'string') {
      continue;
    }
    // DoH JSON quotes each character-string; a long record is split in several.
    const record = data.replace(/"\s*"/g, '').replace(/^"|"$/g, '');
    const keys = readElisymTxt(record);
    if (!keys.storePubkey) {
      continue;
    }
    // Answer order is not guaranteed: records that disagree vouch for nothing,
    // rather than for whichever one came first this time.
    if (
      found !== undefined &&
      (found.storePubkey !== keys.storePubkey || found.ownerPubkey !== keys.ownerPubkey)
    ) {
      return undefined;
    }
    found = keys;
  }
  return found === undefined ? undefined : { domain, name, source: 'dns', ...found };
}

export interface ResolveDomainOptions {
  /**
   * Defaults to the global `fetch`. A SERVER (resolver, merchant node) must pass
   * a fetch that refuses private addresses: the domain comes from a store's
   * profile, and an unguarded fetch is an SSRF.
   */
  fetch?: FetchLike;
  timeoutMs?: number;
  dohEndpoint?: string;
}

/**
 * The keys `nip05` vouches for, from `/.well-known/nostr.json` and then from the
 * `_elisym` TXT record. `undefined` when the domain answers neither - which is
 * not the same as vouching for OTHER keys, and the caller keeps the two apart.
 */
export async function resolveDomainKeys(
  nip05: string,
  options: ResolveDomainOptions = {},
): Promise<DomainKeys | undefined> {
  const parts = splitNip05(nip05);
  if (!parts) {
    return undefined;
  }
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const fromJson = await fetchNostrJsonKeys(parts.local, parts.domain, fetchImpl, timeoutMs);
    if (fromJson) {
      return fromJson;
    }
  } catch {
    // Fall through to DNS: a site builder may serve no /.well-known at all.
  }
  try {
    return await fetchTxtKeys(
      parts.domain,
      parts.local,
      fetchImpl,
      timeoutMs,
      options.dohEndpoint ?? DEFAULT_DOH_ENDPOINT,
    );
  } catch {
    return undefined;
  }
}

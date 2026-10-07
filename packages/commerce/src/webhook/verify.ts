import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCE_SECS,
} from './constants';
import { equalBytes, fromHex, hmacSha256, secretBytes, signedBytes } from './crypto';
import {
  type WebhookEvent,
  classifyEvent,
  isJsonObject,
  parseOrderPaidEvent,
  parseTestEvent,
} from './event';

/** A headers object with a getter: fetch `Headers`, a `Map`, Express `req.get`. */
export interface WebhookHeaderGetter {
  get(name: string): string | null | undefined;
}

/**
 * Headers as fetch/Next/Bun/Deno/Workers give them (or anything with a getter, e.g. a Map or
 * Express `req.get`), or a Node-style object. A getter is always called with the lowercased
 * name, so a custom getter must accept lowercase names.
 */
export type WebhookHeaders =
  | WebhookHeaderGetter
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface VerifyWebhookInput {
  /** The shared secret, UTF-8. An array accepts any of them (secret rotation). */
  secret: string | readonly string[];
  /** The raw body exactly as received: never re-serialized JSON. */
  body: string | Uint8Array;
  headers: WebhookHeaders;
  /** Unix seconds; defaults to Math.floor(Date.now() / 1000). */
  now?: number;
  /** Defaults to WEBHOOK_TOLERANCE_SECS. */
  toleranceSecs?: number;
}

/**
 * - `bad_signature`: the signature or timestamp header is missing or ill-formed, or no `v1` entry
 *   matches a secret. Answer 401.
 * - `stale`: signed, but the timestamp is outside the window (a clock is off). Answer 401.
 * - `malformed`: signed and fresh, but not a JSON object, or a known event with a bad shape.
 *   Answer 400: the node retries, and a library upgrade within 7 days still gets the event.
 * - `unknown_event`: signed and fresh, an event this library does not know (a newer node).
 *   Answer 2xx to ignore it.
 */
export type WebhookFailureReason = 'bad_signature' | 'stale' | 'malformed' | 'unknown_event';

export type VerifyWebhookResult =
  | { ok: true; event: WebhookEvent }
  | { ok: false; reason: WebhookFailureReason };

/** The most comma-separated entries the signature header may hold. */
const MAX_SIGNATURE_ENTRIES = 8;
const SIGNATURE_ENTRY_RE = /^v1=([0-9a-fA-F]{64})$/;
/** Unix seconds: no sign, no fraction, no whitespace, no leading zero, at most 12 digits. */
const TIMESTAMP_RE = /^(0|[1-9][0-9]{0,11})$/;
const ENTRY_EDGE_WHITESPACE_RE = /^[ \t]+|[ \t]+$/g;

function isHeaderGetter(headers: WebhookHeaders): headers is WebhookHeaderGetter {
  return 'get' in headers && typeof headers.get === 'function';
}

/** A Uint8Array (a Node Buffer too) from any realm; not a DataView or another typed array. */
function isUint8Array(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
  );
}

/** Every value of one header, case-insensitively; a value that is not a string is absent. */
function readHeaderValues(headers: WebhookHeaders, name: string): string[] {
  const lowerName = name.toLowerCase();
  if (isHeaderGetter(headers)) {
    const value = headers.get(lowerName);
    return typeof value === 'string' ? [value] : [];
  }
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) {
      continue;
    }
    if (typeof value === 'string') {
      values.push(value);
    } else if (Array.isArray(value)) {
      for (const element of value) {
        if (typeof element === 'string') {
          values.push(element);
        }
      }
    }
  }
  return values;
}

/** The `v1` candidates of the signature header, or `undefined` when the list is empty or too long. */
function signatureCandidates(values: readonly string[]): Uint8Array[] | undefined {
  const entries = values
    .join(',')
    .split(',')
    .map((entry) => entry.replace(ENTRY_EDGE_WHITESPACE_RE, ''))
    .filter((entry) => entry !== '');
  if (entries.length === 0 || entries.length > MAX_SIGNATURE_ENTRIES) {
    return undefined;
  }
  const candidates: Uint8Array[] = [];
  for (const entry of entries) {
    const hex = SIGNATURE_ENTRY_RE.exec(entry)?.[1];
    if (hex !== undefined) {
      candidates.push(fromHex(hex));
    }
  }
  return candidates;
}

function normalizeSecrets(secret: unknown): Uint8Array[] {
  if (typeof secret === 'string') {
    return [secretBytes(secret, 'verifyWebhook')];
  }
  if (!Array.isArray(secret) || secret.length === 0) {
    throw new TypeError('verifyWebhook: secret must be a string or a non-empty array of strings');
  }
  return secret.map((each: unknown) => secretBytes(each, 'verifyWebhook'));
}

function decodeBody(body: string | Uint8Array): string | undefined {
  if (typeof body === 'string') {
    return body;
  }
  try {
    // ignoreBOM keeps a BOM, so bytes and the same text as a string parse alike.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failure(reason: WebhookFailureReason): VerifyWebhookResult {
  return { ok: false, reason };
}

/**
 * Authenticate and parse one webhook request from the node: the signature (constant time, any
 * of the secrets), the replay window, then the event's shape. Programmer errors (a short secret,
 * a body that is neither a string nor bytes, a bad `now` or `toleranceSecs`) throw; a problem with
 * the request is a `reason`. It does not check that the store is yours, the product or asset is on
 * your lists, or that the event is new: those are yours.
 */
export async function verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
  const secrets = normalizeSecrets(input.secret);
  const { body } = input;
  if (typeof body !== 'string' && !isUint8Array(body)) {
    throw new TypeError('verifyWebhook: body must be a string or a Uint8Array');
  }
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('verifyWebhook: now must be a finite number of Unix seconds');
  }
  const toleranceSecs = input.toleranceSecs ?? WEBHOOK_TOLERANCE_SECS;
  if (typeof toleranceSecs !== 'number' || !Number.isInteger(toleranceSecs) || toleranceSecs < 0) {
    throw new TypeError('verifyWebhook: toleranceSecs must be an integer >= 0');
  }

  const candidates = signatureCandidates(readHeaderValues(input.headers, WEBHOOK_SIGNATURE_HEADER));
  const timestamps = readHeaderValues(input.headers, WEBHOOK_TIMESTAMP_HEADER);
  const timestampText = timestamps.length === 1 ? timestamps[0] : undefined;
  if (
    candidates === undefined ||
    candidates.length === 0 ||
    timestampText === undefined ||
    !TIMESTAMP_RE.test(timestampText)
  ) {
    return failure('bad_signature');
  }

  const data = signedBytes(timestampText, body);
  let matched = false;
  for (const secret of secrets) {
    const mac = await hmacSha256(secret, data);
    for (const candidate of candidates) {
      if (equalBytes(mac, candidate)) {
        matched = true;
      }
    }
  }
  if (!matched) {
    return failure('bad_signature');
  }

  if (Math.abs(now - Number(timestampText)) > toleranceSecs) {
    return failure('stale');
  }

  const text = decodeBody(body);
  const parsed = text === undefined ? undefined : parseJson(text);
  if (!isJsonObject(parsed)) {
    return failure('malformed');
  }
  const kind = classifyEvent(parsed);
  if (kind === 'malformed') {
    return failure('malformed');
  }
  if (kind === 'unknown') {
    return failure('unknown_event');
  }
  const event = kind === 'test' ? parseTestEvent(parsed) : parseOrderPaidEvent(parsed);
  return event === undefined ? failure('malformed') : { ok: true, event };
}

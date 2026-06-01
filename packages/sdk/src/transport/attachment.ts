/**
 * Job file-attachment descriptor and the job-payload envelope (browser-safe).
 *
 * A file job carries its file out-of-band (P2P via iroh); the Nostr event's
 * (NIP-44-encrypted) `content` carries only a small JSON envelope describing the
 * file and how to fetch it. This module owns the envelope shape, its encode, and
 * its strict decode. It deliberately does NOT construct an iroh `BlobTicket` - the
 * `ticket` is validated only as a bounded opaque string so that decoding an
 * untrusted, possibly pre-payment request never pulls in the native iroh addon.
 *
 * The transport is a discriminated union keyed on `kind`; Phase 1 ships only
 * `iroh`. A future HTTP/Blossom transport is added as another union member without
 * changing this contract.
 */
import { z } from 'zod';
import { LIMITS } from '../constants';

/** Current envelope version. Bumped only on a breaking envelope-shape change. */
export const ENVELOPE_VERSION = 'elisym-job/1';

/** Namespace prefix shared by all envelope versions, used to detect "this is ours". */
const ENVELOPE_NAMESPACE_PREFIX = 'elisym-job/';

/** Upper bound on a serialized transport locator (e.g. an iroh BlobTicket string). */
const MAX_TICKET_LENGTH = 4096;

const FileTransportSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('iroh'),
    /** Opaque iroh `BlobTicket` string. Parsed into a real ticket only at fetch time. */
    ticket: z.string().min(1).max(MAX_TICKET_LENGTH),
  }),
  z.object({
    kind: z.literal('blossom'),
    /** Public HTTP(S) URL of the CIPHERTEXT blob on a Blossom relay. */
    url: z.string().url().max(2048),
    /** sha256 (lowercase hex) of the ciphertext - what the relay stores and addresses. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /**
     * Hybrid-encryption parameters. The file bytes are AES-256-GCM encrypted with a random
     * content key; that key is NIP-44-wrapped to the recipient. `name`/`mime`/`size` on the
     * attachment describe the PLAINTEXT and live only inside the (encrypted) envelope - never
     * sent to the relay (the relay only ever sees opaque ciphertext).
     */
    enc: z.object({
      alg: z.literal('AES-256-GCM'),
      /** base64 12-byte GCM IV (non-secret). */
      iv: z.string().min(1).max(64),
      /** NIP-44-wrapped content key. */
      key: z.string().min(1).max(2048),
    }),
  }),
]);

const FileAttachmentSchema = z.object({
  /** Display name only. Never used to derive a filesystem path (callers sanitize). */
  name: z.string().min(1).max(255),
  /** Declared size in bytes (display/hint only; enforcement is on actual streamed bytes). */
  size: z.number().int().nonnegative(),
  mime: z.string().min(1).max(255),
  /**
   * Ordered by sender preference; at least one KNOWN transport. Parsed leniently: unknown
   * transport `kind`s are dropped (not rejected) so adding a new transport never makes an older
   * decoder throw away the whole envelope - it just ignores the kinds it doesn't know and uses
   * the ones it does. At least one known transport must survive, else the attachment is invalid.
   */
  transports: z
    .array(z.unknown())
    .transform((arr): z.infer<typeof FileTransportSchema>[] =>
      arr.flatMap((t) => {
        const parsed = FileTransportSchema.safeParse(t);
        return parsed.success ? [parsed.data] : [];
      }),
    )
    .refine((arr) => arr.length >= 1, { message: 'attachment has no known transport' }),
  /** Optional provider hint (unix seconds) for when seeding may stop. */
  seedingExpiresAt: z.number().int().nonnegative().optional(),
});

const JobPayloadEnvelopeSchema = z.object({
  v: z.literal(ENVELOPE_VERSION),
  text: z.string().optional(),
  // Legacy single attachment - kept (and mirrored from `attachments[0]`) so an old
  // decoder that doesn't know `attachments` still gets the first file.
  attachment: FileAttachmentSchema.optional(),
  // Multiple result/input files. Additive; old decoders strip this unknown key.
  attachments: z.array(FileAttachmentSchema).optional(),
});

export type FileTransport = z.infer<typeof FileTransportSchema>;
export type FileAttachment = z.infer<typeof FileAttachmentSchema>;
export type JobPayloadEnvelope = z.infer<typeof JobPayloadEnvelopeSchema>;

/** The kinds of file transport a job can use ('iroh' | 'blossom'). */
export type TransportKind = FileTransport['kind'];

/** Public job-request tag advertising which transports a customer can RECEIVE output on. */
export const ACCEPT_TRANSPORTS_TAG = 'accept';

const KNOWN_TRANSPORT_KINDS: readonly TransportKind[] = ['iroh', 'blossom'];

function isKnownTransportKind(value: string): value is TransportKind {
  return (KNOWN_TRANSPORT_KINDS as readonly string[]).includes(value);
}

/**
 * Build the `['accept', ...kinds]` job-request tag from a client's RECEIVE-capable transports.
 * Drops unknown kinds and dedupes, preserving the client's preference order.
 */
export function buildAcceptTransportsTag(kinds: TransportKind[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [ACCEPT_TRANSPORTS_TAG];
  for (const kind of kinds) {
    if (isKnownTransportKind(kind) && !seen.has(kind)) {
      seen.add(kind);
      out.push(kind);
    }
  }
  return out;
}

/**
 * Read accepted transports from an event's tags. Returns the ordered, deduped, known kinds, or
 * `undefined` when there is no `accept` tag or it carries no known kind - both normalize to the
 * provider's default (seed all transports). Lenient: unknown kinds (from a newer client) are ignored
 * so this never strands a job.
 */
export function readAcceptedTransports(tags: string[][]): TransportKind[] | undefined {
  const tag = tags.find((t) => t[0] === ACCEPT_TRANSPORTS_TAG);
  if (tag === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
  const out: TransportKind[] = [];
  for (const value of tag.slice(1)) {
    if (isKnownTransportKind(value) && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Decoded job payload: a free-text note and/or file attachment(s). */
export interface DecodedJobPayload {
  text?: string;
  /** Legacy single attachment (also mirrors `attachments[0]`). */
  attachment?: FileAttachment;
  /** All attachments when a job carries multiple files. */
  attachments?: FileAttachment[];
}

/**
 * Normalize a decoded payload to the full attachment list, treating the legacy
 * single `attachment` as a 1-element list. Use this everywhere instead of reading
 * `.attachment`/`.attachments` directly, so single- and multi-file are uniform.
 */
export function attachmentsOf(decoded: DecodedJobPayload): FileAttachment[] {
  if (decoded.attachments !== undefined && decoded.attachments.length > 0) {
    return decoded.attachments;
  }
  return decoded.attachment !== undefined ? [decoded.attachment] : [];
}

/**
 * Serialize a job payload into the envelope string that goes (encrypted) into a
 * Nostr event's `content`. Used only when an attachment is present; plain-text
 * jobs send their text directly and are never wrapped.
 */
export function encodeJobPayload(payload: DecodedJobPayload): string {
  const envelope: JobPayloadEnvelope = { v: ENVELOPE_VERSION };
  if (payload.text !== undefined) {
    envelope.text = payload.text;
  }
  // Prefer the multi-attachment form and mirror the first into the legacy single
  // `attachment` (old decoders that ignore `attachments` still get one file).
  if (payload.attachments !== undefined && payload.attachments.length > 0) {
    envelope.attachments = payload.attachments;
    envelope.attachment = payload.attachments[0];
  } else if (payload.attachment !== undefined) {
    envelope.attachment = payload.attachment;
  }
  return JSON.stringify(envelope);
}

/**
 * Decode decrypted `content` into a job payload.
 *
 * - Content longer than `MAX_INPUT_LENGTH` is treated as raw text without parsing
 *   (a valid envelope is small and a valid text job is capped at submit time), so
 *   untrusted, possibly-huge intake content is never `JSON.parse`d unbounded.
 * - Non-JSON, non-object JSON, or a JSON object that does not carry our
 *   `elisym-job/` version marker is returned as raw text.
 * - A value that DOES carry an `elisym-job/` marker is validated strictly: an
 *   unknown version or a malformed envelope throws (callers skip/surface it)
 *   rather than being silently mistreated as text.
 */
export function decodeJobPayload(content: string): DecodedJobPayload {
  if (content.length > LIMITS.MAX_INPUT_LENGTH) {
    return { text: content };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { text: content };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { text: content };
  }

  const version = (parsed as { v?: unknown }).v;
  if (typeof version !== 'string' || !version.startsWith(ENVELOPE_NAMESPACE_PREFIX)) {
    return { text: content };
  }

  const result = JobPayloadEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid elisym job payload (v=${JSON.stringify(version)}): ${result.error.message}`,
    );
  }

  return {
    text: result.data.text,
    attachment: result.data.attachment,
    attachments: result.data.attachments,
  };
}

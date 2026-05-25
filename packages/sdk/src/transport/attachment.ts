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
]);

const FileAttachmentSchema = z.object({
  /** Display name only. Never used to derive a filesystem path (callers sanitize). */
  name: z.string().min(1).max(255),
  /** Declared size in bytes (display/hint only; enforcement is on actual streamed bytes). */
  size: z.number().int().nonnegative(),
  mime: z.string().min(1).max(255),
  /** Ordered by sender preference; at least one. */
  transports: z.array(FileTransportSchema).min(1),
  /** Optional provider hint (unix seconds) for when seeding may stop. */
  seedingExpiresAt: z.number().int().nonnegative().optional(),
});

const JobPayloadEnvelopeSchema = z.object({
  v: z.literal(ENVELOPE_VERSION),
  text: z.string().optional(),
  attachment: FileAttachmentSchema.optional(),
});

export type FileTransport = z.infer<typeof FileTransportSchema>;
export type FileAttachment = z.infer<typeof FileAttachmentSchema>;
export type JobPayloadEnvelope = z.infer<typeof JobPayloadEnvelopeSchema>;

/** Decoded job payload: a free-text note and/or a file attachment. */
export interface DecodedJobPayload {
  text?: string;
  attachment?: FileAttachment;
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
  if (payload.attachment !== undefined) {
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

  return { text: result.data.text, attachment: result.data.attachment };
}

import { HEX_PUBKEY_RE, isGenuineEvent, tagValue, tagsNamed } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure';
import { KIND_CHAT_MESSAGE, LIMITS } from '../constants';
import { type ChatMessage, ChatMessageSchema } from './messages';

const KIND_SEAL = 13;
const KIND_GIFT_WRAP = 1059;
/** NIP-59: seal and wrap `created_at` are randomized up to two days into the past. */
const BACKDATE_WINDOW_SECS = 2 * 24 * 60 * 60;
const ENCODER = new TextEncoder();

function randomBackdate(now: number): number {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return now - ((random[0] ?? 0) % BACKDATE_WINDOW_SECS);
}

function byteLength(text: string): number {
  return ENCODER.encode(text).length;
}

interface Rumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface WrapInput {
  message: ChatMessage;
  senderSecretKey: Uint8Array;
  recipientPubkey: string;
  /** Wrap `expiration`, unix seconds: the session end (4.4), or a status's own short life. */
  expiresAt: number;
  /**
   * The current time this side writes with: the widget's gateway-corrected
   * clock, the assistant's server clock (4.1). Every timestamp of the wrap
   * derives from it.
   */
  now: number;
}

export interface WrapResult {
  wrap: NostrEvent;
  rumorId: string;
}

/**
 * Gift-wrap a chat message (NIP-59 shape, rumor kind 4495). Built by hand
 * rather than with `nip59.wrapEvent`, which fixes the wrap tags to the
 * recipient only: ComCore wraps also carry NIP-40 `expiration` (4.4). Throws
 * when the serialized rumor exceeds the senders' working cap.
 */
export function wrapChatMessage(input: WrapInput): WrapResult {
  if (!HEX_PUBKEY_RE.test(input.recipientPubkey)) {
    throw new Error('recipientPubkey must be 64 lowercase hex characters');
  }
  // A fractional time (local seconds plus an offset) would build a rumor every receiver refuses.
  if (!Number.isSafeInteger(input.now) || input.now <= 0) {
    throw new Error('now must be a unix time in whole seconds');
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.now) {
    throw new Error('expiresAt must be a unix time after now');
  }
  const message = ChatMessageSchema.parse(input.message);
  const senderPubkey = getPublicKey(input.senderSecretKey);
  const unhashed = {
    pubkey: senderPubkey,
    created_at: input.now,
    kind: KIND_CHAT_MESSAGE,
    tags: [['p', input.recipientPubkey]],
    content: JSON.stringify(message),
  };
  const rumor: Rumor = { ...unhashed, id: getEventHash(unhashed) };
  const rumorJson = JSON.stringify(rumor);
  if (byteLength(rumorJson) > LIMITS.RUMOR_WORKING_BYTES) {
    throw new Error('The chat message is over the working size cap');
  }
  const seal = finalizeEvent(
    {
      kind: KIND_SEAL,
      created_at: randomBackdate(input.now),
      tags: [],
      content: nip44.v2.encrypt(
        rumorJson,
        nip44.v2.utils.getConversationKey(input.senderSecretKey, input.recipientPubkey),
      ),
    },
    input.senderSecretKey,
  );
  const ephemeralKey = generateSecretKey();
  const wrap = finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: randomBackdate(input.now),
      tags: [
        ['p', input.recipientPubkey],
        ['expiration', String(input.expiresAt)],
      ],
      content: nip44.v2.encrypt(
        JSON.stringify(seal),
        nip44.v2.utils.getConversationKey(ephemeralKey, input.recipientPubkey),
      ),
    },
    ephemeralKey,
  );
  return { wrap, rumorId: rumor.id };
}

export interface UnwrappedChat {
  wrapId: string;
  rumorId: string;
  /** The seal's signer = the rumor's author: who really sent it. */
  senderPubkey: string;
  recipientPubkey: string;
  /** The rumor's own time, never backdated. */
  createdAt: number;
  /** The wrap's NIP-40 expiration, when it has a readable one. */
  expiresAt?: number;
  message: ChatMessage;
}

function parseJsonEvent(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    return { ...value };
  } catch {
    return undefined;
  }
}

function isStringMatrix(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'))
  );
}

function toEvent(record: Record<string, unknown>): NostrEvent | undefined {
  const { id, pubkey, created_at: createdAt, kind, tags, content, sig } = record;
  if (
    typeof id !== 'string' ||
    typeof pubkey !== 'string' ||
    typeof createdAt !== 'number' ||
    !Number.isInteger(createdAt) ||
    typeof kind !== 'number' ||
    typeof content !== 'string' ||
    typeof sig !== 'string' ||
    !isStringMatrix(tags)
  ) {
    return undefined;
  }
  return { id, pubkey, created_at: createdAt, kind, tags, content, sig };
}

/**
 * Open a ComCore gift wrap addressed to `recipientSecretKey`, cheapest checks
 * first, or `undefined` for anything that is not a genuine chat message:
 * content length before any decrypt, then the wrap signature, the seal
 * signature, a rumor that claims the seal's signer and hashes to its id, the
 * receivers' size ceiling and the message schema. `nip59.unwrapEvent` verifies
 * none of this and is never used.
 */
export function unwrapChatMessage(
  wrap: NostrEvent,
  recipientSecretKey: Uint8Array,
): UnwrappedChat | undefined {
  try {
    if (
      wrap.kind !== KIND_GIFT_WRAP ||
      typeof wrap.content !== 'string' ||
      wrap.content.length > LIMITS.WRAP_CONTENT_MAX_CHARS ||
      !isGenuineEvent(wrap)
    ) {
      return undefined;
    }
    const sealRecord = parseJsonEvent(
      nip44.v2.decrypt(
        wrap.content,
        nip44.v2.utils.getConversationKey(recipientSecretKey, wrap.pubkey),
      ),
    );
    const seal = sealRecord ? toEvent(sealRecord) : undefined;
    // NIP-59: a seal carries no tags.
    if (!seal || seal.kind !== KIND_SEAL || seal.tags.length > 0 || !isGenuineEvent(seal)) {
      return undefined;
    }
    const rumorJson = nip44.v2.decrypt(
      seal.content,
      nip44.v2.utils.getConversationKey(recipientSecretKey, seal.pubkey),
    );
    if (byteLength(rumorJson) > LIMITS.RUMOR_CEILING_BYTES) {
      return undefined;
    }
    const rumorRecord = parseJsonEvent(rumorJson);
    if (!rumorRecord || rumorRecord.sig !== undefined) {
      return undefined;
    }
    const { id, pubkey, created_at: createdAt, kind, tags, content } = rumorRecord;
    if (
      typeof id !== 'string' ||
      pubkey !== seal.pubkey ||
      typeof createdAt !== 'number' ||
      !Number.isInteger(createdAt) ||
      kind !== KIND_CHAT_MESSAGE ||
      typeof content !== 'string' ||
      !isStringMatrix(tags)
    ) {
      return undefined;
    }
    const rumorFields = { pubkey: seal.pubkey, created_at: createdAt, kind, tags, content };
    if (id !== getEventHash(rumorFields)) {
      return undefined;
    }
    // The rumor must name the same recipient as the wrap that carried it.
    const recipientPubkey = tagValue(tags, 'p');
    if (recipientPubkey === undefined || recipientPubkey !== tagValue(wrap.tags, 'p')) {
      return undefined;
    }
    const parsed = ChatMessageSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      return undefined;
    }
    const result: UnwrappedChat = {
      wrapId: wrap.id,
      rumorId: id,
      senderPubkey: seal.pubkey,
      recipientPubkey,
      createdAt,
      message: parsed.data,
    };
    const expirationTags = tagsNamed(wrap.tags, 'expiration');
    const expiration = expirationTags.length === 1 ? expirationTags[0]?.[1] : undefined;
    if (expiration !== undefined && /^\d{1,12}$/.test(expiration)) {
      result.expiresAt = Number(expiration);
    }
    return result;
  } catch {
    return undefined;
  }
}

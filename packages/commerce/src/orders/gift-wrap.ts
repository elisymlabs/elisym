import { getEventHash, getPublicKey } from 'nostr-tools';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import * as nip44 from 'nostr-tools/nip44';
import * as nip59 from 'nostr-tools/nip59';
import {
  KIND_GIFT_WRAP,
  KIND_ORDER_MESSAGE,
  KIND_PAYMENT_RECEIPT,
  KIND_SEAL,
  LIMITS,
  MAX_FUTURE_SKEW_SECS,
} from '../constants';
import { HEX_PUBKEY_RE, nowSecs, tagValue } from '../tags';
import { isGenuineEvent } from '../verify';
import { type OrderMessage, parseOrderMessage } from './messages';

export interface WrappedOrderMessage {
  /** Publish to the recipient's inbox relays (kind 10050). */
  recipientWrap: NostrEvent;
  /** The sender's own copy, for its history on another device. */
  selfWrap: NostrEvent;
  /** The rumor id: the same in both wraps, the key to dedupe on. */
  rumorId: string;
}

/**
 * Seal and gift-wrap an order message (NIP-59) for `recipientPubkey`, plus a copy
 * for the sender. Relays see neither the content nor who talks to whom.
 */
export function wrapOrderMessage(
  rumor: EventTemplate,
  senderSecretKey: Uint8Array,
  recipientPubkey: string,
): WrappedOrderMessage {
  if (!HEX_PUBKEY_RE.test(recipientPubkey)) {
    throw new Error('recipientPubkey must be 64 lowercase hex characters');
  }
  if (rumor.kind !== KIND_ORDER_MESSAGE && rumor.kind !== KIND_PAYMENT_RECEIPT) {
    throw new Error(`Not an order message kind: ${rumor.kind}`);
  }
  // The rumor carries its own created_at: nip59 rebuilds it per wrap, and a
  // clock read per build could split the rumor id across the two wraps.
  const wraps = nip59.wrapManyEvents(rumor, senderSecretKey, [recipientPubkey]);
  const selfWrap = wraps[0];
  const recipientWrap = wraps[1];
  if (!selfWrap || !recipientWrap) {
    throw new Error('Unexpected wrap count from nip59.wrapManyEvents');
  }
  const rumorId = getEventHash({ ...rumor, pubkey: getPublicKey(senderSecretKey) });
  return { recipientWrap, selfWrap, rumorId };
}

export interface UnwrappedOrderMessage {
  rumorId: string;
  /** Authenticated by the seal signature. */
  senderPubkey: string;
  /** The `p` tag of the rumor: who the message is addressed to. */
  recipientPubkey: string;
  createdAt: number;
  message: OrderMessage;
}

interface ParsedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

function isStringArrayArray(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((entry) => Array.isArray(entry) && entry.every((item) => typeof item === 'string'))
  );
}

function parseEventJson(json: string): ParsedEvent | undefined {
  let shape: unknown;
  try {
    shape = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof shape !== 'object' || shape === null) {
    return undefined;
  }
  const record: Record<string, unknown> = { ...shape };
  const { id, pubkey, created_at: createdAt, kind, tags, content, sig } = record;
  if (
    typeof id !== 'string' ||
    typeof pubkey !== 'string' ||
    typeof createdAt !== 'number' ||
    !Number.isInteger(createdAt) ||
    createdAt < 0 ||
    typeof kind !== 'number' ||
    typeof content !== 'string' ||
    content.length > LIMITS.MAX_CONTENT_LENGTH ||
    !isStringArrayArray(tags)
  ) {
    return undefined;
  }
  const parsed: ParsedEvent = { id, pubkey, created_at: createdAt, kind, tags, content };
  if (typeof sig === 'string') {
    parsed.sig = sig;
  }
  return parsed;
}

function decrypt(payload: string, secretKey: Uint8Array, senderPubkey: string): string {
  return nip44.v2.decrypt(payload, nip44.v2.utils.getConversationKey(secretKey, senderPubkey));
}

/**
 * Open a gift wrap addressed to `recipientSecretKey` and read the order message
 * inside, or `undefined` for anything that is not a genuine one.
 *
 * This replaces `nip59.unwrapEvent`, which verifies nothing: it would take a seal
 * signed by anyone and report whatever `pubkey` the rumor claims. Here the wrap
 * and the seal signatures are checked, the rumor must claim the seal's signer,
 * and its id must be its hash.
 */
export function unwrapOrderMessage(
  wrap: NostrEvent,
  recipientSecretKey: Uint8Array,
): UnwrappedOrderMessage | undefined {
  try {
    if (wrap.kind !== KIND_GIFT_WRAP || !isGenuineEvent(wrap)) {
      return undefined;
    }
    const seal = parseEventJson(decrypt(wrap.content, recipientSecretKey, wrap.pubkey));
    if (!seal || seal.kind !== KIND_SEAL || seal.sig === undefined) {
      return undefined;
    }
    const signedSeal: NostrEvent = { ...seal, sig: seal.sig };
    if (!isGenuineEvent(signedSeal)) {
      return undefined;
    }
    const rumor = parseEventJson(decrypt(seal.content, recipientSecretKey, seal.pubkey));
    if (!rumor || rumor.pubkey !== seal.pubkey || rumor.id !== getEventHash(rumor)) {
      return undefined;
    }
    if (rumor.created_at > nowSecs() + MAX_FUTURE_SKEW_SECS) {
      return undefined;
    }
    const recipientPubkey = tagValue(rumor.tags, 'p');
    const message = parseOrderMessage(rumor);
    if (recipientPubkey === undefined || !message) {
      return undefined;
    }
    return {
      rumorId: rumor.id,
      senderPubkey: rumor.pubkey,
      recipientPubkey,
      createdAt: rumor.created_at,
      message,
    };
  } catch {
    return undefined;
  }
}

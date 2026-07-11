import { finalizeEvent, getEventHash, verifyEvent } from 'nostr-tools';
import type { Event, EventTemplate, Filter } from 'nostr-tools';
import * as nip59 from 'nostr-tools/nip59';
import {
  DEFAULTS,
  DM_INBOX_MARKER_TAG,
  DM_INBOX_MARKER_VALUE,
  KIND_DM_INBOX_RELAYS,
  KIND_DM_RUMOR,
  KIND_DM_SEAL,
  KIND_GIFT_WRAP,
  LIMITS,
  utf8ByteLength,
} from '../constants';
import { BoundedSet } from '../primitives/bounded-set';
import { nip44Decrypt } from '../primitives/crypto';
import type { ElisymIdentity } from '../primitives/identity';
import type { NostrPool } from '../transport/pool';
import type { ConversationSummary, DirectMessage, SubCloser } from '../types';

const PUBKEY_HEX_REGEX = /^[0-9a-f]{64}$/;

/**
 * The innermost NIP-17 event (kind 14). Unsigned by design (deniability) -
 * authenticity comes from the seal signature, which the secure unwrap
 * verifies before trusting `pubkey`.
 */
interface Rumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

function isStringArrayArray(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((entry) => Array.isArray(entry) && entry.every((item) => typeof item === 'string'))
  );
}

function parseJsonObject(json: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function rumorFromShape(shape: Record<string, unknown>): Rumor | null {
  // created_at must be integer unix seconds (NIP-01). A bare `typeof`
  // check would admit -1, 1.5, and NaN (NaN also slides past the
  // future-skew comparison), poisoning consumers keyed on the timestamp -
  // most concretely the MCP read-cursor file, whose schema rejects the
  // whole map over one bad entry.
  if (
    typeof shape.id !== 'string' ||
    typeof shape.pubkey !== 'string' ||
    typeof shape.created_at !== 'number' ||
    !Number.isInteger(shape.created_at) ||
    shape.created_at < 0 ||
    typeof shape.kind !== 'number' ||
    typeof shape.content !== 'string' ||
    !isStringArrayArray(shape.tags)
  ) {
    return null;
  }
  return {
    id: shape.id,
    pubkey: shape.pubkey,
    created_at: shape.created_at,
    kind: shape.kind,
    tags: shape.tags,
    content: shape.content,
  };
}

function parseRumor(json: string): Rumor | null {
  const shape = parseJsonObject(json);
  return shape ? rumorFromShape(shape) : null;
}

/** Parse a decrypted seal: a full signed event (rumor shape + `sig`). */
function parseSignedEvent(json: string): Event | null {
  const shape = parseJsonObject(json);
  if (!shape) {
    return null;
  }
  const base = rumorFromShape(shape);
  if (!base || typeof shape.sig !== 'string') {
    return null;
  }
  return { ...base, sig: shape.sig };
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function relaySetsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((url) => rightSet.has(url));
}

/**
 * Private direct messages over NIP-17 (gift-wrapped kind 14 rumors).
 *
 * The public surface is transport-agnostic: nothing NIP-17-specific (kinds,
 * wraps, seals) leaks out, so a future transport (e.g. Marmot/MLS) can slot
 * in without breaking callers.
 *
 * Delivery scope (stage 1): `send` publishes to the *sender's* pool relays
 * and does not consult the recipient's advertised kind 10050 inbox list -
 * within elisym both sides share the default relays. The published 10050
 * serves the inbound direction: external NIP-17 clients read it and deliver
 * to relays we query.
 */
export class MessagesService {
  /** Sized for the ~2 days of replayed wraps a fresh subscription receives. */
  private static readonly DEDUP_CAPACITY = 10_000;

  /** Default-mode 10050 publish debounce: one attempt per instance per pubkey. */
  private inboxRelaysAttempted = new Set<string>();

  constructor(private pool: NostrPool) {}

  /**
   * Send a private message. Wraps one kind-14 rumor for the recipient plus a
   * self-copy (identical rumor id in both), publishes the recipient's wrap
   * first, and treats a self-copy publish failure as non-fatal - a throw
   * from `send` therefore reliably means "not delivered", and the sender's
   * history never shows a message the recipient cannot have received.
   * Returns the rumor id.
   */
  async send(
    identity: ElisymIdentity,
    recipientPubkey: string,
    content: string,
  ): Promise<{ id: string }> {
    if (!PUBKEY_HEX_REGEX.test(recipientPubkey)) {
      throw new Error('Invalid recipient pubkey: expected 64 lowercase hex characters.');
    }
    if (content.length === 0) {
      throw new Error('Message must not be empty.');
    }
    if (content.length > LIMITS.MAX_MESSAGE_LENGTH) {
      throw new Error(
        `Message too long: ${content.length} chars (max ${LIMITS.MAX_MESSAGE_LENGTH}).`,
      );
    }
    const encodedBytes = utf8ByteLength(JSON.stringify(content));
    if (encodedBytes > LIMITS.MAX_MESSAGE_JSON_BYTES) {
      throw new Error(
        `Message too large after encoding: ${encodedBytes} bytes (max ${LIMITS.MAX_MESSAGE_JSON_BYTES}). ` +
          'Escape-heavy content (control characters) expands when serialized.',
      );
    }

    // created_at MUST be fixed in the template: nip59 rebuilds the rumor per
    // wrap, and a second-boundary tick between the two builds would diverge
    // the rumor ids (breaking self-copy attribution and dedup).
    const template = {
      kind: KIND_DM_RUMOR,
      created_at: nowSecs(),
      tags: [['p', recipientPubkey]],
      content,
    };
    const wraps = nip59.wrapManyEvents(template, identity.secretKey, [recipientPubkey]);
    const selfWrap = wraps[0];
    const recipientWrap = wraps[1];
    if (!selfWrap || !recipientWrap) {
      throw new Error('Unexpected wrap count from nip59.wrapManyEvents.');
    }

    const rumorId = getEventHash({ ...template, pubkey: identity.publicKey });

    await this.pool.publishAll(recipientWrap);
    try {
      await this.pool.publishAll(selfWrap);
    } catch {
      // Non-fatal: the recipient already has the message; only the sender's
      // own relay-backed history is missing this copy.
    }
    return { id: rumorId };
  }

  /**
   * Fetch decrypted message history from relays.
   *
   * `since` is logical time: the relay filter is widened by the NIP-59
   * 2-day timestamp randomization (floored at zero - a negative `since`
   * makes unsigned-integer relay parsers reject the whole filter), then
   * rumors older than the logical `since` are trimmed. Defaults to a
   * 30-day window. Results are best-effort: `querySync` resolves `[]` on
   * timeout and public relays cap responses, so a busy inbox can be
   * silently truncated.
   */
  async fetchHistory(
    identity: ElisymIdentity,
    opts: { since?: number; withPubkey?: string } = {},
  ): Promise<DirectMessage[]> {
    const logicalSince = opts.since ?? nowSecs() - DEFAULTS.DM_HISTORY_WINDOW_SECS;
    const events = await this.pool.querySync(this.inboxFilter(identity, logicalSince));

    const seen = new BoundedSet<string>(MessagesService.DEDUP_CAPACITY);
    const messages: DirectMessage[] = [];
    for (const event of events) {
      const message = this.unwrapToMessage(event, identity);
      if (!message) {
        continue;
      }
      if (message.createdAt < logicalSince) {
        continue;
      }
      if (seen.has(message.id)) {
        continue;
      }
      seen.add(message.id);
      messages.push(message);
    }

    const filtered = opts.withPubkey
      ? messages.filter((message) => counterpartOf(message) === opts.withPubkey)
      : messages;
    return filtered.sort(compareMessages);
  }

  /**
   * Live subscription. Unlike `fetchHistory` there is NO logical-since trim:
   * trimming would silently drop live messages whose rumor `created_at`
   * sits slightly before subscribe-start (sender clock skew, or the gap
   * between history EOSE and the subscription going live). Callers drop
   * duplicates by message id; at subscription start up to ~2 days of
   * replayed wraps arrive. `since` defaults to `now`.
   */
  subscribe(
    identity: ElisymIdentity,
    onMessage: (message: DirectMessage) => void,
    opts: { since?: number } = {},
  ): SubCloser {
    const logicalSince = opts.since ?? nowSecs();
    const seen = new BoundedSet<string>(MessagesService.DEDUP_CAPACITY);
    return this.pool.subscribe(this.inboxFilter(identity, logicalSince), (event) => {
      const message = this.unwrapToMessage(event, identity);
      if (!message) {
        return;
      }
      if (seen.has(message.id)) {
        return;
      }
      seen.add(message.id);
      onMessage(message);
    });
  }

  /**
   * Inbox grouped by counterpart (for own messages the counterpart is the
   * recipient, otherwise the sender), newest conversation first.
   *
   * When `readCursors` (counterpart pubkey -> last-read timestamp) is
   * passed, each summary carries `unreadCount`: counterpart-authored
   * messages strictly newer than that counterpart's cursor. This is the
   * single unread implementation shared by MCP and the web app.
   */
  async listConversations(
    identity: ElisymIdentity,
    opts: { since?: number; readCursors?: Record<string, number> } = {},
  ): Promise<ConversationSummary[]> {
    const messages = await this.fetchHistory(identity, { since: opts.since });
    const byCounterpart = new Map<string, DirectMessage[]>();
    for (const message of messages) {
      const counterpart = counterpartOf(message);
      const group = byCounterpart.get(counterpart);
      if (group) {
        group.push(message);
      } else {
        byCounterpart.set(counterpart, [message]);
      }
    }

    const summaries: ConversationSummary[] = [];
    for (const [counterpartPubkey, group] of byCounterpart) {
      const lastMessage = group[group.length - 1];
      if (!lastMessage) {
        continue;
      }
      const summary: ConversationSummary = {
        counterpartPubkey,
        lastMessage,
        messageCount: group.length,
      };
      if (opts.readCursors) {
        const cursor = opts.readCursors[counterpartPubkey];
        summary.unreadCount = group.filter(
          (message) => !message.isMine && (cursor === undefined || message.createdAt > cursor),
        ).length;
      }
      summaries.push(summary);
    }
    return summaries.sort(
      (left, right) => right.lastMessage.createdAt - left.lastMessage.createdAt,
    );
  }

  /**
   * Publish the kind 10050 DM inbox relay list. Two modes:
   *
   * - Explicit (`relays` given): direct operator intent - publish
   *   unconditionally, WITHOUT the marker tag, no guards. Any guard here
   *   would make the API write-once.
   * - Default (no argument - the announce path): publish the pool's
   *   configured relay set with the `['client', 'elisym']` marker, behind
   *   three guards: (1) one attempt per service instance per pubkey;
   *   (2) candidate validation - queried 10050s must verify, be authored by
   *   this pubkey, be kind 10050, and not be future-skewed (one hostile
   *   relay must not suppress publishing forever); (3) ownership - judge
   *   only the newest surviving event: marker-less = operator-managed,
   *   never overwrite; marker-tagged = ours, refresh only when the relay
   *   set changed; none = publish.
   *
   * Known residual risk, accepted for stage 1: `querySync` resolves `[]`
   * on timeout, indistinguishable from "none exists", so a total lookup
   * failure can republish defaults over an operator list - rare and
   * self-healing (the operator's next explicit publish wins again).
   */
  async publishInboxRelays(identity: ElisymIdentity, relays?: string[]): Promise<void> {
    if (relays !== undefined) {
      if (relays.length === 0) {
        throw new Error('Inbox relay list must not be empty.');
      }
      await this.publishRelayListEvent(identity, relays, false);
      return;
    }

    const pubkey = identity.publicKey;
    if (this.inboxRelaysAttempted.has(pubkey)) {
      return;
    }
    this.inboxRelaysAttempted.add(pubkey);

    const intended = this.pool.getRelays();
    const candidates = await this.pool.querySync({
      kinds: [KIND_DM_INBOX_RELAYS],
      authors: [pubkey],
    });
    const skewLimit = nowSecs() + DEFAULTS.DM_FUTURE_SKEW_SECS;
    const valid = candidates.filter(
      (event) =>
        event.kind === KIND_DM_INBOX_RELAYS &&
        event.pubkey === pubkey &&
        event.created_at <= skewLimit &&
        verifyEvent(event),
    );
    let newest: Event | undefined;
    for (const event of valid) {
      if (!newest || event.created_at > newest.created_at) {
        newest = event;
      }
    }

    if (newest) {
      const isOurs = newest.tags.some(
        (tag) => tag[0] === DM_INBOX_MARKER_TAG && tag[1] === DM_INBOX_MARKER_VALUE,
      );
      if (!isOurs) {
        return;
      }
      const existing = newest.tags
        .filter((tag) => tag[0] === 'relay' && typeof tag[1] === 'string')
        .map((tag) => tag[1] ?? '');
      if (relaySetsEqual(existing, intended)) {
        return;
      }
    }
    await this.publishRelayListEvent(identity, intended, true);
  }

  private async publishRelayListEvent(
    identity: ElisymIdentity,
    relays: string[],
    withMarker: boolean,
  ): Promise<void> {
    const tags = relays.map((url) => ['relay', url]);
    if (withMarker) {
      tags.push([DM_INBOX_MARKER_TAG, DM_INBOX_MARKER_VALUE]);
    }
    const template: EventTemplate = {
      kind: KIND_DM_INBOX_RELAYS,
      created_at: nowSecs(),
      tags,
      content: '',
    };
    await this.pool.publishAll(finalizeEvent(template, identity.secretKey));
  }

  private inboxFilter(identity: ElisymIdentity, logicalSince: number): Filter {
    return {
      kinds: [KIND_GIFT_WRAP],
      '#p': [identity.publicKey],
      since: Math.max(0, logicalSince - DEFAULTS.DM_WRAP_TIMESTAMP_SLACK_SECS),
    };
  }

  /**
   * Secure unwrap - replaces `nip59.unwrapEvent`, which performs no
   * verification at all (it would accept a seal signed by an attacker
   * carrying any `rumor.pubkey`, i.e. sender spoofing). Every failure skips
   * the event silently: an undecryptable wrap is simply not for us, same
   * policy as the marketplace decrypt path.
   */
  private unwrapToMessage(wrap: Event, identity: ElisymIdentity): DirectMessage | null {
    try {
      if (wrap.kind !== KIND_GIFT_WRAP || !verifyEvent(wrap)) {
        return null;
      }
      const secretKey = identity.secretKey;
      const seal = parseSignedEvent(nip44Decrypt(wrap.content, secretKey, wrap.pubkey));
      // The seal signature is the only authenticity anchor in the whole
      // construction - nip59.unwrapEvent never checks it.
      if (!seal || seal.kind !== KIND_DM_SEAL || !verifyEvent(seal)) {
        return null;
      }
      const rumor = parseRumor(nip44Decrypt(seal.content, secretKey, seal.pubkey));
      if (!rumor || rumor.kind !== KIND_DM_RUMOR) {
        return null;
      }
      // A rumor claiming a pubkey other than the seal signer is a spoof
      // (NIP-17 MUST that nostr-tools skips).
      if (rumor.pubkey !== seal.pubkey) {
        return null;
      }
      // The id is our dedup key; keep it honest.
      if (rumor.id !== getEventHash(rumor)) {
        return null;
      }
      if (rumor.created_at > nowSecs() + DEFAULTS.DM_FUTURE_SKEW_SECS) {
        return null;
      }

      const senderPubkey = rumor.pubkey;
      const isMine = senderPubkey === identity.publicKey;
      const firstPTag = rumor.tags.find((tag) => tag[0] === 'p');
      const recipientPubkey = firstPTag?.[1] ?? identity.publicKey;
      return {
        id: rumor.id,
        senderPubkey,
        recipientPubkey,
        content: rumor.content,
        createdAt: rumor.created_at,
        isMine,
      };
    } catch {
      return null;
    }
  }
}

function counterpartOf(message: DirectMessage): string {
  return message.isMine ? message.recipientPubkey : message.senderPubkey;
}

/** Deterministic order: createdAt ascending, id as tiebreak within a second. */
function compareMessages(left: DirectMessage, right: DirectMessage): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

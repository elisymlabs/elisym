import { finalizeEvent, verifyEvent } from 'nostr-tools';
import type { Filter } from 'nostr-tools';
import * as nip17 from 'nostr-tools/nip17';
import * as nip59 from 'nostr-tools/nip59';
import { KIND_GIFT_WRAP, KIND_PING, KIND_PONG, DEFAULTS, LIMITS } from '../constants';
import { BoundedSet } from '../primitives/bounded-set';
import { ElisymIdentity } from '../primitives/identity';
import type { NostrPool } from '../transport/pool';
import type { PingResult, SubCloser } from '../types';

/**
 * Ping/pong and NIP-17 DM service.
 *
 * Uses a session identity (random keypair) for ping operations to avoid
 * relay rate-limiting. The session identity persists for the lifetime of
 * this instance - recreating the service generates a new keypair.
 *
 * Requires `globalThis.crypto` (Node 20+, Bun, browsers).
 */
export class MessagingService {
  private static readonly PING_CACHE_MAX = 1000;
  private sessionIdentity: ElisymIdentity;
  private pingCache = new Map<string, number>(); // pubkey - timestamp of last online result
  private pendingPings = new Map<string, Promise<PingResult>>(); // dedup in-flight pings

  constructor(private pool: NostrPool) {
    this.sessionIdentity = ElisymIdentity.generate();
  }

  /**
   * Ping an agent via ephemeral Nostr events (kind 20200/20201).
   * Uses a persistent session identity to avoid relay rate-limiting.
   * Publishes to ALL relays for maximum delivery reliability.
   * Caches results for 30s to prevent redundant publishes.
   */
  async pingAgent(
    agentPubkey: string,
    timeoutMs: number = DEFAULTS.PING_TIMEOUT_MS,
    signal?: AbortSignal,
    retries: number = DEFAULTS.PING_RETRIES,
  ): Promise<PingResult> {
    // Return cached online result if fresh enough (avoids relay rate-limiting)
    const cachedAt = this.pingCache.get(agentPubkey);
    if (cachedAt) {
      if (Date.now() - cachedAt < DEFAULTS.PING_CACHE_TTL_MS) {
        return { online: true, identity: this.sessionIdentity };
      }
      this.pingCache.delete(agentPubkey); // evict stale entry
    }

    // Lazy sweep: evict stale entries when cache is over half full
    if (this.pingCache.size > MessagingService.PING_CACHE_MAX / 2) {
      const now = Date.now();
      for (const [key, ts] of this.pingCache) {
        if (now - ts >= DEFAULTS.PING_CACHE_TTL_MS) {
          this.pingCache.delete(key);
        }
      }
    }

    // Dedup: return existing in-flight ping for same agent (React Strict Mode sends two)
    const pending = this.pendingPings.get(agentPubkey);
    if (pending) {
      return pending;
    }

    // Guard against unbounded pending pings
    if (this.pendingPings.size >= MessagingService.PING_CACHE_MAX) {
      return { online: false, identity: null };
    }

    const promise = this._doPingWithRetry(agentPubkey, timeoutMs, retries, signal);
    this.pendingPings.set(agentPubkey, promise);
    promise.finally(() => this.pendingPings.delete(agentPubkey));
    return promise;
  }

  private async _doPingWithRetry(
    agentPubkey: string,
    timeoutMs: number,
    retries: number,
    signal?: AbortSignal,
  ): Promise<PingResult> {
    // Split total timeout evenly across attempts
    const attempts = retries + 1;
    const perAttemptTimeout = Math.floor(timeoutMs / attempts);

    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted) {
        return { online: false, identity: null };
      }
      const result = await this._doPing(agentPubkey, perAttemptTimeout, signal);
      if (result.online) {
        return result;
      }
    }
    return { online: false, identity: null };
  }

  private async _doPing(
    agentPubkey: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PingResult> {
    const sk = this.sessionIdentity.secretKey;
    const pk = this.sessionIdentity.publicKey;

    const nonce = crypto
      .getRandomValues(new Uint8Array(16))
      .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

    if (signal?.aborted) {
      return { online: false, identity: null };
    }

    let resolved = false;
    let sub: SubCloser | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolvePing!: (result: PingResult) => void;

    const promise = new Promise<PingResult>((resolve) => {
      resolvePing = resolve;
    });

    const done = (online: boolean) => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (timer) {
        clearTimeout(timer);
      }
      sub?.close();
      signal?.removeEventListener('abort', onAbort);
      if (online) {
        this.pingCache.delete(agentPubkey);
        this.pingCache.set(agentPubkey, Date.now());
        if (this.pingCache.size > MessagingService.PING_CACHE_MAX) {
          const oldest = this.pingCache.keys().next().value;
          if (oldest !== undefined) {
            this.pingCache.delete(oldest);
          }
        }
      }
      resolvePing({ online, identity: online ? this.sessionIdentity : null });
    };

    const onAbort = () => done(false);
    signal?.addEventListener('abort', onAbort);

    // Start timeout BEFORE subscribeAndWait so total time per attempt is bounded by timeoutMs
    timer = setTimeout(() => done(false), timeoutMs);

    // Subscribe and wait for relay confirmation before publishing (ephemeral events require active subscription)
    try {
      sub = await this.pool.subscribeAndWait({ kinds: [KIND_PONG], '#p': [pk] } as Filter, (ev) => {
        if (!verifyEvent(ev)) {
          return;
        }
        if (ev.pubkey !== agentPubkey) {
          return;
        }
        try {
          const msg = JSON.parse(ev.content);
          if (
            msg.type === 'elisym_pong' &&
            typeof msg.nonce === 'string' &&
            msg.nonce.length === 32 &&
            msg.nonce === nonce
          ) {
            done(true);
          }
        } catch {
          /* ignore */
        }
      });
    } catch {
      done(false);
      return promise;
    }

    if (resolved) {
      sub?.close();
      return promise;
    }

    // Publish ephemeral ping to ALL relays - subscription is confirmed active
    const pingEvent = finalizeEvent(
      {
        kind: KIND_PING,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', agentPubkey]],
        content: JSON.stringify({ type: 'elisym_ping', nonce }),
      },
      sk,
    );
    this.pool.publishAll(pingEvent).catch(() => {
      done(false);
    });

    return promise;
  }

  /**
   * Subscribe to incoming ephemeral ping events (kind 20200).
   * No `since` filter needed - ephemeral events are never stored.
   */
  subscribeToPings(
    identity: ElisymIdentity,
    onPing: (senderPubkey: string, nonce: string) => void,
  ): SubCloser {
    return this.pool.subscribe(
      { kinds: [KIND_PING], '#p': [identity.publicKey] } as Filter,
      (ev) => {
        if (!verifyEvent(ev)) {
          return;
        }
        try {
          const msg = JSON.parse(ev.content);
          if (
            msg.type === 'elisym_ping' &&
            typeof msg.nonce === 'string' &&
            msg.nonce.length === 32
          ) {
            onPing(ev.pubkey, msg.nonce);
          }
        } catch {
          /* ignore */
        }
      },
    );
  }

  /** Send an ephemeral pong response to ALL relays. */
  async sendPong(identity: ElisymIdentity, recipientPubkey: string, nonce: string): Promise<void> {
    const pongEvent = finalizeEvent(
      {
        kind: KIND_PONG,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', recipientPubkey]],
        content: JSON.stringify({ type: 'elisym_pong', nonce }),
      },
      identity.secretKey,
    );
    await this.pool.publishAll(pongEvent);
  }

  /** Send a NIP-17 DM. */
  async sendMessage(
    identity: ElisymIdentity,
    recipientPubkey: string,
    content: string,
  ): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(recipientPubkey)) {
      throw new Error('Invalid recipient pubkey: expected 64 hex characters.');
    }
    if (content.length > LIMITS.MAX_MESSAGE_LENGTH) {
      throw new Error(
        `Message too long: ${content.length} chars (max ${LIMITS.MAX_MESSAGE_LENGTH}).`,
      );
    }
    const wrap = nip17.wrapEvent(identity.secretKey, { publicKey: recipientPubkey }, content);
    await this.pool.publish(wrap);
  }

  /** Fetch historical NIP-17 DMs from relays. Returns decrypted messages sorted by time. */
  async fetchMessageHistory(
    identity: ElisymIdentity,
    since: number,
  ): Promise<{ senderPubkey: string; content: string; createdAt: number; rumorId: string }[]> {
    const events = await this.pool.querySync({
      kinds: [KIND_GIFT_WRAP],
      '#p': [identity.publicKey],
      since,
    } as Filter);

    const seen = new BoundedSet<string>(10_000);
    const messages: {
      senderPubkey: string;
      content: string;
      createdAt: number;
      rumorId: string;
    }[] = [];

    for (const ev of events) {
      try {
        const rumor = nip59.unwrapEvent(ev, identity.secretKey);
        if (rumor.kind !== 14) {
          continue;
        } // NIP-17: DM rumor kind must be 14
        if (seen.has(rumor.id)) {
          continue;
        }
        seen.add(rumor.id);
        messages.push({
          senderPubkey: rumor.pubkey,
          content: rumor.content,
          createdAt: rumor.created_at,
          rumorId: rumor.id,
        });
      } catch {
        /* not encrypted for us */
      }
    }

    return messages.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Subscribe to incoming NIP-17 DMs. */
  subscribeToMessages(
    identity: ElisymIdentity,
    onMessage: (senderPubkey: string, content: string, createdAt: number, rumorId: string) => void,
    since?: number,
  ): SubCloser {
    const seen = new BoundedSet<string>(10_000);
    const filter: Filter = {
      kinds: [KIND_GIFT_WRAP],
      '#p': [identity.publicKey],
    };
    if (since !== undefined) {
      filter.since = since;
    }
    return this.pool.subscribe(filter, (ev) => {
      try {
        const rumor = nip59.unwrapEvent(ev, identity.secretKey);
        if (rumor.kind !== 14) {
          return;
        } // NIP-17: DM rumor kind must be 14
        if (seen.has(rumor.id)) {
          return;
        }
        seen.add(rumor.id);
        onMessage(rumor.pubkey, rumor.content, rumor.created_at, rumor.id);
      } catch {
        /* not our message */
      }
    });
  }
}

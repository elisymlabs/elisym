import {
  type ChatMessage,
  STATUS_TTL_SECS,
  type UnavailableReason,
  wrapChatMessage,
} from '@elisym/comcore';
import {
  type LlmProvider,
  type ModelPrice,
  type StoreCatalog,
  TurnError,
  costOf,
  runTurn,
} from '@elisym/comcore-agent';
import Decimal from 'decimal.js-light';
import type { NostrEvent } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import {
  CONNECTION_TIMEOUT_MS,
  RELOAD_SLOTS,
  SUBSCRIPTION_BUDGET,
  STABLE_CONNECTION_MS,
  SWEEP_INTERVAL_MS,
  TURN_DEADLINE_MS,
  VERIFIED_IDS_TTL_SECS,
  WRAP_SINCE_SECS,
} from '../constants';
import { Backoff } from '../relay/backoff';
import { chunkByBytes } from '../relay/chunks';
import { readHistory } from '../relay/history';
import type { ServerPool } from '../relay/pool';
import type { ServerState, SessionState, StoreRecord } from '../state/types';
import { CatalogLoader } from './catalog-loader';
import { intakeWrap } from './intake';

const KIND_GIFT_WRAP = 1059;
/**
 * Messages of history a session keeps (a visitor turn and the answer note per
 * ask), so a turn's input cost stays bounded; phase 3 compacts instead (5.8).
 */
const MAX_HISTORY_MESSAGES = 20;

/** Wrap a provider so a turn stops calling the model once its spend reaches `maxUsd`. */
export function cappedProvider(
  provider: LlmProvider,
  price: ModelPrice,
  maxUsd: string,
): LlmProvider {
  let spent = new Decimal(0);
  return {
    model: provider.model,
    async turn(request) {
      if (spent.greaterThanOrEqualTo(maxUsd)) {
        throw new Error('The turn reached its spend ceiling');
      }
      const response = await provider.turn(request);
      spent = spent.plus(costOf(response.usage, price));
      return response;
    },
  };
}

export interface WorkerDeps {
  relayUrl: string;
  state: ServerState;
  pool: ServerPool;
  /** The gateway keys (G) whose tickets this worker accepts. */
  gatewayKeys: readonly string[];
  providerFor: (store: StoreRecord) => LlmProvider;
  /** The model's price, for settling spend (5.8). */
  price: ModelPrice;
  /**
   * Reserved before a turn and also that turn's spend ceiling: no model call
   * starts once the turn's cost reaches it (5.8). So a store's spend can pass
   * its daily budget by at most the last model call of each turn in flight.
   */
  reserveUsd: string;
  /** A history read with no real EOSE in this long fails (2.4); tests shorten it. */
  historyTimeoutMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * One worker (5.8): it reads every leased store's catalog (5.1), listens for
 * wraps to their assistant keys (2.4) and answers asks one turn at a time per
 * session. Phase 2 leases every active store of the state to this worker.
 */
export class Worker {
  private readonly loader: CatalogLoader;
  /** Wrap id to expiry; insertion order is expiry order (one TTL). */
  private readonly verifiedIds = new Map<string, number>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly backoff = new Backoff();
  /** Leased A (hex) to its store's owner; the pre-check reads it on every wrap. */
  private leases = new Map<string, string>();
  private stopped = true;
  private wrapGeneration = 0;
  private wrapSubscriptions: { close: () => void }[] = [];
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: WorkerDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = deps.log ?? (() => undefined);
    this.loader = new CatalogLoader({
      relayUrl: deps.relayUrl,
      pool: deps.pool,
      leased: () => this.leasedStores(),
      ...(deps.historyTimeoutMs === undefined ? {} : { historyTimeoutMs: deps.historyTimeoutMs }),
      now: this.now,
      log: this.log,
    });
  }

  get catalogs(): ReadonlyMap<string, StoreCatalog> {
    return this.loader.catalogs;
  }

  isLeased(assistant: string): boolean {
    return this.leases.has(assistant);
  }

  private leasedStores(): StoreRecord[] {
    return [...this.leases.values()].flatMap((owner) => this.deps.state.store(owner) ?? []);
  }

  /**
   * Recompute the leased set from the state (start, and whenever a store's
   * status changes). A newly leased A joins before its wrap REQ is
   * re-issued, so its replay is not dropped (2.4); its catalog is queued.
   */
  refreshLeases(): void {
    const next = new Map<string, string>();
    for (const store of this.deps.state.stores()) {
      if (store.status === 'active') {
        next.set(getPublicKey(store.assistantSecretKey), store.owner);
      }
    }
    const previous = this.leases;
    this.leases = next;
    const changed =
      next.size !== previous.size || [...next.keys()].some((key) => !previous.has(key));
    if (!changed || this.stopped) {
      return;
    }
    for (const [assistant, owner] of previous) {
      if (!next.has(assistant)) {
        this.loader.drop(owner);
      }
    }
    for (const [assistant, owner] of next) {
      if (!previous.has(assistant)) {
        this.loader.enqueue(owner);
      }
    }
    this.loader.reissueLiveIfChanged();
    this.openWraps();
  }

  async start(): Promise<void> {
    this.leases = new Map();
    this.refreshLeases();
    this.stopped = false;
    this.loader.start();
    await this.loader.settled();
    if (this.stopped) {
      return;
    }
    this.openWraps();
    this.sweepTimer = setInterval(() => this.deps.state.sweep(this.now()), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.wrapGeneration += 1;
    for (const subscription of this.wrapSubscriptions) {
      subscription.close();
    }
    this.wrapSubscriptions = [];
    this.loader.stop();
    clearInterval(this.sweepTimer);
  }

  /** Settle every queued turn (tests and shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.sessionQueues.values()]);
  }

  /** Settle every queued catalog reload (tests). */
  async catalogsSettled(): Promise<void> {
    await this.loader.settled();
  }

  private alreadyHave(id: string): boolean {
    const expiresAt = this.verifiedIds.get(id);
    return expiresAt !== undefined && expiresAt > this.now();
  }

  /**
   * The batched wrap REQ for every leased A, from `since` = now - 10 min
   * (2.4), split by the byte cap. A re-issue opens the new REQs, then closes
   * the old ones; any close of the current ones reopens them all after the
   * backoff.
   */
  private openWraps(): void {
    if (this.stopped) {
      return;
    }
    const generation = ++this.wrapGeneration;
    const previous = this.wrapSubscriptions;
    const chunks = chunkByBytes([...this.leases.keys()]);
    const needed = chunks.length + this.loader.liveRequests + RELOAD_SLOTS;
    if (needed > SUBSCRIPTION_BUDGET) {
      this.log(
        `subscription budget exceeded: ${needed} REQs for ${this.leases.size} stores (budget ${SUBSCRIPTION_BUDGET})`,
      );
    }
    if (chunks.length === 0) {
      this.wrapSubscriptions = [];
      for (const subscription of previous) {
        subscription.close();
      }
      return;
    }
    const opened = Date.now();
    void this.deps.pool
      .ensureRelay(this.deps.relayUrl, { connectionTimeout: CONNECTION_TIMEOUT_MS })
      .then(
        (relay) => {
          if (generation !== this.wrapGeneration) {
            return;
          }
          this.wrapSubscriptions = chunks.map((chunk) => {
            const read = readHistory(
              relay,
              [{ kinds: [KIND_GIFT_WRAP], '#p': chunk, since: this.now() - WRAP_SINCE_SECS }],
              (event) => this.onWrap(event),
              {
                alreadyHaveEvent: (id) => this.alreadyHave(id),
                ...(this.deps.historyTimeoutMs === undefined
                  ? {}
                  : { timeoutMs: this.deps.historyTimeoutMs }),
                onClose: () => this.wrapsClosed(generation, opened),
              },
            );
            // With no real EOSE in time, readHistory closes the REQ itself, which reopens it here.
            return read;
          });
          for (const subscription of previous) {
            subscription.close();
          }
        },
        () => this.wrapsClosed(generation, opened),
      );
  }

  private wrapsClosed(generation: number, opened: number): void {
    if (this.stopped || generation !== this.wrapGeneration) {
      return;
    }
    this.wrapGeneration += 1;
    for (const subscription of this.wrapSubscriptions) {
      subscription.close();
    }
    this.wrapSubscriptions = [];
    if (Date.now() - opened >= STABLE_CONNECTION_MS) {
      this.backoff.reset();
    }
    setTimeout(() => this.openWraps(), this.backoff.next());
  }

  private onWrap(wrap: NostrEvent): void {
    const now = this.now();
    for (const [id, expiresAt] of this.verifiedIds) {
      if (expiresAt > now) {
        break;
      }
      this.verifiedIds.delete(id);
    }
    this.verifiedIds.set(wrap.id, now + VERIFIED_IDS_TTL_SECS);
    const intake = intakeWrap(wrap, this.deps.state, this.deps.gatewayKeys, now);
    if (intake.action === 'drop') {
      return;
    }
    if (intake.action === 'unavailable') {
      void this.send(
        intake.store,
        intake.visitor,
        { type: 'unavailable', ask_id: intake.askId, reason: intake.reason },
        intake.sessionEnd,
      );
      return;
    }
    const key = `${intake.session.assistant}:${intake.session.visitor}`;
    const previous = this.sessionQueues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.handleAsk(intake.store, intake.session, intake.ask))
      .catch((error: unknown) => {
        this.log(`turn failed: ${error instanceof Error ? error.message : 'unknown'}`);
      })
      .finally(() => {
        if (this.sessionQueues.get(key) === next) {
          this.sessionQueues.delete(key);
        }
      });
    this.sessionQueues.set(key, next);
  }

  private async send(
    store: StoreRecord,
    visitor: string,
    message: ChatMessage,
    expiresAt: number,
  ): Promise<NostrEvent | undefined> {
    const now = this.now();
    if (expiresAt <= now) {
      return undefined;
    }
    const { wrap } = wrapChatMessage({
      message,
      senderSecretKey: store.assistantSecretKey,
      recipientPubkey: visitor,
      expiresAt,
      now,
    });
    await this.publish(wrap);
    return wrap;
  }

  private async publish(wrap: NostrEvent): Promise<void> {
    try {
      await Promise.any(this.deps.pool.publish([this.deps.relayUrl], wrap));
    } catch {
      this.log('publish failed');
    }
  }

  private async refuse(
    store: StoreRecord,
    session: SessionState,
    askId: string,
    reason: UnavailableReason,
  ): Promise<void> {
    await this.send(
      store,
      session.visitor,
      { type: 'unavailable', ask_id: askId, reason },
      session.sessionEnd,
    );
  }

  private async handleAsk(
    store: StoreRecord,
    session: SessionState,
    ask: { ask_id: string; text: string; page?: { url: string }; locale?: string },
  ): Promise<void> {
    const now = this.now();
    const existing = this.deps.state.askRecord(session, ask.ask_id);
    if (existing?.state === 'answered' && existing.answerWrap) {
      // The stored exact answer, same id: a widget that has it drops it (5.8).
      await this.publish(existing.answerWrap);
      return;
    }
    const live =
      existing &&
      (existing.state === 'queued' || existing.state === 'running') &&
      existing.deadline > now * 1000;
    if (live) {
      return;
    }
    const admitted = existing
      ? this.deps.state.retryAsk(session, ask.ask_id, this.deps.reserveUsd, now)
      : this.deps.state.admitAsk(session, ask.ask_id, this.deps.reserveUsd, now);
    if (!admitted.admitted) {
      await this.refuse(store, session, ask.ask_id, admitted.reason);
      return;
    }
    const catalog = this.catalogs.get(store.owner);
    const deadline = now * 1000 + TURN_DEADLINE_MS;
    const { attemptId } = admitted.record;
    if (!this.deps.state.startAsk(session, ask.ask_id, attemptId, deadline)) {
      return;
    }
    if (catalog === undefined) {
      if (this.deps.state.failAsk(session, ask.ask_id, attemptId, '0')) {
        await this.refuse(store, session, ask.ask_id, 'error');
      }
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_DEADLINE_MS);
    try {
      const output = await runTurn({
        catalog,
        provider: cappedProvider(
          this.deps.providerFor(store),
          this.deps.price,
          this.deps.reserveUsd,
        ),
        history: session.history,
        askId: ask.ask_id,
        text: ask.text,
        ...(ask.page ? { pageUrl: ask.page.url } : {}),
        ...(ask.locale ? { locale: ask.locale } : {}),
        sessionEnd: session.sessionEnd,
        now,
        earlierVisitorMessages: session.visitorMessages,
        earlierPolicyPassages: session.policyPassages,
        earlierAllowedIds: session.allowedIds,
        signal: controller.signal,
        onStatus: (text) => {
          void this.send(
            store,
            session.visitor,
            { type: 'status', ask_id: ask.ask_id, text },
            Math.min(this.now() + STATUS_TTL_SECS, session.sessionEnd),
          );
        },
      });
      const spent = costOf(output.usage, this.deps.price).toString();
      const { wrap } = wrapChatMessage({
        message: output.answer,
        senderSecretKey: store.assistantSecretKey,
        recipientPubkey: session.visitor,
        expiresAt: session.sessionEnd,
        now: this.now(),
      });
      if (this.deps.state.answerAsk(session, ask.ask_id, attemptId, wrap, spent, this.now())) {
        session.history = output.history.slice(-MAX_HISTORY_MESSAGES);
        session.visitorMessages = [...session.visitorMessages, ask.text];
        session.policyPassages = [...session.policyPassages, ...output.policyPassages];
        session.allowedIds = output.allowedIds;
        this.deps.state.saveSession(session);
        await this.publish(wrap);
      } else if (this.deps.state.failAsk(session, ask.ask_id, attemptId, spent)) {
        // Past the deadline: the visitor was told to retry, so the late answer is dropped, its spend kept.
        await this.refuse(store, session, ask.ask_id, 'error');
      }
    } catch (error) {
      const spent =
        error instanceof TurnError ? costOf(error.usage, this.deps.price).toString() : '0';
      if (this.deps.state.failAsk(session, ask.ask_id, attemptId, spent)) {
        await this.refuse(store, session, ask.ask_id, 'error');
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

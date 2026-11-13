import {
  type ChatMessage,
  SESSION_END_MARGIN_SECS,
  STATUS_TTL_SECS,
  type UnavailableReason,
  wrapChatMessage,
} from '@elisym/askr';
import {
  type LlmProvider,
  type ModelPrice,
  type StoreCatalog,
  TurnError,
  costOf,
  runTurn,
} from '@elisym/askr-agent';
import Decimal from 'decimal.js-light';
import type { NostrEvent } from 'nostr-tools';
import {
  CONNECTION_TIMEOUT_MS,
  LEASE_RENEW_MS,
  LEASE_TTL_SECS,
  RELOAD_SLOTS,
  SHUTDOWN_WAIT_MS,
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
import type { RelayLike, ServerPool } from '../relay/pool';
import { publishToRelay } from '../relay/publish';
import { randomId } from '../state/pg-state';
import type { LeasedStore, ServerState, SessionState, StoreRecord } from '../state/types';
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
  /** This worker's lease holder id (5.8); a fresh one per process unless given. */
  holder?: string;
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
  /** max_tokens per model call, thinking included; runTurn's default when absent. */
  maxTokens?: number;
  /** A history read with no real EOSE in this long fails (2.4); tests shorten it. */
  historyTimeoutMs?: number;
  /** Pay Core default relays' timeouts (5.1); tests shorten them. */
  extraRelayTimeoutMs?: number;
  extraRelayBudgetMs?: number;
  /** How long a connection must stay up to reset a backoff (2.4); tests shorten it. */
  stableConnectionMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * One worker (5.8): it holds leases on active stores, reads every leased
 * store's catalog (5.1), listens for wraps to their assistant keys (2.4) and
 * answers asks one turn at a time per session.
 */
export class Worker {
  private readonly loader: CatalogLoader;
  /** Wrap id to expiry; insertion order is expiry order (one TTL). */
  private readonly verifiedIds = new Map<string, number>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  /** Intake per assistant key (A), in arrival order. */
  private readonly intakeQueues = new Map<string, Promise<void>>();
  private readonly backoff = new Backoff();
  /** Leased A (hex) to its store and lease epoch; the pre-check reads it on every wrap. */
  private leases = new Map<string, LeasedStore>();
  private leaseRefresh: Promise<void> = Promise.resolve();
  private leaseTimer: ReturnType<typeof setInterval> | undefined;
  private readonly holder: string;
  private stopped = true;
  /** Set by `stop()`: a lease refresh still queued then takes nothing. */
  private halted = false;
  private wrapGeneration = 0;
  private wrapSubscriptions: { close: () => void }[] = [];
  /** The connection the wrap REQ runs on and when it came up: re-issues on it keep that time (2.4). */
  private wrapRelay: RelayLike | undefined;
  private wrapRelayUpAt = 0;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: WorkerDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = deps.log ?? (() => undefined);
    this.holder = deps.holder ?? randomId();
    this.loader = new CatalogLoader({
      relayUrl: deps.relayUrl,
      pool: deps.pool,
      leased: () => this.leasedStores(),
      ...(deps.historyTimeoutMs === undefined ? {} : { historyTimeoutMs: deps.historyTimeoutMs }),
      ...(deps.extraRelayTimeoutMs === undefined
        ? {}
        : { extraRelayTimeoutMs: deps.extraRelayTimeoutMs }),
      ...(deps.extraRelayBudgetMs === undefined
        ? {}
        : { extraRelayBudgetMs: deps.extraRelayBudgetMs }),
      ...(deps.stableConnectionMs === undefined
        ? {}
        : { stableConnectionMs: deps.stableConnectionMs }),
      now: this.now,
      log: this.log,
    });
  }

  get catalogs(): ReadonlyMap<string, StoreCatalog> {
    return this.loader.catalogs;
  }

  /** A leased store read in full with nothing to serve (3). */
  isUnservable(owner: string): boolean {
    return this.loader.isUnservable(owner);
  }

  isLeased(assistant: string): boolean {
    return this.leases.has(assistant);
  }

  /** This worker's lease holder id (5.8). */
  get holderId(): string {
    return this.holder;
  }

  /** The leased store of an assistant key, if this worker holds its lease. */
  leaseOf(assistant: string): LeasedStore | undefined {
    return this.leases.get(assistant);
  }

  private leasedStores(): StoreRecord[] {
    return [...this.leases.values()].map((lease) => lease.store);
  }

  /**
   * Take and renew leases (5.8) and apply the leased set: on start, on the
   * renewal timer (which also covers a missed store notify, 7.3) and on a
   * store notify. A newly leased A joins before its wrap REQ is re-issued, so
   * its replay is not dropped (2.4); its catalog is queued. Calls are
   * serialized; a failed read keeps the current set until the next one.
   */
  refreshLeases(): Promise<void> {
    this.leaseRefresh = this.leaseRefresh.then(() =>
      this.applyLeases().catch((error: unknown) => {
        this.log(`lease refresh failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }),
    );
    return this.leaseRefresh;
  }

  private async applyLeases(): Promise<void> {
    if (this.halted) {
      return;
    }
    const held = await this.deps.state.acquireLeases(this.holder, this.now(), LEASE_TTL_SECS);
    const next = new Map(held.map((lease) => [lease.store.assistant, lease]));
    const previous = this.leases;
    this.leases = next;
    const changed =
      next.size !== previous.size || [...next.keys()].some((key) => !previous.has(key));
    if (!changed || this.stopped) {
      return;
    }
    for (const [assistant, lease] of previous) {
      if (!next.has(assistant)) {
        this.loader.drop(lease.store.owner);
      }
    }
    for (const [assistant, lease] of next) {
      if (!previous.has(assistant)) {
        this.loader.enqueue(lease.store.owner);
      }
    }
    this.loader.reissueLiveIfChanged();
    this.openWraps();
  }

  async start(): Promise<void> {
    this.leases = new Map();
    this.halted = false;
    await this.refreshLeases();
    // A stop() during the lease read wins: nothing starts.
    if (this.halted) {
      return;
    }
    this.stopped = false;
    this.loader.start();
    await this.loader.settled();
    if (this.stopped) {
      return;
    }
    this.openWraps();
    this.leaseTimer = setInterval(() => void this.refreshLeases(), LEASE_RENEW_MS);
    this.sweepTimer = setInterval(() => {
      this.deps.state.sweep(this.now()).catch((error: unknown) => {
        this.log(`sweep failed: ${error instanceof Error ? error.message : 'unknown'}`);
      });
    }, SWEEP_INTERVAL_MS);
  }

  /**
   * Stop and give up this worker's leases, so another worker can take them at
   * once. Turns in flight get up to `maxWaitMs` (inside Docker's 10 s stop
   * grace); one still running then is resolved like any attempt of a dead
   * lease (5.8).
   */
  async shutdown(maxWaitMs: number = SHUTDOWN_WAIT_MS): Promise<void> {
    this.stop();
    // A renewal already running would take the leases again after the release below.
    await this.leaseRefresh;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxWaitMs);
    });
    await Promise.race([this.idle(), waited]);
    clearTimeout(timer);
    await this.deps.state.releaseLeases(this.holder);
  }

  stop(): void {
    this.stopped = true;
    this.halted = true;
    clearInterval(this.leaseTimer);
    this.wrapGeneration += 1;
    for (const subscription of this.wrapSubscriptions) {
      subscription.close();
    }
    this.wrapSubscriptions = [];
    this.loader.stop();
    clearInterval(this.sweepTimer);
  }

  /** Settle every intake and queued turn (tests and shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.intakeQueues.values()]);
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
    void this.deps.pool
      .ensureRelay(this.deps.relayUrl, { connectionTimeout: CONNECTION_TIMEOUT_MS })
      .then(
        (relay) => {
          if (generation !== this.wrapGeneration) {
            return;
          }
          if (relay !== this.wrapRelay) {
            this.wrapRelay = relay;
            this.wrapRelayUpAt = Date.now();
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
                onClose: () => this.wrapsClosed(generation),
              },
            );
            // With no real EOSE in time, readHistory closes the REQ itself, which reopens it here.
            return read;
          });
          for (const subscription of previous) {
            subscription.close();
          }
        },
        () => this.wrapsClosed(generation),
      );
  }

  private wrapsClosed(generation: number): void {
    if (this.stopped || generation !== this.wrapGeneration) {
      return;
    }
    this.wrapGeneration += 1;
    for (const subscription of this.wrapSubscriptions) {
      subscription.close();
    }
    this.wrapSubscriptions = [];
    if (
      this.wrapRelay !== undefined &&
      Date.now() - this.wrapRelayUpAt >= (this.deps.stableConnectionMs ?? STABLE_CONNECTION_MS)
    ) {
      this.backoff.reset();
    }
    this.wrapRelay = undefined;
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
    // Intake is a few awaited steps (decrypt, dedup, session), so two asks of one session read
    // back to back could enter their session's turn queue in the wrong order. The sender is
    // known only after decrypt, so intake is chained per recipient A (the pre-check ensured
    // exactly one `p`): arrival order holds within a store, stores still run in parallel, and a
    // flood to one A delays only that store. The turns themselves stay queued per session.
    const recipient = wrap.tags.find((tag) => tag[0] === 'p')?.[1] ?? '';
    const previous = this.intakeQueues.get(recipient) ?? Promise.resolve();
    const next = previous
      .then(() => this.takeWrap(wrap, now))
      .catch((error: unknown) => {
        this.log(`intake failed: ${error instanceof Error ? error.message : 'unknown'}`);
      })
      .finally(() => {
        if (this.intakeQueues.get(recipient) === next) {
          this.intakeQueues.delete(recipient);
        }
      });
    this.intakeQueues.set(recipient, next);
  }

  private async takeWrap(wrap: NostrEvent, now: number): Promise<void> {
    const intake = await intakeWrap(
      wrap,
      (assistant) => this.leases.get(assistant),
      this.deps.state,
      this.deps.gatewayKeys,
      now,
    );
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
      .then(() => this.handleAsk(intake.store, intake.epoch, intake.session, intake.ask))
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

  /**
   * Best effort: an answer not delivered is stored (5.8) and re-published when
   * the widget asks again; a status or refusal is not worth a retry.
   */
  private async publish(wrap: NostrEvent): Promise<void> {
    const outcome = await publishToRelay(this.deps.pool, this.deps.relayUrl, wrap);
    if (outcome.status !== 'accepted') {
      this.log(`publish ${outcome.status}: ${outcome.reason}`);
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
    epoch: number,
    queued: SessionState,
    ask: { ask_id: string; text: string; page?: { url: string }; locale?: string },
  ): Promise<void> {
    const now = this.now();
    // An ask queued behind a turn may run after its session ended or was replaced: it is not
    // started on that session (the widget times out and asks again in a fresh one).
    const session = await this.deps.state.storedSession(queued.assistant, queued.visitor);
    if (session?.id !== queued.id || session.sessionEnd - now <= SESSION_END_MARGIN_SECS) {
      this.log('ask dropped: its session ended');
      return;
    }
    const existing = await this.deps.state.askRecord(session, ask.ask_id);
    if (existing?.state === 'answered' && existing.answerWrap) {
      // The stored exact answer, same id: a widget that has it drops it (5.8).
      await this.publish(existing.answerWrap);
      return;
    }
    const live =
      existing &&
      (existing.state === 'queued' || existing.state === 'running') &&
      existing.leaseEpoch === epoch &&
      existing.deadline > now * 1000;
    if (live) {
      return;
    }
    const admitted = existing
      ? await this.deps.state.retryAsk(
          session,
          ask.ask_id,
          existing.attemptId,
          this.deps.reserveUsd,
          epoch,
          now,
        )
      : await this.deps.state.admitAsk(session, ask.ask_id, this.deps.reserveUsd, epoch, now);
    if (!admitted.admitted) {
      if (admitted.reason === 'superseded') {
        // Our lease moved on or another attempt owns the ask: its holder answers, we stay silent.
        this.log('ask dropped: superseded');
        return;
      }
      await this.refuse(store, session, ask.ask_id, admitted.reason);
      return;
    }
    const catalog = this.catalogs.get(store.owner);
    const deadline = now * 1000 + TURN_DEADLINE_MS;
    const { attemptId } = admitted.record;
    if (!(await this.deps.state.startAsk(session, ask.ask_id, attemptId, epoch, deadline))) {
      return;
    }
    if (catalog === undefined) {
      if (await this.deps.state.failAsk(session, ask.ask_id, attemptId, epoch, '0')) {
        await this.refuse(store, session, ask.ask_id, 'error');
      }
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_DEADLINE_MS);
    // Set once the model calls are done, so a failure after them (wrapping, the answer's step) still settles it.
    let spent: string | undefined;
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
        ...(this.deps.maxTokens === undefined ? {} : { maxTokens: this.deps.maxTokens }),
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
      spent = costOf(output.usage, this.deps.price).toString();
      if (session.sessionEnd <= this.now()) {
        // The session ended during the turn: nothing can be sent, but what it spent is charged.
        await this.deps.state.failAsk(session, ask.ask_id, attemptId, epoch, spent);
        return;
      }
      const { wrap } = wrapChatMessage({
        message: output.answer,
        senderSecretKey: store.assistantSecretKey,
        recipientPubkey: session.visitor,
        expiresAt: session.sessionEnd,
        now: this.now(),
      });
      const answered: SessionState = {
        ...session,
        history: output.history.slice(-MAX_HISTORY_MESSAGES),
        visitorMessages: [...session.visitorMessages, ask.text],
        policyPassages: [...session.policyPassages, ...output.policyPassages],
        allowedIds: output.allowedIds,
      };
      if (
        await this.deps.state.answerAsk(
          answered,
          ask.ask_id,
          attemptId,
          epoch,
          wrap,
          spent,
          this.now(),
        )
      ) {
        await this.publish(wrap);
      } else if (await this.deps.state.failAsk(session, ask.ask_id, attemptId, epoch, spent)) {
        // Past the deadline: the visitor was told to retry, so the late answer is dropped, its spend kept.
        await this.refuse(store, session, ask.ask_id, 'error');
      }
    } catch (error) {
      const charged =
        spent ??
        (error instanceof TurnError ? costOf(error.usage, this.deps.price).toString() : '0');
      if (await this.deps.state.failAsk(session, ask.ask_id, attemptId, epoch, charged)) {
        await this.refuse(store, session, ask.ask_id, 'error');
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

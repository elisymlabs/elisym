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
import type { Filter, NostrEvent } from 'nostr-tools';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import type { AbstractRelay } from 'nostr-tools/abstract-relay';
import { getPublicKey } from 'nostr-tools/pure';
import {
  CATALOG_PAGE_LIMIT,
  CONNECTION_TIMEOUT_MS,
  TURN_DEADLINE_MS,
  VERIFIED_IDS_TTL_SECS,
  WRAP_SINCE_SECS,
} from '../constants';
import { Backoff } from '../relay/backoff';
import { readHistory } from '../relay/history';
import type { ServerState, SessionState, StoreRecord } from '../state/types';
import { buildStoreCatalog, keyFilters, ownerFilters, storeConfig } from './catalog';
import { intakeWrap } from './intake';

const KIND_GIFT_WRAP = 1059;
/**
 * Messages of history a session keeps (a visitor turn and the answer note per
 * ask), so a turn's input cost stays bounded; phase 3 compacts instead (5.8).
 */
const MAX_HISTORY_MESSAGES = 20;

/** Wrap a provider so a turn stops calling the model once its spend passes `maxUsd`. */
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
/** A connection that stayed up this long resets the backoff (one ping cycle, 2.4). */
const STABLE_CONNECTION_MS = 60_000;

export interface WorkerDeps {
  relayUrl: string;
  state: ServerState;
  pool: AbstractSimplePool;
  /** The gateway keys (G) whose tickets this worker accepts. */
  gatewayKeys: readonly string[];
  providerFor: (store: StoreRecord) => LlmProvider;
  /** The model's price, for settling spend (5.8). */
  price: ModelPrice;
  /** The estimate reserved before a turn, including one price-check re-run (5.8). */
  reserveUsd: string;
  /**
   * A hard ceiling on one turn's spend: once the turn's cost so far passes it,
   * no further model call is made and the turn ends with `error`. So a store's
   * overshoot past its daily budget is at most one model call per turn in flight.
   */
  maxTurnUsd: string;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * One worker (5.8): it reads every leased store's catalog (5.1), listens for
 * wraps to their assistant keys (2.4) and answers asks one turn at a time per
 * session. Phase 2 leases every active store of the state to this worker.
 */
export class Worker {
  readonly catalogs = new Map<string, StoreCatalog>();
  private readonly verifiedIds = new Map<string, number>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly backoff = new Backoff();
  private stopped = false;
  private closeWraps: (() => void) | undefined;
  private closeCatalog: (() => void) | undefined;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: WorkerDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = deps.log ?? (() => undefined);
  }

  leasedAssistants(): string[] {
    return this.deps.state
      .stores()
      .filter((store) => store.status === 'active')
      .map((store) => getPublicKey(store.assistantSecretKey));
  }

  isLeased(assistant: string): boolean {
    return this.leasedAssistants().includes(assistant);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.loadCatalogs();
    this.openCatalogLive();
    this.openWraps();
  }

  stop(): void {
    this.stopped = true;
    this.closeWraps?.();
    this.closeCatalog?.();
  }

  /** Settle every queued turn (tests and shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.sessionQueues.values()]);
  }

  private relay(): Promise<AbstractRelay> {
    return this.deps.pool.ensureRelay(this.deps.relayUrl, {
      connectionTimeout: CONNECTION_TIMEOUT_MS,
    });
  }

  /** Read every page of a filter set backwards in time; undefined unless every page ended in a real EOSE on one connection. */
  private async readAll(filters: Filter[]): Promise<NostrEvent[] | undefined> {
    const relay = await this.relay();
    const collected: NostrEvent[] = [];
    for (const filter of filters) {
      let until: number | undefined;
      for (;;) {
        const page: NostrEvent[] = [];
        const read = readHistory(
          relay,
          [{ ...filter, limit: CATALOG_PAGE_LIMIT, ...(until === undefined ? {} : { until }) }],
          (event) => page.push(event),
        );
        const real = await read.done;
        read.close();
        if (!real || !relay.connected) {
          return undefined;
        }
        collected.push(...page);
        if (page.length < CATALOG_PAGE_LIMIT) {
          break;
        }
        until = Math.min(...page.map((event) => event.created_at)) - 1;
      }
    }
    return collected;
  }

  private async loadStore(store: StoreRecord): Promise<void> {
    const ownerEvents = await this.readAll(ownerFilters(store.owner));
    if (!ownerEvents) {
      return;
    }
    const config = storeConfig(ownerEvents, store.owner, this.now());
    const keyEvents = config
      ? await this.readAll(keyFilters(config.catalogKey, config.policyKey))
      : [];
    if (!keyEvents) {
      return;
    }
    // A reload replaces the cache only after real EOSEs (5.1); otherwise the old cache stays.
    const catalog = buildStoreCatalog(
      [...ownerEvents, ...keyEvents],
      store.owner,
      store.assistantSecretKey,
      this.now(),
    );
    if (catalog) {
      this.catalogs.set(store.owner, catalog);
    } else {
      this.catalogs.delete(store.owner);
    }
  }

  private async loadCatalogs(): Promise<void> {
    for (const store of this.deps.state.stores().filter((record) => record.status === 'active')) {
      await this.loadStore(store);
    }
  }

  /** A live `limit: 0` REQ over every store's authors; any new event reloads that store. */
  private openCatalogLive(): void {
    if (this.stopped) {
      return;
    }
    const authorsToOwner = new Map<string, string>();
    for (const [owner, catalog] of this.catalogs) {
      authorsToOwner.set(owner, owner);
      authorsToOwner.set(catalog.config.catalogKey, owner);
      authorsToOwner.set(catalog.config.policyKey, owner);
    }
    for (const store of this.deps.state.stores()) {
      authorsToOwner.set(store.owner, store.owner);
    }
    void this.relay().then(
      (relay) => {
        const subscription = relay.subscribe([{ authors: [...authorsToOwner.keys()], limit: 0 }], {
          onevent: (event) => {
            const owner = authorsToOwner.get(event.pubkey);
            const store = owner === undefined ? undefined : this.deps.state.store(owner);
            if (store) {
              void this.loadStore(store);
            }
          },
          onclose: () => {
            if (!this.stopped) {
              setTimeout(() => {
                void this.loadCatalogs().then(() => this.openCatalogLive());
              }, this.backoff.next());
            }
          },
        });
        this.closeCatalog = () => subscription.close();
      },
      () => {
        setTimeout(() => this.openCatalogLive(), this.backoff.next());
      },
    );
  }

  private alreadyHave(id: string): boolean {
    const expiresAt = this.verifiedIds.get(id);
    return expiresAt !== undefined && expiresAt > this.now();
  }

  /** The batched wrap REQ for every leased A, from `since` = now - 10 min (2.4). */
  private openWraps(): void {
    if (this.stopped) {
      return;
    }
    const assistants = this.leasedAssistants();
    if (assistants.length === 0) {
      return;
    }
    const opened = Date.now();
    void this.relay().then(
      (relay) => {
        const read = readHistory(
          relay,
          [{ kinds: [KIND_GIFT_WRAP], '#p': assistants, since: this.now() - WRAP_SINCE_SECS }],
          (event) => this.onWrap(event),
          {
            alreadyHaveEvent: (id) => this.alreadyHave(id),
            onClose: () => this.reopenWraps(opened),
          },
        );
        this.closeWraps = read.close;
        void read.done.then((real) => {
          if (!real) {
            read.close();
          }
        });
      },
      () => this.reopenWraps(opened),
    );
  }

  private reopenWraps(opened: number): void {
    if (this.stopped) {
      return;
    }
    if (Date.now() - opened >= STABLE_CONNECTION_MS) {
      this.backoff.reset();
    }
    setTimeout(() => this.openWraps(), this.backoff.next());
  }

  private onWrap(wrap: NostrEvent): void {
    const now = this.now();
    for (const [id, expiresAt] of this.verifiedIds) {
      if (expiresAt <= now) {
        this.verifiedIds.delete(id);
      }
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
      existing.deadline > Date.now();
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
    const deadline = Date.now() + TURN_DEADLINE_MS;
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
          this.deps.maxTurnUsd,
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

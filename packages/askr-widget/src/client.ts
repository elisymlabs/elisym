import {
  type CatalogItem,
  ASKR_RELAYS,
  KIND_SESSION_TICKET,
  LIMITS,
  MAX_RUMOR_AGE_SECS,
  SESSION_END_MARGIN_SECS,
  SESSION_TTL_SECS,
  type StoreConfig,
  clockOffsetFromTicket,
} from '@elisym/askr';
import {
  type Answer,
  type Ask,
  type UnavailableReason,
  type UnwrappedChat,
  isAssistantMessage,
  newAskId,
  unwrapChatMessage,
} from '@elisym/askr/chat';
import { isGenuineEvent, tagsNamed } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';
import { Backoff } from './backoff';
import { CardCache, resolveCards } from './cards';
import {
  ANSWER_TIMEOUT_MS,
  BACKOFF_RESET_AFTER_EOSE_MS,
  CONNECTION_WAIT_MS,
  KIND_GIFT_WRAP,
  MAX_QUERY_ATTEMPTS,
} from './constants';
import type { Gateway } from './gateway';
import {
  type HistoryRead,
  type RelayConnect,
  type RelayConnection,
  openHistoryRead,
  queryHistory,
} from './relay';
import type { KeyValueStorage } from './storage';
import { type StoreData, loadStoreData } from './store-data';
import { type VisitorKey, loadVisitorKey } from './visitor-key';
import { type OutgoingWrap, wrapOutgoing } from './wrap-outgoing';

/**
 * `loading`: config, ticket and the first history read are on their way.
 * `ready`: the visitor may ask. `waiting`: one ask is in flight (input off).
 * `retry`: the in-flight ask got no reply in time, or failed: retry offered.
 * `unavailable`: refused live or by the gateway: the store's contact shows.
 * `failed`: the store has no readable config: no assistant here.
 */
export type ChatPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'waiting'
  | 'retry'
  | 'unavailable'
  | 'failed';

export type RetryReason = 'timeout' | 'error';

export interface ChatTurn {
  askId: string;
  text: string;
  /** The ask rumor's `created_at`. */
  askedAt: number;
  answer?: Answer;
  /** The newest progress line, until the answer arrives. */
  status?: string;
}

export interface ChatSnapshot {
  phase: ChatPhase;
  retryReason?: RetryReason;
  config?: StoreConfig;
  /** Whether to show the "by Askr" line; the gateway's latest grant decides. */
  branding: boolean;
  turns: readonly ChatTurn[];
  inFlightAskId?: string;
}

export interface ChatClientOptions {
  /** The store owner O, hex. */
  owner: string;
  connect: RelayConnect;
  gateway: Gateway;
  /** localStorage for V, or none when the browser refuses it. */
  localStorage?: KeyValueStorage | undefined;
  /** sessionStorage for the card cache. */
  sessionStorage?: KeyValueStorage | undefined;
  /** The page URL sent with each ask (the agent matches it against `r`). */
  pageUrl?: () => string | undefined;
  /** `navigator.language`. */
  locale?: () => string | undefined;
  /** Jitter source for the backoff. */
  random?: () => number;
}

interface InFlight {
  askId: string;
  text: string;
  /** Wraps of this ask still waiting for an OK; republished on every new connection. */
  pending: Set<NostrEvent>;
  publishing: Set<NostrEvent>;
  /** The one immediate reconnect for a publish without OK has been used. */
  immediateReconnectUsed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The answer timer ran out: offer retry once the reconnect's replay is in. */
  retryAfterReplay: boolean;
}

const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const ENCODER = new TextEncoder();

function localSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function singleTag(event: NostrEvent, name: string): string | undefined {
  const matches = tagsNamed(event.tags, name);
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

/**
 * The page as origin and path only: the agent matches nothing else, and a
 * query or fragment can carry tokens, emails or order ids.
 */
function validPageUrl(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  let page: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined;
    }
    page = `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
  return ENCODER.encode(page).length > LIMITS.PAGE_URL_BYTES ? undefined : page;
}

function validLocale(locale: string | undefined): string | undefined {
  return locale !== undefined && locale.length <= LIMITS.LOCALE_CHARS && LOCALE_RE.test(locale)
    ? locale
    : undefined;
}

/**
 * The widget's chat client (4.1-4.4), with no DOM: the relay and the gateway
 * are injected. One relay connection carries the `#p` = V subscription, the
 * config read and card fetches; publishes go to the same relay.
 */
export class ChatClient {
  readonly visitor: VisitorKey;
  private readonly owner: string;
  private readonly relayUrl: string;
  private readonly relayConnect: RelayConnect;
  private readonly gateway: Gateway;
  private readonly cardCache: CardCache;
  private readonly pageUrl: () => string | undefined;
  private readonly locale: () => string | undefined;
  private readonly backoff: Backoff;

  private phase: ChatPhase = 'idle';
  private retryReason: RetryReason | undefined;
  private stopped = false;

  private connection: RelayConnection | undefined;
  private connecting = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private connectionWaiters: ((connection: RelayConnection | undefined) => void)[] = [];

  private store: StoreData | undefined;
  /** The assistant key the accept rule and every ask use: the config's, after the A check. */
  private assistant: string | undefined;
  private ticket: NostrEvent | undefined;
  private clockOffset = 0;
  private branding = true;
  private bootstrapping = false;

  private inbox: HistoryRead | undefined;
  private buffering = false;
  /** Unwrapped before the real EOSE; marked seen only once the replay is processed. */
  private buffer: UnwrappedChat[] = [];
  private firstReplayDone = false;

  private readonly turns = new Map<string, ChatTurn>();
  private readonly seenRumors = new Set<string>();
  /** Per ask: the `created_at` of the newest `unavailable` already seen. */
  private readonly newestRefusalAt = new Map<string, number>();
  /** `expired` is renewed and resent once per `ask_id` per page load (4.1). */
  private readonly expiredResent = new Set<string>();
  private sessionEnd: number | undefined;
  private newestAnswerAt = Number.NEGATIVE_INFINITY;
  private inFlight: InFlight | undefined;

  private readonly listeners = new Set<(snapshot: ChatSnapshot) => void>();

  constructor(options: ChatClientOptions) {
    this.owner = options.owner;
    this.relayUrl = ASKR_RELAYS[0] ?? '';
    this.relayConnect = options.connect;
    this.gateway = options.gateway;
    this.cardCache = new CardCache(options.sessionStorage);
    this.pageUrl = options.pageUrl ?? (() => undefined);
    this.locale = options.locale ?? (() => undefined);
    this.backoff = new Backoff(options.random);
    this.visitor = loadVisitorKey(options.owner, options.localStorage);
  }

  /** Gateway-corrected unix seconds: every timestamp the widget writes (4.1). */
  now(): number {
    return localSecs() + this.clockOffset;
  }

  subscribe(listener: (snapshot: ChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): ChatSnapshot {
    const snapshot: ChatSnapshot = {
      phase: this.phase,
      branding: this.branding,
      turns: [...this.turns.values()].sort((left, right) => left.askedAt - right.askedAt),
    };
    if (this.retryReason !== undefined && this.phase === 'retry') {
      snapshot.retryReason = this.retryReason;
    }
    if (this.store) {
      snapshot.config = this.store.config;
    }
    if (this.inFlight) {
      snapshot.inFlightAskId = this.inFlight.askId;
    }
    return snapshot;
  }

  start(): void {
    if (this.phase !== 'idle') {
      return;
    }
    this.setPhase('loading');
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.stableTimer);
    this.clearAnswerTimer();
    this.inbox?.close();
    this.inbox = undefined;
    const connection = this.connection;
    this.connection = undefined;
    if (connection) {
      connection.onclose = undefined;
      connection.close();
    }
    for (const waiter of this.connectionWaiters.splice(0)) {
      waiter(undefined);
    }
    this.listeners.clear();
  }

  /** Send a question. Only in `ready`: one ask in flight at a time (4.1). */
  ask(text: string): boolean {
    const trimmed = text.trim();
    if (this.phase !== 'ready' || trimmed.length === 0 || trimmed.length > LIMITS.ASK_TEXT_CHARS) {
      return false;
    }
    const askId = newAskId();
    this.inFlight = {
      askId,
      text: trimmed,
      pending: new Set(),
      publishing: new Set(),
      immediateReconnectUsed: false,
      timer: undefined,
      retryAfterReplay: false,
    };
    this.setPhase('waiting');
    void this.sendInFlight(true);
    return true;
  }

  /**
   * Retry the in-flight ask after a timeout or an `error`: renew the ticket
   * first (the gateway refuses a store that left `active` and names the
   * current A), then send a new rumor with the same `ask_id` and no self-copy.
   */
  retry(): void {
    if (this.phase !== 'retry' || !this.inFlight) {
      return;
    }
    this.setPhase('waiting');
    void this.renewAndResend('error');
  }

  /** Resolve an answer's addresses into cards (4.3). */
  resolveCards(addresses: readonly string[]): Promise<Map<string, CatalogItem>> {
    const store = this.store;
    if (!store) {
      return Promise.resolve(new Map());
    }
    return resolveCards(addresses, {
      config: store.config,
      authorityEvents: store.authorityEvents,
      query: (relays, filters) => this.query(relays, filters),
      cache: this.cardCache,
      now: this.now(),
    });
  }

  /** Report a handoff (a card opened, an add-to-cart): advisory, never awaited by the UI. */
  reportClick(address: string): void {
    if (this.ticket) {
      void this.gateway.reportClick(this.ticket, address);
    }
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private setPhase(phase: ChatPhase, retryReason?: RetryReason): void {
    this.phase = phase;
    this.retryReason = retryReason;
    this.emit();
  }

  // Connection lifecycle

  private async connect(): Promise<void> {
    if (this.connecting || this.stopped || this.connection) {
      return;
    }
    this.connecting = true;
    let connection: RelayConnection;
    try {
      connection = await this.relayConnect(this.relayUrl);
    } catch {
      this.connecting = false;
      this.onAttemptFailed();
      return;
    }
    this.connecting = false;
    if (this.stopped) {
      connection.close();
      return;
    }
    this.connection = connection;
    connection.onclose = () => this.onConnectionClosed(connection);
    for (const waiter of this.connectionWaiters.splice(0)) {
      waiter(connection);
    }
    this.publishPending();
    this.recover();
  }

  private onConnectionClosed(connection: RelayConnection): void {
    if (connection !== this.connection) {
      return;
    }
    this.connection = undefined;
    this.inbox = undefined;
    clearTimeout(this.stableTimer);
    this.scheduleRecovery();
  }

  /** Drop the current connection without waiting: the two immediate reconnects of 4.1. */
  private reconnectNow(): void {
    const connection = this.connection;
    this.connection = undefined;
    this.inbox?.close();
    this.inbox = undefined;
    clearTimeout(this.stableTimer);
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    if (connection) {
      connection.onclose = undefined;
      connection.close();
    }
    void this.connect();
  }

  /** A socket close or a failed step always waits the jittered backoff (2.4). */
  private scheduleRecovery(): void {
    if (this.stopped || this.recoveryTimer !== undefined) {
      return;
    }
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.recover();
    }, this.backoff.next());
  }

  private onAttemptFailed(): void {
    // A timeout's reconnect that cannot connect still ends in the retry offer.
    if (this.inFlight?.retryAfterReplay) {
      this.offerRetry('timeout');
    }
    this.scheduleRecovery();
  }

  /** The next missing step: connection, config and ticket, then the `#p` = V subscription. */
  private recover(): void {
    if (this.stopped) {
      return;
    }
    const connection = this.connection;
    if (!connection) {
      void this.connect();
      return;
    }
    if (!this.store || !this.ticket) {
      void this.bootstrap();
      return;
    }
    if (!this.inbox) {
      this.openInbox(connection);
    }
  }

  private whenConnected(): Promise<RelayConnection | undefined> {
    if (this.connection) {
      return Promise.resolve(this.connection);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.connectionWaiters = this.connectionWaiters.filter((waiter) => waiter !== settle);
        resolve(undefined);
      }, CONNECTION_WAIT_MS);
      const settle = (connection: RelayConnection | undefined): void => {
        clearTimeout(timer);
        resolve(connection);
      };
      this.connectionWaiters.push(settle);
    });
  }

  /**
   * A history read on the main relay, re-run when a reconnect cut it (4.1:
   * card fetches cut by the timeout's close are re-run), plus, for a Pay Core
   * source, the default relays (best effort: a failure there is ignored).
   */
  private async query(relays: readonly string[], filters: Filter[]): Promise<NostrEvent[]> {
    const others = relays.filter((relay) => relay !== this.relayUrl);
    const extra = Promise.all(others.map((relay) => this.queryOther(relay, filters)));
    const main = relays.includes(this.relayUrl) ? await this.queryMain(filters) : [];
    return [...main, ...(await extra).flat()];
  }

  private async queryMain(filters: Filter[]): Promise<NostrEvent[]> {
    for (let attempt = 0; attempt < MAX_QUERY_ATTEMPTS; attempt += 1) {
      const connection = await this.whenConnected();
      if (!connection) {
        break;
      }
      try {
        return await queryHistory(connection, filters);
      } catch {
        // No EOSE on a live connection waits the backoff; a read cut by a reconnect re-runs at once.
        if (connection === this.connection) {
          await new Promise((resolve) => setTimeout(resolve, this.backoff.next()));
        }
      }
    }
    throw new Error('The Askr relay could not be read');
  }

  private async queryOther(relay: string, filters: Filter[]): Promise<NostrEvent[]> {
    let connection: RelayConnection | undefined;
    try {
      connection = await this.relayConnect(relay);
      return await queryHistory(connection, filters);
    } catch {
      return [];
    } finally {
      connection?.close();
    }
  }

  // Config, ticket and the A check

  private async bootstrap(): Promise<void> {
    if (this.bootstrapping) {
      return;
    }
    this.bootstrapping = true;
    try {
      if (!this.store) {
        let store: StoreData | undefined;
        try {
          store = await loadStoreData(
            this.owner,
            (relays, filters) => this.query(relays, filters),
            this.now(),
          );
        } catch {
          this.scheduleRecovery();
          return;
        }
        if (!store) {
          this.setPhase('failed');
          this.stop();
          return;
        }
        this.store = store;
        this.assistant = store.config.assistant;
      }
      if (!this.ticket) {
        const outcome = await this.renewTicket();
        if (outcome === 'error') {
          this.scheduleRecovery();
        }
        if (outcome !== 'ok') {
          return;
        }
      }
    } finally {
      this.bootstrapping = false;
    }
    this.recover();
  }

  /**
   * Get a ticket from the gateway (3) and set the clock offset from it. A
   * ticket naming another A than the cached config makes the widget re-read
   * the config once: a match adopts the new A for sending and the accept
   * rule; otherwise the unavailable state (4.1).
   */
  private async renewTicket(): Promise<'ok' | 'unavailable' | 'error'> {
    const result = await this.gateway.openSession(this.owner, this.visitor.pubkey);
    if (this.stopped) {
      return 'error';
    }
    if (result.kind === 'unavailable') {
      this.becomeUnavailable();
      return 'unavailable';
    }
    if (result.kind === 'error') {
      return 'error';
    }
    const { ticket, assistant, branding } = result.grant;
    if (
      ticket.kind !== KIND_SESSION_TICKET ||
      singleTag(ticket, 'p') !== this.visitor.pubkey ||
      singleTag(ticket, 'store') !== this.owner ||
      !isGenuineEvent(ticket)
    ) {
      return 'error';
    }
    this.clockOffset = clockOffsetFromTicket(ticket, localSecs());
    this.ticket = ticket;
    this.branding = branding;
    if (assistant !== this.assistant) {
      let reread: StoreData | undefined;
      try {
        reread = await loadStoreData(
          this.owner,
          (relays, filters) => this.query(relays, filters),
          this.now(),
        );
      } catch {
        return 'error';
      }
      if (!reread || reread.config.assistant !== assistant) {
        this.becomeUnavailable();
        return 'unavailable';
      }
      this.store = reread;
      this.assistant = assistant;
      this.emit();
    }
    return 'ok';
  }

  private ticketExpired(): boolean {
    const expiration = this.ticket ? singleTag(this.ticket, 'expiration') : undefined;
    return expiration === undefined || Number(expiration) <= this.now();
  }

  private becomeUnavailable(): void {
    this.clearAnswerTimer();
    this.inFlight = undefined;
    this.setPhase('unavailable');
  }

  // The `#p` = V subscription

  /**
   * Every (re)subscription is a history fetch (4.1): no `since` (2.4), wraps
   * buffered until a real EOSE, matched, then acted on. A REQ with no EOSE in
   * time is closed and reopened after the backoff, with no reset.
   */
  private openInbox(connection: RelayConnection): void {
    this.buffering = true;
    this.buffer = [];
    const filters: Filter[] = [{ kinds: [KIND_GIFT_WRAP], '#p': [this.visitor.pubkey] }];
    const read: HistoryRead = openHistoryRead(connection, filters, {
      onevent: (event) => this.onWrap(event),
      onEose: () => {
        if (this.inbox !== read) {
          return;
        }
        this.buffering = false;
        const replay = this.buffer;
        this.buffer = [];
        this.processReplay(replay);
        clearTimeout(this.stableTimer);
        this.stableTimer = setTimeout(() => this.backoff.reset(), BACKOFF_RESET_AFTER_EOSE_MS);
      },
      onFail: () => {
        if (this.inbox !== read) {
          return;
        }
        this.inbox = undefined;
        this.onAttemptFailed();
      },
      onClosedAfterEose: () => {
        if (this.inbox !== read) {
          return;
        }
        this.inbox = undefined;
        clearTimeout(this.stableTimer);
        this.scheduleRecovery();
      },
    });
    this.inbox = read;
  }

  /**
   * The accept rule (4.3): assistant messages only from a seal by the
   * config's A, ask self-copies only from a seal by V; then dedup by rumor id.
   * A buffered rumor is not marked seen yet: a read that fails before its real
   * EOSE drops the buffer, and the next replay must still deliver it.
   */
  private onWrap(wrap: NostrEvent): void {
    const unwrapped = unwrapChatMessage(wrap, this.visitor.secretKey);
    if (!unwrapped) {
      return;
    }
    const expectedSender = isAssistantMessage(unwrapped.message)
      ? this.assistant
      : this.visitor.pubkey;
    if (unwrapped.senderPubkey !== expectedSender) {
      return;
    }
    if (unwrapped.expiresAt === undefined || unwrapped.expiresAt <= this.now()) {
      return;
    }
    if (this.seenRumors.has(unwrapped.rumorId)) {
      return;
    }
    if (this.buffering) {
      // Replay handling is idempotent: a rumor buffered twice changes nothing.
      this.buffer.push(unwrapped);
      return;
    }
    this.seenRumors.add(unwrapped.rumorId);
    this.handleLive(unwrapped);
  }

  private addTurn(askId: string, text: string, askedAt: number): void {
    if (!this.turns.has(askId)) {
      this.turns.set(askId, { askId, text, askedAt });
    }
  }

  private noteSessionEnd(answer: Answer, answeredAt: number): void {
    if (answeredAt >= this.newestAnswerAt) {
      this.newestAnswerAt = answeredAt;
      this.sessionEnd = answer.session_end;
    }
  }

  /** At most one answer per `ask_id`; none for an ask this tab does not know. */
  private takeAnswer(answer: Answer, answeredAt: number): boolean {
    const turn = this.turns.get(answer.ask_id);
    if (!turn || turn.answer) {
      return false;
    }
    turn.answer = answer;
    delete turn.status;
    this.noteSessionEnd(answer, answeredAt);
    return true;
  }

  private handleLive(unwrapped: UnwrappedChat): void {
    const message = unwrapped.message;
    if (message.type === 'ask') {
      // A self-copy: this tab's own echo, or another tab of the same browser.
      this.addTurn(message.ask_id, message.text, unwrapped.createdAt);
      this.emit();
      return;
    }
    const inFlight = this.inFlight;
    if (message.type === 'answer') {
      if (this.takeAnswer(message, unwrapped.createdAt) && inFlight?.askId === message.ask_id) {
        this.finishInFlight();
      }
      this.emit();
      return;
    }
    if (message.type === 'status') {
      const turn = this.turns.get(message.ask_id);
      if (!turn || turn.answer) {
        return;
      }
      turn.status = message.text;
      if (inFlight?.askId === message.ask_id && this.phase === 'waiting') {
        this.startAnswerTimer();
      }
      this.emit();
      return;
    }
    if (inFlight?.askId !== message.ask_id || this.phase !== 'waiting') {
      return;
    }
    this.newestRefusalAt.set(message.ask_id, unwrapped.createdAt);
    this.actOnRefusal(message.reason, true);
  }

  /** The history replay of one (re)subscription, after its real EOSE (4.1). */
  private processReplay(replay: UnwrappedChat[]): void {
    const now = this.now();
    // Only now is a buffered rumor acted on, so only now is it seen (`onWrap`).
    for (const entry of replay) {
      this.seenRumors.add(entry.rumorId);
    }
    // Wraps of a session ending within the margin belong to that session, not the next (4.4).
    const current = replay
      .filter(
        (entry) =>
          entry.message.type === 'status' ||
          (entry.expiresAt !== undefined && entry.expiresAt - now >= SESSION_END_MARGIN_SECS),
      )
      .sort((left, right) => left.createdAt - right.createdAt);
    for (const entry of current) {
      if (entry.message.type === 'ask') {
        this.addTurn(entry.message.ask_id, entry.message.text, entry.createdAt);
        // Before any answer, the session end is the newest self-copy's expiration (4.4).
        if (this.newestAnswerAt === Number.NEGATIVE_INFINITY && entry.expiresAt !== undefined) {
          this.sessionEnd = Math.max(this.sessionEnd ?? 0, entry.expiresAt);
        }
      }
    }
    for (const entry of current) {
      if (entry.message.type === 'answer') {
        this.takeAnswer(entry.message, entry.createdAt);
      }
    }
    const isFreshLoad = !this.firstReplayDone;
    this.firstReplayDone = true;
    let target = this.inFlight;
    if (!target && isFreshLoad) {
      target = this.adoptNewestUnanswered(now);
    }
    if (target) {
      this.replayForTarget(target, current);
    }
    if (this.phase === 'loading') {
      this.setPhase(this.inFlight ? 'waiting' : 'ready');
    }
    const inFlight = this.inFlight;
    if (inFlight?.retryAfterReplay && this.phase === 'waiting') {
      this.offerRetry('timeout');
    }
    this.emit();
  }

  /**
   * On a fresh load with nothing in flight, the newest ask without an answer
   * becomes this tab's in-flight ask. One older than the answer timeout is
   * offered for retry at once (the assistant drops rumors past 5 minutes).
   */
  private adoptNewestUnanswered(now: number): InFlight | undefined {
    const turns = [...this.turns.values()].sort((left, right) => right.askedAt - left.askedAt);
    const newest = turns[0];
    if (!newest || newest.answer) {
      return undefined;
    }
    this.inFlight = {
      askId: newest.askId,
      text: newest.text,
      pending: new Set(),
      publishing: new Set(),
      immediateReconnectUsed: false,
      timer: undefined,
      retryAfterReplay: false,
    };
    const ageMs = (now - newest.askedAt) * 1000;
    if (ageMs >= ANSWER_TIMEOUT_MS || now - newest.askedAt > MAX_RUMOR_AGE_SECS) {
      this.phase = 'waiting';
      this.offerRetry('timeout');
    } else {
      this.phase = 'waiting';
      this.startAnswerTimer(ANSWER_TIMEOUT_MS - ageMs);
    }
    return this.inFlight;
  }

  private replayForTarget(target: InFlight, replay: UnwrappedChat[]): void {
    const turn = this.turns.get(target.askId);
    if (turn?.answer) {
      this.finishInFlight();
      return;
    }
    let newestStatus: UnwrappedChat | undefined;
    let newestRefusal: { reason: UnavailableReason; at: number } | undefined;
    for (const entry of replay) {
      const message = entry.message;
      if (message.ask_id !== target.askId) {
        continue;
      }
      if (message.type === 'status') {
        newestStatus = entry;
      } else if (message.type === 'unavailable') {
        if (!newestRefusal || entry.createdAt >= newestRefusal.at) {
          newestRefusal = { reason: message.reason, at: entry.createdAt };
        }
      }
    }
    if (newestStatus && newestStatus.message.type === 'status' && turn) {
      turn.status = newestStatus.message.text;
      if (this.phase === 'waiting') {
        this.startAnswerTimer();
      }
    }
    if (!newestRefusal) {
      return;
    }
    const seenAt = this.newestRefusalAt.get(target.askId) ?? Number.NEGATIVE_INFINITY;
    if (newestRefusal.at < seenAt) {
      return;
    }
    this.newestRefusalAt.set(target.askId, newestRefusal.at);
    // A replayed quota or budget is history only: its cause may have cleared (4.1).
    if (newestRefusal.reason === 'expired' || newestRefusal.reason === 'error') {
      this.actOnRefusal(newestRefusal.reason, false);
    }
  }

  /**
   * `expired`: renew and resend once per `ask_id`; `error`: offer retry;
   * `quota`/`budget`: the unavailable state, from a live refusal only (4.2).
   */
  private actOnRefusal(reason: UnavailableReason, live: boolean): void {
    const inFlight = this.inFlight;
    if (!inFlight) {
      return;
    }
    if (reason === 'expired') {
      if (this.expiredResent.has(inFlight.askId)) {
        this.offerRetry('error');
        return;
      }
      this.expiredResent.add(inFlight.askId);
      this.clearAnswerTimer();
      void this.renewAndResend('error');
      return;
    }
    if (reason === 'error') {
      this.offerRetry('error');
      return;
    }
    if (live) {
      this.becomeUnavailable();
    }
  }

  // Sending

  private currentSessionEnd(now: number): number {
    if (this.sessionEnd === undefined || this.sessionEnd - now < SESSION_END_MARGIN_SECS) {
      this.sessionEnd = now + SESSION_TTL_SECS;
    }
    return this.sessionEnd;
  }

  private async renewAndResend(onGatewayError: RetryReason): Promise<void> {
    const outcome = await this.renewTicket();
    if (outcome === 'error') {
      this.offerRetry(onGatewayError);
      return;
    }
    if (outcome === 'ok') {
      await this.sendInFlight(false);
    }
  }

  /**
   * Send the in-flight ask: a wrap to A and, for a first send, a self-copy to
   * V with the same expiration (4.3). A resend (timeout retry, `expired`,
   * retry after `error`) is a new rumor with the same `ask_id`, no self-copy.
   */
  private async sendInFlight(withSelfCopy: boolean): Promise<void> {
    const inFlight = this.inFlight;
    if (!inFlight || this.stopped) {
      return;
    }
    if (!this.ticket || this.ticketExpired()) {
      const outcome = await this.renewTicket();
      if (outcome === 'error') {
        this.offerRetry('error');
      }
      if (outcome !== 'ok') {
        return;
      }
    }
    const ticket = this.ticket;
    const assistant = this.assistant;
    if (!ticket || !assistant || this.inFlight !== inFlight) {
      return;
    }
    const now = this.now();
    const expiresAt = this.currentSessionEnd(now);
    const ask: Ask = { type: 'ask', ask_id: inFlight.askId, text: inFlight.text, ticket };
    const page = validPageUrl(this.pageUrl());
    if (page !== undefined) {
      ask.page = { url: page };
    }
    const locale = validLocale(this.locale());
    if (locale !== undefined) {
      ask.locale = locale;
    }
    let wraps: OutgoingWrap[];
    try {
      wraps = [
        wrapOutgoing({
          message: ask,
          senderSecretKey: this.visitor.secretKey,
          recipientPubkey: assistant,
          expiresAt,
          now,
          toAssistant: true,
        }),
      ];
      if (withSelfCopy) {
        wraps.push(
          wrapOutgoing({
            message: ask,
            senderSecretKey: this.visitor.secretKey,
            recipientPubkey: this.visitor.pubkey,
            expiresAt,
            now,
            toAssistant: false,
          }),
        );
      }
    } catch {
      this.offerRetry('error');
      return;
    }
    for (const wrap of wraps) {
      this.seenRumors.add(wrap.rumorId);
    }
    this.addTurn(inFlight.askId, inFlight.text, now);
    inFlight.pending = new Set(wraps.map((wrap) => wrap.wrap));
    inFlight.immediateReconnectUsed = false;
    inFlight.retryAfterReplay = false;
    this.startAnswerTimer();
    this.emit();
    this.publishPending();
  }

  private publishPending(): void {
    const inFlight = this.inFlight;
    const connection = this.connection;
    if (!inFlight || !connection) {
      return;
    }
    for (const wrap of inFlight.pending) {
      if (inFlight.publishing.has(wrap)) {
        continue;
      }
      inFlight.publishing.add(wrap);
      connection.publish(wrap).then(
        () => {
          inFlight.publishing.delete(wrap);
          inFlight.pending.delete(wrap);
        },
        () => {
          inFlight.publishing.delete(wrap);
          this.onPublishFailed(inFlight, connection);
        },
      );
    }
  }

  /**
   * A publish with no OK: reconnect at once and republish the same wrap (same
   * event id, deduplicated by the relay and by rumor id), keeping the 60 s
   * timer (4.1). One immediate reconnect per send; after it, the backoff.
   */
  private onPublishFailed(inFlight: InFlight, connection: RelayConnection): void {
    if (this.inFlight !== inFlight || inFlight.pending.size === 0 || this.stopped) {
      return;
    }
    if (connection !== this.connection) {
      this.publishPending();
      return;
    }
    if (!inFlight.immediateReconnectUsed) {
      inFlight.immediateReconnectUsed = true;
      this.reconnectNow();
      return;
    }
    this.connection = undefined;
    this.inbox?.close();
    this.inbox = undefined;
    connection.onclose = undefined;
    connection.close();
    this.scheduleRecovery();
  }

  // The answer timer

  private startAnswerTimer(delayMs: number = ANSWER_TIMEOUT_MS): void {
    const inFlight = this.inFlight;
    if (!inFlight) {
      return;
    }
    clearTimeout(inFlight.timer);
    inFlight.timer = setTimeout(() => this.onAnswerTimeout(inFlight), Math.max(0, delayMs));
  }

  private clearAnswerTimer(): void {
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer);
      this.inFlight.timer = undefined;
    }
  }

  /**
   * No answer in time: close and reopen the connection and subscription at
   * once, so the replay brings back an answer a half-open socket missed, then
   * offer retry (4.1).
   */
  private onAnswerTimeout(inFlight: InFlight): void {
    if (this.inFlight !== inFlight || this.phase !== 'waiting') {
      return;
    }
    inFlight.timer = undefined;
    inFlight.retryAfterReplay = true;
    inFlight.pending.clear();
    this.reconnectNow();
  }

  private offerRetry(reason: RetryReason): void {
    const inFlight = this.inFlight;
    if (!inFlight) {
      return;
    }
    clearTimeout(inFlight.timer);
    inFlight.timer = undefined;
    inFlight.retryAfterReplay = false;
    inFlight.pending.clear();
    this.setPhase('retry', reason);
  }

  private finishInFlight(): void {
    this.clearAnswerTimer();
    this.inFlight = undefined;
    if (this.phase === 'waiting' || this.phase === 'retry' || this.phase === 'loading') {
      this.phase = 'ready';
      this.retryReason = undefined;
    }
  }
}

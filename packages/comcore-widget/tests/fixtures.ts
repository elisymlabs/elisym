import {
  type CatalogItemInput,
  type StoreConfigInput,
  buildCatalogAuth,
  buildCatalogItemEvent,
  buildConfigEvent,
  buildTicket,
} from '@elisym/comcore';
import {
  type ChatMessage,
  type UnwrappedChat,
  unwrapChatMessage,
  wrapChatMessage,
} from '@elisym/comcore/chat';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { type Filter, matchFilter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Gateway, SessionResult } from '../src/gateway';
import type { RelayConnection, RelaySubscriptionHandlers } from '../src/relay';
import type { KeyValueStorage } from '../src/storage';

export interface TestKey {
  secretKey: Uint8Array;
  pubkey: string;
}

export function testKey(): TestKey {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

export function sign(template: EventTemplate, key: TestKey): NostrEvent {
  return finalizeEvent(template, key.secretKey);
}

export function localSecs(): number {
  return Math.floor(Date.now() / 1000);
}

export class MemoryStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

export class ThrowingStorage implements KeyValueStorage {
  getItem(): string | null {
    throw new Error('blocked');
  }
  setItem(): void {
    throw new Error('blocked');
  }
  removeItem(): void {
    throw new Error('blocked');
  }
}

interface OpenSub {
  connection: FakeConnection;
  filters: Filter[];
  handlers: RelaySubscriptionHandlers;
  closed: boolean;
}

class FakeConnection implements RelayConnection {
  onclose: (() => void) | undefined;
  closed = false;

  constructor(
    readonly url: string,
    private readonly relay: FakeRelay,
  ) {}

  subscribe(filters: Filter[], handlers: RelaySubscriptionHandlers) {
    const sub: OpenSub = { connection: this, filters, handlers, closed: false };
    this.relay.subs.push(sub);
    this.relay.requests.push({ url: this.url, filters });
    const stored = this.relay.stored(this.url, filters);
    const holdEose = this.relay.holdEose;
    void Promise.resolve().then(() => {
      if (sub.closed) {
        return;
      }
      for (const event of stored) {
        handlers.onevent(event);
      }
      if (!holdEose) {
        handlers.oneose();
      }
    });
    return {
      close: () => {
        if (!sub.closed) {
          sub.closed = true;
          handlers.onclose('closed by caller');
        }
      },
    };
  }

  publish(event: NostrEvent): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('closed'));
    }
    this.relay.publishAttempts.push(event);
    if (this.relay.failPublishes > 0) {
      this.relay.failPublishes -= 1;
      return Promise.reject(new Error('no OK'));
    }
    this.relay.accept(this.url, event);
    return Promise.resolve();
  }

  close(): void {
    this.drop();
  }

  /** The socket closed: every subscription ends, then the connection's own close. */
  drop(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const sub of this.relay.subs) {
      if (sub.connection === this && !sub.closed) {
        sub.closed = true;
        sub.handlers.onclose('connection closed');
      }
    }
    this.onclose?.();
  }
}

/** An in-memory relay set: events per relay URL, live delivery to open subscriptions. */
export class FakeRelay {
  readonly events = new Map<string, NostrEvent[]>();
  readonly subs: OpenSub[] = [];
  readonly requests: { url: string; filters: Filter[] }[] = [];
  readonly connections: FakeConnection[] = [];
  readonly publishAttempts: NostrEvent[] = [];
  failPublishes = 0;
  failConnects = 0;
  holdEose = false;

  connect = async (url: string): Promise<RelayConnection> => {
    if (this.failConnects > 0) {
      this.failConnects -= 1;
      throw new Error('connect failed');
    }
    const connection = new FakeConnection(url, this);
    this.connections.push(connection);
    return connection;
  };

  stored(url: string, filters: Filter[]): NostrEvent[] {
    return (this.events.get(url) ?? []).filter((event) =>
      filters.some((filter) => matchFilter(filter, event)),
    );
  }

  /** Store an event on a relay and deliver it live to matching open subscriptions there. */
  accept(url: string, event: NostrEvent): void {
    const list = this.events.get(url) ?? [];
    if (!list.some((stored) => stored.id === event.id)) {
      list.push(event);
    }
    this.events.set(url, list);
    for (const sub of this.subs) {
      if (
        !sub.closed &&
        sub.connection.url === url &&
        sub.filters.some((filter) => matchFilter(filter, event))
      ) {
        sub.handlers.onevent(event);
      }
    }
  }

  /** Store without live delivery: what a replay would bring back. */
  storeOnly(url: string, event: NostrEvent): void {
    const list = this.events.get(url) ?? [];
    list.push(event);
    this.events.set(url, list);
  }

  live(): FakeConnection | undefined {
    return [...this.connections].reverse().find((connection) => !connection.closed);
  }

  published(): NostrEvent[] {
    return this.events.get(MAIN_RELAY) ?? [];
  }
}

export const MAIN_RELAY = 'wss://relay.elisym.network';

export class FakeGateway implements Gateway {
  readonly sessions: { store: string; visitor: string }[] = [];
  readonly clicks: { ticket: NostrEvent; address: string }[] = [];
  mode: 'grant' | 'unavailable' | 'error' = 'grant';
  branding = true;
  /** Gateway clock minus local clock. */
  skewSecs = 0;

  constructor(
    public gatewayKey: TestKey,
    public assistant: string,
  ) {}

  async openSession(store: string, visitor: string): Promise<SessionResult> {
    this.sessions.push({ store, visitor });
    if (this.mode !== 'grant') {
      return { kind: this.mode };
    }
    const ticket = sign(
      buildTicket({ visitor, store, now: localSecs() + this.skewSecs }),
      this.gatewayKey,
    );
    return {
      kind: 'granted',
      grant: { ticket, assistant: this.assistant, branding: this.branding },
    };
  }

  async reportClick(ticket: NostrEvent, address: string): Promise<void> {
    this.clicks.push({ ticket, address });
  }
}

export interface TestStore {
  owner: TestKey;
  assistant: TestKey;
  catalogKey: TestKey;
  gatewayKey: TestKey;
  configInput: StoreConfigInput;
}

export function makeStore(overrides: Partial<StoreConfigInput> = {}): TestStore {
  const owner = testKey();
  const assistant = testKey();
  const catalogKey = testKey();
  const gatewayKey = testKey();
  const configInput: StoreConfigInput = {
    assistant: assistant.pubkey,
    origins: ['https://shop.example'],
    name: 'Shop',
    language: 'en',
    currency: 'USD',
    source: { kind: 'catalog' },
    catalogKey: catalogKey.pubkey,
    contact: 'https://shop.example/contact',
    ...overrides,
  };
  return { owner, assistant, catalogKey, gatewayKey, configInput };
}

export function publishStore(
  relay: FakeRelay,
  store: TestStore,
  createdAt = localSecs() - 100,
): void {
  relay.storeOnly(
    MAIN_RELAY,
    sign(buildConfigEvent({ ...store.configInput, createdAt }, store.owner.secretKey), store.owner),
  );
  relay.storeOnly(
    MAIN_RELAY,
    sign(
      buildCatalogAuth({ key: store.catalogKey.pubkey, mode: 'hosted', createdAt }),
      store.owner,
    ),
  );
}

export function publishItem(
  relay: FakeRelay,
  key: TestKey,
  input: CatalogItemInput,
  url: string = MAIN_RELAY,
): NostrEvent {
  const event = sign(buildCatalogItemEvent({ createdAt: localSecs() - 50, ...input }), key);
  relay.storeOnly(url, event);
  return event;
}

/** The assistant's side: open the visitor's wraps to A. */
export function asksTo(relay: FakeRelay, assistant: TestKey): UnwrappedChat[] {
  return relay
    .published()
    .map((wrap) => unwrapChatMessage(wrap, assistant.secretKey))
    .filter((unwrapped): unwrapped is UnwrappedChat => unwrapped !== undefined);
}

export function wrapFrom(
  sender: TestKey,
  recipient: string,
  message: ChatMessage,
  options: { now?: number; expiresAt?: number } = {},
): NostrEvent {
  const now = options.now ?? localSecs();
  return wrapChatMessage({
    message,
    senderSecretKey: sender.secretKey,
    recipientPubkey: recipient,
    expiresAt: options.expiresAt ?? now + 24 * 60 * 60,
    now,
  }).wrap;
}

/** Let promise chains settle without moving fake time. */
export async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.resolve();
  }
}

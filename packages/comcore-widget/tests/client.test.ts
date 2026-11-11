import { buildConfigEvent } from '@elisym/comcore';
import type { Answer, ChatMessage } from '@elisym/comcore/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, type ChatClientOptions } from '../src/client';
import {
  FakeGateway,
  FakeRelay,
  MAIN_RELAY,
  MemoryStorage,
  type TestStore,
  asksTo,
  localSecs,
  makeStore,
  publishStore,
  settle,
  sign,
  testKey,
  wrapFrom,
} from './fixtures';

const DAY = 24 * 60 * 60;

interface Harness {
  store: TestStore;
  relay: FakeRelay;
  gateway: FakeGateway;
  local: MemoryStorage;
  client: ChatClient;
}

function harness(overrides: Partial<ChatClientOptions> = {}, existing?: Partial<Harness>): Harness {
  const store = existing?.store ?? makeStore();
  const relay = existing?.relay ?? new FakeRelay();
  if (!existing?.relay) {
    publishStore(relay, store);
  }
  const gateway = existing?.gateway ?? new FakeGateway(store.gatewayKey, store.assistant.pubkey);
  const local = existing?.local ?? new MemoryStorage();
  const client = new ChatClient({
    owner: store.owner.pubkey,
    connect: relay.connect,
    gateway,
    localStorage: local,
    sessionStorage: new MemoryStorage(),
    pageUrl: () => 'https://shop.example/products/a',
    locale: () => 'en-US',
    random: () => 0.5,
    ...overrides,
  });
  return { store, relay, gateway, local, client };
}

async function started(setup: Harness): Promise<Harness> {
  setup.client.start();
  await settle();
  return setup;
}

function answerFor(askId: string, overrides: Partial<Answer> = {}): Answer {
  return {
    type: 'answer',
    ask_id: askId,
    session_end: localSecs() + DAY,
    text: 'Here you go',
    components: [],
    chips: [],
    ...overrides,
  };
}

function inFlightAskId(client: ChatClient): string {
  const askId = client.snapshot().inFlightAskId;
  if (askId === undefined) {
    throw new Error('nothing in flight');
  }
  return askId;
}

function reply(
  setup: Harness,
  message: ChatMessage,
  options: { now?: number; expiresAt?: number } = {},
): void {
  setup.relay.accept(
    MAIN_RELAY,
    wrapFrom(setup.store.assistant, setup.client.visitor.pubkey, message, options),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bootstrap', () => {
  it('reads the config, gets a ticket, opens the #p = V subscription with no since, and gets ready', async () => {
    const setup = await started(harness());
    expect(setup.client.snapshot().phase).toBe('ready');
    expect(setup.client.snapshot().config?.name).toBe('Shop');
    expect(setup.gateway.sessions).toEqual([
      { store: setup.store.owner.pubkey, visitor: setup.client.visitor.pubkey },
    ]);
    const inbox = setup.relay.requests.find((req) => req.filters[0]?.['#p'] !== undefined);
    expect(inbox?.filters).toEqual([{ kinds: [1059], '#p': [setup.client.visitor.pubkey] }]);
    expect(inbox?.filters[0]?.since).toBeUndefined();
  });

  it('writes with the gateway-corrected clock', async () => {
    const setup = harness();
    setup.gateway.skewSecs = 3_600;
    await started(setup);
    expect(setup.client.now() - localSecs()).toBe(3_600);
  });

  it('shows the unavailable state when the gateway refuses the store', async () => {
    const setup = harness();
    setup.gateway.mode = 'unavailable';
    await started(setup);
    expect(setup.client.snapshot().phase).toBe('unavailable');
  });

  it('fails when the store has no readable config', async () => {
    const setup = harness({}, { relay: new FakeRelay() });
    await started(setup);
    expect(setup.client.snapshot().phase).toBe('failed');
  });

  it('a ticket naming another A than the config re-reads the config once, then is unavailable', async () => {
    const setup = harness();
    setup.gateway.assistant = testKey().pubkey;
    await started(setup);
    expect(setup.client.snapshot().phase).toBe('unavailable');
  });

  it('adopts a rotated A when the re-read config names it', async () => {
    const setup = harness();
    const rotated = testKey();
    setup.gateway.assistant = rotated.pubkey;
    setup.relay.storeOnly(
      MAIN_RELAY,
      sign(
        buildConfigEvent(
          { ...setup.store.configInput, assistant: rotated.pubkey, createdAt: localSecs() - 10 },
          setup.store.owner.secretKey,
        ),
        setup.store.owner,
      ),
    );
    await started(setup);
    expect(setup.client.snapshot().phase).toBe('ready');
    expect(setup.client.snapshot().config?.assistant).toBe(rotated.pubkey);
  });
});

describe('asking', () => {
  it('sends a wrap to A backdated at most 2 minutes plus a self-copy, both expiring at the session end', async () => {
    const setup = await started(harness());
    expect(setup.client.ask('Something warm under $80')).toBe(true);
    await settle();
    expect(setup.client.snapshot().phase).toBe('waiting');
    const now = setup.client.now();
    const toA = setup.relay
      .published()
      .filter((wrap) =>
        wrap.tags.some((tag) => tag[0] === 'p' && tag[1] === setup.store.assistant.pubkey),
      );
    const toV = setup.relay
      .published()
      .filter((wrap) =>
        wrap.tags.some((tag) => tag[0] === 'p' && tag[1] === setup.client.visitor.pubkey),
      );
    expect(toA).toHaveLength(1);
    expect(toV).toHaveLength(1);
    expect(toA[0]?.created_at).toBeGreaterThanOrEqual(now - 120);
    expect(toA[0]?.created_at).toBeLessThanOrEqual(now);
    for (const wrap of [...toA, ...toV]) {
      expect(wrap.tags).toContainEqual(['expiration', String(now + DAY)]);
    }
    const [ask] = asksTo(setup.relay, setup.store.assistant);
    expect(ask?.message).toMatchObject({
      type: 'ask',
      text: 'Something warm under $80',
      page: { url: 'https://shop.example/products/a' },
      locale: 'en-US',
    });
  });

  it('keeps one ask in flight: a second question is refused until the answer', async () => {
    const setup = await started(harness());
    setup.client.ask('first');
    await settle();
    expect(setup.client.ask('second')).toBe(false);
    reply(setup, answerFor(inFlightAskId(setup.client)));
    await settle();
    expect(setup.client.snapshot().phase).toBe('ready');
    expect(setup.client.ask('second')).toBe(true);
  });

  it('renders answers only from a seal by A: a stranger wrapping to V is dropped', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    setup.relay.accept(
      MAIN_RELAY,
      wrapFrom(testKey(), setup.client.visitor.pubkey, answerFor(askId, { text: 'forged' })),
    );
    await settle();
    expect(setup.client.snapshot().phase).toBe('waiting');
    reply(setup, answerFor(askId, { text: 'genuine' }));
    await settle();
    expect(setup.client.snapshot().turns[0]?.answer?.text).toBe('genuine');
  });

  it('renders at most one answer per ask_id and drops replies for an unknown ask_id', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    reply(setup, answerFor(askId, { text: 'one' }));
    reply(setup, answerFor(askId, { text: 'two' }));
    reply(setup, answerFor('f'.repeat(32), { text: 'stray' }));
    await settle();
    const turns = setup.client.snapshot().turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]?.answer?.text).toBe('one');
  });
});

describe('answer timeout', () => {
  it('a new status rumor resets the 60 s timer; then the timeout reconnects and offers retry', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    await vi.advanceTimersByTimeAsync(50_000);
    reply(setup, { type: 'status', ask_id: askId, text: 'Searching the catalog' });
    await settle();
    expect(setup.client.snapshot().turns[0]?.status).toBe('Searching the catalog');
    await vi.advanceTimersByTimeAsync(50_000);
    expect(setup.client.snapshot().phase).toBe('waiting');
    const connectionsBefore = setup.relay.connections.length;
    await vi.advanceTimersByTimeAsync(10_001);
    await settle();
    expect(setup.relay.connections.length).toBe(connectionsBefore + 1);
    expect(setup.client.snapshot().phase).toBe('retry');
    expect(setup.client.snapshot().retryReason).toBe('timeout');
  });

  it('the reconnect replay brings back an answer a half-open socket missed', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    setup.relay.storeOnly(
      MAIN_RELAY,
      wrapFrom(setup.store.assistant, setup.client.visitor.pubkey, answerFor(askId)),
    );
    await vi.advanceTimersByTimeAsync(60_001);
    await settle();
    expect(setup.client.snapshot().phase).toBe('ready');
    expect(setup.client.snapshot().turns[0]?.answer).toBeDefined();
  });

  it('a retry renews the ticket and sends a new rumor with the same ask_id and no self-copy', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    await vi.advanceTimersByTimeAsync(60_001);
    await settle();
    const wrapsBefore = setup.relay.published().length;
    setup.client.retry();
    await settle();
    expect(setup.gateway.sessions).toHaveLength(2);
    const added = setup.relay.published().slice(wrapsBefore);
    expect(added).toHaveLength(1);
    expect(added[0]?.tags).toContainEqual(['p', setup.store.assistant.pubkey]);
    const asks = asksTo(setup.relay, setup.store.assistant);
    expect(asks.map((ask) => ask.message.ask_id)).toEqual([askId, askId]);
    expect(new Set(asks.map((ask) => ask.rumorId)).size).toBe(2);
    expect(setup.client.snapshot().phase).toBe('waiting');
  });
});

describe('publish without OK', () => {
  it('reconnects at once and republishes the same wrap', async () => {
    const setup = await started(harness());
    setup.relay.failPublishes = 1;
    const connectionsBefore = setup.relay.connections.length;
    setup.client.ask('hello');
    await settle(60);
    expect(setup.relay.connections.length).toBe(connectionsBefore + 1);
    const attempts = setup.relay.publishAttempts.map((event) => event.id);
    const firstFailed = attempts[0];
    expect(attempts.filter((id) => id === firstFailed).length).toBe(2);
    expect(setup.relay.published().map((event) => event.id)).toContain(firstFailed);
    expect(setup.client.snapshot().phase).toBe('waiting');
  });
});

describe('branding', () => {
  it('shows "by ComCore" by default and follows the latest grant', async () => {
    const setup = harness();
    expect(setup.client.snapshot().branding).toBe(true);
    setup.gateway.branding = false;
    await started(setup);
    expect(setup.client.snapshot()).toMatchObject({ phase: 'ready', branding: false });
  });
});

describe('unavailable', () => {
  it('expired: renews and sends again once as a new rumor without a self-copy; a second expired offers retry', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    reply(setup, { type: 'unavailable', ask_id: askId, reason: 'expired' });
    await settle(60);
    expect(setup.gateway.sessions).toHaveLength(2);
    expect(asksTo(setup.relay, setup.store.assistant)).toHaveLength(2);
    expect(setup.client.snapshot().phase).toBe('waiting');
    // A later refusal is a new rumor: identical content in the same second would share its id.
    await vi.advanceTimersByTimeAsync(1_000);
    reply(setup, { type: 'unavailable', ask_id: askId, reason: 'expired' });
    await settle(60);
    expect(asksTo(setup.relay, setup.store.assistant)).toHaveLength(2);
    expect(setup.client.snapshot().phase).toBe('retry');
  });

  it('error offers retry', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    reply(setup, { type: 'unavailable', ask_id: inFlightAskId(setup.client), reason: 'error' });
    await settle();
    expect(setup.client.snapshot()).toMatchObject({ phase: 'retry', retryReason: 'error' });
  });

  it('a live quota or budget refusal is the unavailable state', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    reply(setup, { type: 'unavailable', ask_id: inFlightAskId(setup.client), reason: 'budget' });
    await settle();
    expect(setup.client.snapshot().phase).toBe('unavailable');
  });
});

describe('history on reload', () => {
  async function previousVisit(): Promise<{ first: Harness; askId: string }> {
    const first = await started(harness());
    first.client.ask('what is warm?');
    await settle();
    const askId = inFlightAskId(first.client);
    first.client.stop();
    return { first, askId };
  }

  function reload(first: Harness): Harness {
    return harness(
      {},
      { store: first.store, relay: first.relay, gateway: first.gateway, local: first.local },
    );
  }

  it('keeps V per (browser, store) and restores both sides, matching answers buffered until EOSE', async () => {
    const { first, askId } = await previousVisit();
    first.relay.storeOnly(
      MAIN_RELAY,
      wrapFrom(first.store.assistant, first.client.visitor.pubkey, answerFor(askId)),
    );
    const second = await started(reload(first));
    expect(second.client.visitor.pubkey).toBe(first.client.visitor.pubkey);
    const [turn] = second.client.snapshot().turns;
    expect(turn?.text).toBe('what is warm?');
    expect(turn?.answer?.text).toBe('Here you go');
    expect(second.client.snapshot().phase).toBe('ready');
  });

  it('adopts the newest unanswered ask on a fresh load, and acts on a replayed error', async () => {
    const { first, askId } = await previousVisit();
    first.relay.storeOnly(
      MAIN_RELAY,
      wrapFrom(first.store.assistant, first.client.visitor.pubkey, {
        type: 'unavailable',
        ask_id: askId,
        reason: 'error',
      }),
    );
    const second = await started(reload(first));
    expect(second.client.snapshot()).toMatchObject({ phase: 'retry', inFlightAskId: askId });
  });

  it('a replayed quota is history only: it does not end the in-flight ask', async () => {
    const { first, askId } = await previousVisit();
    first.relay.storeOnly(
      MAIN_RELAY,
      wrapFrom(first.store.assistant, first.client.visitor.pubkey, {
        type: 'unavailable',
        ask_id: askId,
        reason: 'quota',
      }),
    );
    const second = await started(reload(first));
    expect(second.client.snapshot()).toMatchObject({ phase: 'waiting', inFlightAskId: askId });
  });

  it('a replayed expired renews and sends again once', async () => {
    const { first, askId } = await previousVisit();
    first.relay.storeOnly(
      MAIN_RELAY,
      wrapFrom(first.store.assistant, first.client.visitor.pubkey, {
        type: 'unavailable',
        ask_id: askId,
        reason: 'expired',
      }),
    );
    await started(reload(first));
    await settle(60);
    const asks = asksTo(first.relay, first.store.assistant).filter(
      (ask) => ask.message.ask_id === askId,
    );
    expect(asks).toHaveLength(2);
  });

  it('a session ending within 5 minutes is no session: its wraps are not restored and the next ask starts a new one', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    const nearEnd = setup.client.now() + 200;
    reply(setup, answerFor(askId, { session_end: nearEnd }), { expiresAt: nearEnd });
    await settle();
    const before = setup.relay.published().length;
    setup.client.ask('again');
    await settle();
    const added = setup.relay.published().slice(before);
    for (const wrap of added) {
      expect(wrap.tags).toContainEqual(['expiration', String(setup.client.now() + DAY)]);
    }
  });

  it('uses the session_end an answer carries for later wraps', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const sessionEnd = setup.client.now() + DAY - 3_000;
    reply(setup, answerFor(inFlightAskId(setup.client), { session_end: sessionEnd }));
    await settle();
    const before = setup.relay.published().length;
    setup.client.ask('again');
    await settle();
    for (const wrap of setup.relay.published().slice(before)) {
      expect(wrap.tags).toContainEqual(['expiration', String(sessionEnd)]);
    }
  });
});

describe('reconnects', () => {
  it('a REQ with no real EOSE in time is closed and reopened after the backoff', async () => {
    const setup = harness();
    setup.relay.holdEose = true;
    await started(setup);
    expect(setup.client.snapshot().phase).toBe('loading');
    const requestsBefore = setup.relay.requests.length;
    setup.relay.holdEose = false;
    await vi.advanceTimersByTimeAsync(15_001);
    await settle();
    expect(setup.relay.subs[0]?.closed).toBe(true);
    expect(setup.relay.requests.length).toBe(requestsBefore);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(setup.relay.requests.length).toBeGreaterThan(requestsBefore);
    expect(setup.client.snapshot().phase).toBe('ready');
  });

  it('a socket close waits the jittered backoff, then resubscribes and replays', async () => {
    const setup = await started(harness());
    const connectionsBefore = setup.relay.connections.length;
    setup.relay.live()?.drop();
    await settle();
    expect(setup.relay.connections.length).toBe(connectionsBefore);
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(setup.relay.connections.length).toBe(connectionsBefore + 1);
    expect(setup.client.snapshot().phase).toBe('ready');
  });
});

describe('cards and clicks', () => {
  it('reports clicks with the current ticket', async () => {
    const setup = await started(harness());
    setup.client.reportClick(`30402:${setup.store.catalogKey.pubkey}:sku-1`);
    await settle();
    expect(setup.gateway.clicks).toHaveLength(1);
    expect(setup.gateway.clicks[0]?.ticket.tags).toContainEqual(['p', setup.client.visitor.pubkey]);
  });
});

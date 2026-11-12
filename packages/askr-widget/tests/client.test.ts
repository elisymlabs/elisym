import { buildConfigEvent, buildTicket } from '@elisym/askr';
import { type Answer, type ChatMessage, newAskId } from '@elisym/askr/chat';
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

  it('sends the page as origin and path only, never its query or fragment', async () => {
    const setup = await started(
      harness({
        pageUrl: () => 'https://shop.example/products/a?token=secret&email=v%40x.example#order-42',
      }),
    );
    setup.client.ask('this one?');
    await settle();
    const [ask] = asksTo(setup.relay, setup.store.assistant);
    expect(ask?.message).toMatchObject({ page: { url: 'https://shop.example/products/a' } });
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
  it('shows "by Askr" by default and follows the latest grant', async () => {
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

describe('accept rule and dedup', () => {
  it('takes an ask self-copy only from a seal by V: a stranger or A wrapping an ask to V adds no turn', async () => {
    const setup = await started(harness());
    const ticket = sign(
      buildTicket({
        visitor: setup.client.visitor.pubkey,
        store: setup.store.owner.pubkey,
        now: localSecs(),
      }),
      setup.store.gatewayKey,
    );
    for (const sender of [testKey(), setup.store.assistant]) {
      setup.relay.accept(
        MAIN_RELAY,
        wrapFrom(sender, setup.client.visitor.pubkey, {
          type: 'ask',
          ask_id: newAskId(),
          text: 'planted',
          ticket,
        }),
      );
    }
    await settle();
    expect(setup.client.snapshot().turns).toHaveLength(0);
    setup.relay.accept(
      MAIN_RELAY,
      wrapFrom(
        { secretKey: setup.client.visitor.secretKey, pubkey: setup.client.visitor.pubkey },
        setup.client.visitor.pubkey,
        { type: 'ask', ask_id: newAskId(), text: 'from another tab', ticket },
      ),
    );
    await settle();
    expect(setup.client.snapshot().turns.map((turn) => turn.text)).toEqual(['from another tab']);
  });

  it('drops a wrap whose NIP-40 expiration has passed, the boundary second included', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    const past = localSecs() - 100;
    reply(setup, answerFor(askId, { text: 'expired' }), { now: past, expiresAt: localSecs() - 1 });
    reply(setup, answerFor(askId, { text: 'expiring now' }), {
      now: past + 1,
      expiresAt: localSecs(),
    });
    await settle();
    expect(setup.client.snapshot().phase).toBe('waiting');
    expect(setup.client.snapshot().turns[0]?.answer).toBeUndefined();
    reply(setup, answerFor(askId, { text: 'live' }), { expiresAt: localSecs() + 1 });
    await settle();
    expect(setup.client.snapshot().turns[0]?.answer?.text).toBe('live');
  });

  it('a duplicate status rumor (a second wrap of it) does not reset the answer timer again', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    await vi.advanceTimersByTimeAsync(10_000);
    const statusAt = localSecs();
    const status: ChatMessage = { type: 'status', ask_id: askId, text: 'Searching' };
    reply(setup, status, { now: statusAt });
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    reply(setup, status, { now: statusAt });
    await settle();
    // The first status set the timer to t+70 s; a reset by the duplicate would move it to t+90 s.
    await vi.advanceTimersByTimeAsync(40_500);
    await settle();
    expect(setup.client.snapshot()).toMatchObject({ phase: 'retry', retryReason: 'timeout' });
  });

  it('a status replayed after a reconnect, already seen live, does not reset the answer timer', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    await vi.advanceTimersByTimeAsync(10_000);
    reply(setup, { type: 'status', ask_id: askId, text: 'Searching' });
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    const connectionsBefore = setup.relay.connections.length;
    setup.relay.live()?.drop();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(setup.relay.connections.length).toBe(connectionsBefore + 1);
    expect(setup.client.snapshot().phase).toBe('waiting');
    // The live status set the timer to t+70 s; a reset by the replay would move it past t+80 s.
    await vi.advanceTimersByTimeAsync(50_500);
    await settle();
    expect(setup.client.snapshot()).toMatchObject({ phase: 'retry', retryReason: 'timeout' });
  });

  it('a status first seen in a replay is seen: a later wrap of the same rumor does not reset the timer', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    await vi.advanceTimersByTimeAsync(10_000);
    const statusAt = localSecs();
    const status: ChatMessage = { type: 'status', ask_id: askId, text: 'Searching' };
    setup.relay.storeOnly(
      MAIN_RELAY,
      wrapFrom(setup.store.assistant, setup.client.visitor.pubkey, status, { now: statusAt }),
    );
    setup.relay.live()?.drop();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(setup.client.snapshot().turns[0]?.status).toBe('Searching');
    await vi.advanceTimersByTimeAsync(20_000);
    reply(setup, status, { now: statusAt });
    await settle();
    // The replayed status set the timer to about t+71 s; a reset by the live copy would move it to t+91 s.
    await vi.advanceTimersByTimeAsync(41_000);
    await settle();
    expect(setup.client.snapshot()).toMatchObject({ phase: 'retry', retryReason: 'timeout' });
  });

  it('drops a status for an ask that already has its answer', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    reply(setup, answerFor(askId));
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    reply(setup, { type: 'status', ask_id: askId, text: 'Late progress' });
    await settle();
    const [turn] = setup.client.snapshot().turns;
    expect(turn?.answer).toBeDefined();
    expect(turn?.status).toBeUndefined();
    expect(setup.client.snapshot().phase).toBe('ready');
  });
});

describe('a history read with no real EOSE', () => {
  async function bufferedAnswer(): Promise<{ setup: Harness; askId: string }> {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    setup.relay.storeOnly(
      MAIN_RELAY,
      wrapFrom(setup.store.assistant, setup.client.visitor.pubkey, answerFor(askId)),
    );
    setup.relay.holdEose = true;
    return { setup, askId };
  }

  it('an EOSE timeout drops the buffer without marking its rumors seen: the next replay delivers the answer', async () => {
    const { setup } = await bufferedAnswer();
    // The answer timeout reconnects; the replay buffers the answer, but no EOSE comes.
    await vi.advanceTimersByTimeAsync(60_001);
    await settle();
    expect(setup.client.snapshot().phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(15_001);
    await settle();
    expect(setup.client.snapshot()).toMatchObject({ phase: 'retry', retryReason: 'timeout' });
    setup.relay.holdEose = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(setup.client.snapshot().phase).toBe('ready');
    expect(setup.client.snapshot().turns[0]?.answer?.text).toBe('Here you go');
  });

  it('a close before EOSE drops the buffer without marking its rumors seen: the next replay delivers the answer', async () => {
    const { setup } = await bufferedAnswer();
    setup.relay.live()?.drop();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    // Reconnected: the answer is buffered again and the EOSE still held. Drop that one too.
    setup.relay.live()?.drop();
    setup.relay.holdEose = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(setup.client.snapshot().phase).toBe('ready');
    expect(setup.client.snapshot().turns[0]?.answer?.text).toBe('Here you go');
  });

  it('a re-published answer (same rumor, new wrap) still lands after a read failed', async () => {
    const setup = await started(harness());
    setup.client.ask('hello');
    await settle();
    const askId = inFlightAskId(setup.client);
    const answeredAt = localSecs();
    setup.relay.holdEose = true;
    setup.relay.live()?.drop();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    // Delivered into the buffering read, which then closes before any EOSE.
    reply(setup, answerFor(askId), { now: answeredAt });
    setup.relay.live()?.drop();
    setup.relay.events.set(MAIN_RELAY, []);
    setup.relay.holdEose = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(setup.client.snapshot().turns[0]?.answer).toBeUndefined();
    // The worker re-publishes its stored answer: a new wrap of the same rumor.
    reply(setup, answerFor(askId), { now: answeredAt });
    await settle();
    expect(setup.client.snapshot().phase).toBe('ready');
    expect(setup.client.snapshot().turns[0]?.answer).toBeDefined();
  });
});

describe('ticket checks', () => {
  it('refuses a ticket whose p is not the visitor key', async () => {
    const setup = harness();
    setup.gateway.ticketVisitor = testKey().pubkey;
    await started(setup);
    expect(setup.client.snapshot().phase).toBe('loading');
    setup.gateway.ticketVisitor = undefined;
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(setup.client.snapshot().phase).toBe('ready');
  });
});

describe('locale', () => {
  async function sentLocale(locale: string | undefined): Promise<unknown> {
    const setup = await started(harness({ locale: () => locale }));
    setup.client.ask('hello');
    await settle();
    const [ask] = asksTo(setup.relay, setup.store.assistant);
    const message = ask?.message;
    return message?.type === 'ask' ? message.locale : 'no ask';
  }

  it('sends a valid BCP 47 tag', async () => {
    expect(await sentLocale('zh-Hant-TW')).toBe('zh-Hant-TW');
  });

  it('omits a malformed tag', async () => {
    expect(await sentLocale('en_US')).toBeUndefined();
    expect(await sentLocale('e')).toBeUndefined();
    expect(await sentLocale('en-US<script>')).toBeUndefined();
  });

  it('omits a tag over 35 characters, keeps one of exactly 35', async () => {
    const exact = `en-abcdefgh-abcdefgh-abcdefgh-abcde`;
    expect(exact).toHaveLength(35);
    expect(await sentLocale(exact)).toBe(exact);
    expect(await sentLocale(`${exact}f`)).toBeUndefined();
  });
});

describe('session end margin on replay', () => {
  async function reloadWithSession(expiresIn: number): Promise<Harness> {
    const setup = harness();
    const visitor = {
      secretKey: setup.client.visitor.secretKey,
      pubkey: setup.client.visitor.pubkey,
    };
    const askedAt = localSecs() - 30;
    const expiresAt = localSecs() + expiresIn;
    const askId = newAskId();
    const ticket = sign(
      buildTicket({ visitor: visitor.pubkey, store: setup.store.owner.pubkey, now: askedAt }),
      setup.store.gatewayKey,
    );
    setup.relay.storeOnly(
      MAIN_RELAY,
      wrapFrom(
        visitor,
        visitor.pubkey,
        { type: 'ask', ask_id: askId, text: 'old', ticket },
        {
          now: askedAt,
          expiresAt,
        },
      ),
    );
    setup.relay.storeOnly(
      MAIN_RELAY,
      wrapFrom(
        setup.store.assistant,
        visitor.pubkey,
        answerFor(askId, { session_end: expiresAt }),
        {
          now: askedAt + 5,
          expiresAt,
        },
      ),
    );
    return started(setup);
  }

  it('does not restore a session ending within the 5 minute margin', async () => {
    const setup = await reloadWithSession(299);
    expect(setup.client.snapshot()).toMatchObject({ phase: 'ready', turns: [] });
  });

  it('restores a session ending exactly at the margin', async () => {
    const setup = await reloadWithSession(300);
    const [turn] = setup.client.snapshot().turns;
    expect(turn?.text).toBe('old');
    expect(turn?.answer).toBeDefined();
  });
});

describe('reconnect backoff', () => {
  it('resets only after a real EOSE plus 60 s of a stable connection', async () => {
    const setup = await started(harness());
    const count = (): number => setup.relay.connections.length;
    const start = count();
    await vi.advanceTimersByTimeAsync(10_000);
    setup.relay.live()?.drop();
    // First step: 1 s with jitter 0.5 is 750 ms.
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(count()).toBe(start + 1);
    // Up and through its EOSE, but for 10 s only: no reset, so the next step is 1.5 s.
    await vi.advanceTimersByTimeAsync(10_000);
    setup.relay.live()?.drop();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(count()).toBe(start + 1);
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(count()).toBe(start + 2);
    // 60 s up after the EOSE: reset, back to 750 ms.
    await vi.advanceTimersByTimeAsync(60_001);
    setup.relay.live()?.drop();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(count()).toBe(start + 3);
  });

  it('a socket close cancels the pending reset: connect failures past the 60 s mark keep growing the delay', async () => {
    const setup = await started(harness());
    const count = (): number => setup.relay.connections.length;
    const start = count();
    await vi.advanceTimersByTimeAsync(10_000);
    setup.relay.failConnects = 1_000;
    setup.relay.live()?.drop();
    // Failed attempts at 10.75, 12.25, 15.25, 21.25, 33.25, 57.25 and 102.25 s; the next waits 45 s.
    await vi.advanceTimersByTimeAsync(92_500);
    await settle();
    setup.relay.failConnects = 0;
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(count()).toBe(start);
    await vi.advanceTimersByTimeAsync(44_000);
    await settle();
    expect(count()).toBe(start + 1);
  });

  it('a relay CLOSED of the subscription cancels the pending reset: REQs without EOSE keep growing the delay', async () => {
    const setup = await started(harness());
    const inboxRequests = (): number =>
      setup.relay.requests.filter((request) => request.filters[0]?.['#p'] !== undefined).length;
    expect(inboxRequests()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    setup.relay.holdEose = true;
    setup.relay.closeSubscriptions(MAIN_RELAY, (filters) => filters[0]?.['#p'] !== undefined);
    // Reopened at 10.75 s, 27.25 s, 45.25 s (each failing 15 s later), then 6 s after 60.25 s.
    await vi.advanceTimersByTimeAsync(52_000);
    await settle();
    expect(inboxRequests()).toBe(4);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(inboxRequests()).toBe(5);
  });
});

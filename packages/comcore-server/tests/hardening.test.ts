import { buildTicket, unwrapChatMessage } from '@elisym/comcore';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { REQ_BYTES_CAP } from '../src/constants';
import { createGateway } from '../src/gateway/gateway';
import { WindowLimiter } from '../src/gateway/limits';
import { chunkByBytes } from '../src/relay/chunks';
import { readHistory } from '../src/relay/history';
import type { RelayLike } from '../src/relay/pool';
import { MemoryState } from '../src/state/memory';
import type { StoreRecord } from '../src/state/types';
import { buildStoreCatalog } from '../src/worker/catalog';
import { intakeWrap } from '../src/worker/intake';
import { NOW, ORIGIN, TIER, askWrap, storeRecord, syntheticStore } from './fixtures';

const ASK_ID = 'd'.repeat(32);
const WRAP: NostrEvent = {
  id: '0',
  pubkey: '0',
  created_at: NOW,
  kind: 1059,
  tags: [],
  content: '',
  sig: '0',
};

function gateway(record: (store: ReturnType<typeof syntheticStore>) => StoreRecord) {
  const store = syntheticStore();
  const state = new MemoryState([record(store)]);
  const gatewaySecret = generateSecretKey();
  const catalog = buildStoreCatalog(store.events, store.owner, store.assistantSecret, NOW);
  const handler = createGateway({
    state,
    gatewaySecretKey: gatewaySecret,
    // As in main: only leased (active) stores have a cached config.
    configFor: (owner) =>
      owner === store.owner && state.store(owner)?.status === 'active'
        ? catalog?.config
        : undefined,
    now: () => NOW,
  });
  const post = (path: string, body: unknown, origin = ORIGIN, address = '203.0.113.7') =>
    handler({
      request: new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      clientAddress: address,
    });
  return { store, state, gatewaySecret, post };
}

describe('gateway refusals (3)', () => {
  it('refuses a ticket once the budget is spent, with the store contact', async () => {
    const { store, state, post } = gateway((synthetic) => ({
      ...storeRecord(synthetic),
      tier: { ...TIER, dailyBudgetUsd: '0.05' },
    }));
    const session = state.session(store.assistant, 'b'.repeat(64), NOW);
    expect(state.admitAsk(session, ASK_ID, '0.05', NOW).admitted).toBe(true);
    const response = await post('/v1/session', { store: store.owner, visitor: 'a'.repeat(64) });
    expect(response.status).toBe(503);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await response.json()).toEqual({ unavailable: true, reason: 'budget', contact: null });
  });

  it('a store that is not active is readable as unavailable, with no config needed', async () => {
    const { store, post } = gateway((synthetic) => storeRecord(synthetic, 'suspended'));
    const response = await post('/v1/session', { store: store.owner, visitor: 'a'.repeat(64) });
    expect(response.status).toBe(503);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('an unknown store or a foreign origin gets a 403 the page can read', async () => {
    const { store, post } = gateway((synthetic) => storeRecord(synthetic));
    const unknown = await post('/v1/session', { store: 'e'.repeat(64), visitor: 'a'.repeat(64) });
    expect(unknown.status).toBe(403);
    expect(unknown.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const foreign = await post(
      '/v1/session',
      { store: store.owner, visitor: 'a'.repeat(64) },
      'https://evil.example',
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('access-control-allow-origin')).toBe('https://evil.example');
  });

  it('limits clicks per IP before checking the ticket signature', async () => {
    const { store, post } = gateway((synthetic) => storeRecord(synthetic));
    const forged = finalizeEvent(
      buildTicket({ visitor: 'a'.repeat(64), store: store.owner, now: NOW }),
      generateSecretKey(),
    );
    const address = `30402:${store.catalogKey}:jacket-wool`;
    const statuses: number[] = [];
    for (let index = 0; index < 61; index += 1) {
      statuses.push((await post('/v1/click', { ticket: forged, address })).status);
    }
    expect(statuses.slice(0, 60).every((status) => status === 403)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

describe('dedup and sweep (5.8)', () => {
  it('records a rumor id only once its ticket checked out', () => {
    const store = syntheticStore();
    const state = new MemoryState([storeRecord(store)]);
    const gatewaySecret = generateSecretKey();
    const junk = askWrap({
      store,
      visitorSecret: generateSecretKey(),
      gatewaySecret: generateSecretKey(),
      askId: ASK_ID,
      text: 'junk',
    });
    expect(intakeWrap(junk, state, [getPublicKey(gatewaySecret)], NOW).action).toBe('drop');
    const junkRumor = unwrapChatMessage(junk, store.assistantSecret)?.rumorId ?? '';
    expect(junkRumor).not.toBe('');
    expect(state.rumorSeen(junkRumor, NOW)).toBe(false);
    const good = askWrap({
      store,
      visitorSecret: generateSecretKey(),
      gatewaySecret,
      askId: ASK_ID,
      text: 'hi',
    });
    const intake = intakeWrap(good, state, [getPublicKey(gatewaySecret)], NOW);
    if (intake.action !== 'ask') {
      throw new Error('not admitted');
    }
    expect(state.rumorSeen(intake.chat.rumorId, NOW)).toBe(true);
    // The junk one was never recorded: the same rumor with a valid ticket would still pass.
    expect(intakeWrap(good, state, [getPublicKey(gatewaySecret)], NOW).action).toBe('drop');
  });

  it('forgets a rumor id after its TTL', () => {
    const state = new MemoryState([]);
    state.recordRumor('r1', NOW);
    state.recordRumor('r2', NOW + 10);
    expect(state.rumorSeen('r1', NOW + 24 * 60 * 60 - 1)).toBe(true);
    expect(state.rumorSeen('r1', NOW + 24 * 60 * 60)).toBe(false);
    expect(state.rumorSeen('r2', NOW + 24 * 60 * 60)).toBe(true);
  });

  it('sweeps an ended session: its history goes, a running attempt is charged, a queued one released', () => {
    const store = syntheticStore();
    const state = new MemoryState([storeRecord(store)]);
    const visitor = 'b'.repeat(64);
    const session = state.session(store.assistant, visitor, NOW);
    session.history = [{ role: 'user', content: 'hi' }];
    state.saveSession(session);
    const running = state.admitAsk(session, ASK_ID, '0.05', NOW);
    const queued = state.admitAsk(session, 'e'.repeat(32), '0.05', NOW);
    if (!running.admitted || !queued.admitted) {
      throw new Error('not admitted');
    }
    state.startAsk(session, ASK_ID, running.record.attemptId, NOW * 1000 + 60_000);
    expect(state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0.1' });
    state.sweep(session.sessionEnd);
    expect(state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.05', reserved: '0' });
    expect(state.askRecord(session, ASK_ID)).toBeUndefined();
    // The late answer of the swept attempt settles nothing more.
    expect(state.answerAsk(session, ASK_ID, running.record.attemptId, WRAP, '0.2', NOW + 60)).toBe(
      false,
    );
    expect(state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.05', reserved: '0' });
    expect(state.session(store.assistant, visitor, session.sessionEnd).history).toEqual([]);
  });

  it('keeps a session that has not ended', () => {
    const store = syntheticStore();
    const state = new MemoryState([storeRecord(store)]);
    const session = state.session(store.assistant, 'b'.repeat(64), NOW);
    session.history = [{ role: 'user', content: 'hi' }];
    state.saveSession(session);
    state.sweep(NOW + 60);
    expect(state.session(store.assistant, 'b'.repeat(64), NOW + 60).history).toHaveLength(1);
  });
});

describe('limits and chunks', () => {
  it('a limit of zero refuses every hit', () => {
    expect(new WindowLimiter(0, 60_000).hit('k', 0)).toBe(false);
    expect(new WindowLimiter(5, 60_000).hit('k', 0, 0)).toBe(false);
  });

  it('frees a window once it has passed', () => {
    const limiter = new WindowLimiter(1, 60_000);
    expect(limiter.hit('a', 0)).toBe(true);
    expect(limiter.hit('b', 10)).toBe(true);
    expect(limiter.hit('a', 30_000)).toBe(false);
    expect(limiter.hit('a', 60_000)).toBe(true);
    expect(limiter.hit('b', 60_000)).toBe(false);
  });

  it('splits a value list so every REQ stays under the byte cap', () => {
    const keys = Array.from({ length: 7_000 }, (_, index) => index.toString(16).padStart(64, '0'));
    const chunks = chunkByBytes(keys);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(keys);
    for (const chunk of chunks) {
      const req = JSON.stringify(['REQ', 'x'.repeat(64), { kinds: [1059], '#p': chunk }]);
      expect(req.length).toBeLessThan(REQ_BYTES_CAP);
    }
    expect(chunkByBytes([])).toEqual([]);
  });
});

/** A relay stub whose one REQ the test drives by hand. */
function scriptedRelay() {
  let params: Parameters<RelayLike['subscribe']>[1] = {};
  let closed = false;
  const relay: RelayLike = {
    connected: true,
    subscribe(_filters, subscribeParams) {
      params = subscribeParams;
      return {
        close: () => {
          if (!closed) {
            closed = true;
            params.onclose?.('closed by caller');
          }
        },
      };
    },
  };
  return {
    relay,
    eose: () => params.oneose?.(),
    drop: () => {
      closed = true;
      params.onclose?.('relay connection closed');
    },
  };
}

describe('real EOSE (2.4)', () => {
  it('an EOSE before close and before the timer is real', async () => {
    const scripted = scriptedRelay();
    const read = readHistory(scripted.relay, [{ kinds: [1] }], () => undefined, {
      timeoutMs: 1_000,
    });
    scripted.eose();
    expect(await read.done).toBe(true);
  });

  it('an EOSE after the subscription closed is not', async () => {
    const scripted = scriptedRelay();
    const read = readHistory(scripted.relay, [{ kinds: [1] }], () => undefined, {
      timeoutMs: 1_000,
    });
    scripted.drop();
    scripted.eose();
    expect(await read.done).toBe(false);
  });

  it('an EOSE after our own timer is not', async () => {
    const scripted = scriptedRelay();
    const read = readHistory(scripted.relay, [{ kinds: [1] }], () => undefined, {
      timeoutMs: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    scripted.eose();
    expect(await read.done).toBe(false);
  });
});

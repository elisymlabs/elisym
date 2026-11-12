import { buildTicket, unwrapChatMessage } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { positiveUsd } from '../src/config';
import { REQ_BYTES_CAP } from '../src/constants';
import { createGateway } from '../src/gateway/gateway';
import { serveGateway } from '../src/gateway/http';
import { WindowLimiter } from '../src/gateway/limits';
import { chunkByBytes } from '../src/relay/chunks';
import { readHistory } from '../src/relay/history';
import type { RelayLike } from '../src/relay/pool';
import type { LeasedStore } from '../src/state/types';
import { buildStoreCatalog, isListed } from '../src/worker/catalog';
import { intakeWrap } from '../src/worker/intake';
import {
  HOLDER,
  NOW,
  ORIGIN,
  type StoreSpec,
  TIER,
  askWrap,
  leaseEpoch,
  stateWith,
  storeRecord,
  syntheticStore,
} from './fixtures';

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

async function gateway(
  record: (store: ReturnType<typeof syntheticStore>) => StoreSpec,
  loaded = true,
  unservable = false,
) {
  const store = syntheticStore();
  const { state } = await stateWith([record(store)]);
  const active = (await state.store(store.owner))?.status === 'active';
  const gatewaySecret = generateSecretKey();
  const catalog = buildStoreCatalog(store.events, store.owner, store.assistantSecret, NOW);
  const handler = createGateway({
    state,
    gatewaySecretKey: gatewaySecret,
    // As in main: only leased (active) stores have a cached config.
    configFor: (owner) => (loaded && owner === store.owner && active ? catalog?.config : undefined),
    isListed: (owner, address) => owner === store.owner && isListed(catalog, address),
    isUnservable: (owner) => unservable && owner === store.owner,
    reserveUsd: '0.25',
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
    const { store, state, post } = await gateway((synthetic) => ({
      ...storeRecord(synthetic),
      tier: { ...TIER, dailyBudgetUsd: '0.05' },
    }));
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, 'b'.repeat(64), NOW);
    expect((await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW)).admitted).toBe(true);
    const response = await post('/v1/session', { store: store.owner, visitor: 'a'.repeat(64) });
    expect(response.status).toBe(503);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await response.json()).toEqual({ unavailable: true, reason: 'budget', contact: null });
  });

  it('a store that is not active is readable as unavailable, with no config needed', async () => {
    const { store, post } = await gateway((synthetic) => storeRecord(synthetic, 'suspended'));
    const response = await post('/v1/session', { store: store.owner, visitor: 'a'.repeat(64) });
    expect(response.status).toBe(503);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('an unknown store or a foreign origin gets a 403 the page can read', async () => {
    const { store, post } = await gateway((synthetic) => storeRecord(synthetic));
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
    const { store, post } = await gateway((synthetic) => storeRecord(synthetic));
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

describe('gateway review round 2 (3)', () => {
  it('an active store whose catalog is not loaded yet is a retryable 503, not a refusal', async () => {
    const { store, post } = await gateway((synthetic) => storeRecord(synthetic), false);
    const response = await post('/v1/session', { store: store.owner, visitor: 'a'.repeat(64) });
    expect(response.status).toBe(503);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await response.json()).toEqual({ error: 'not_ready' });
  });

  it('counts a click only on a listing of the store, and still under an expired ticket', async () => {
    const { store, state, gatewaySecret, post } = await gateway((synthetic) =>
      storeRecord(synthetic),
    );
    const visitor = 'a'.repeat(64);
    const expired = finalizeEvent(
      buildTicket({ visitor, store: store.owner, now: NOW - 31 * 60 }),
      gatewaySecret,
    );
    const listed = `30402:${store.catalogKey}:jacket-wool`;
    const madeUp = `30402:${store.catalogKey}:no-such-item`;
    expect((await post('/v1/click', { ticket: expired, address: listed })).status).toBe(204);
    expect((await post('/v1/click', { ticket: expired, address: madeUp })).status).toBe(204);
    expect(await state.clicksFor(store.owner, listed)).toBe(1);
    expect(await state.clicksFor(store.owner, madeUp)).toBe(0);
  });
});

describe('gateway review round 3 (3)', () => {
  it('a store with nothing to serve is unavailable, not loading', async () => {
    const { store, post } = await gateway((synthetic) => storeRecord(synthetic), false, true);
    const response = await post('/v1/session', { store: store.owner, visitor: 'a'.repeat(64) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ unavailable: true, reason: 'inactive', contact: null });
  });

  it('refuses a click from a site the store does not list', async () => {
    const { store, state, gatewaySecret, post } = await gateway((synthetic) =>
      storeRecord(synthetic),
    );
    const ticket = finalizeEvent(
      buildTicket({ visitor: 'a'.repeat(64), store: store.owner, now: NOW }),
      gatewaySecret,
    );
    const address = `30402:${store.catalogKey}:jacket-wool`;
    const response = await post('/v1/click', { ticket, address }, 'https://evil.example');
    expect(response.status).toBe(403);
    expect(await state.clicksFor(store.owner, address)).toBe(0);
  });

  it('keeps a replaced session from being written back', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const old = await state.session(store.owner, store.assistant, 'b'.repeat(64), NOW);
    const fresh = await state.session(store.owner, store.assistant, 'b'.repeat(64), old.sessionEnd);
    old.history = [{ role: 'user', content: [{ type: 'text', text: 'stale' }] }];
    await state.saveSession(old);
    const stored = await state.storedSession(store.assistant, 'b'.repeat(64));
    expect(stored?.id).toBe(fresh.id);
    expect(stored?.history).toEqual([]);
  });
});

describe('review round 4', () => {
  it('issues no ticket when not even one turn reservation fits the budget', async () => {
    const { store, post } = await gateway((synthetic) => ({
      ...storeRecord(synthetic),
      tier: { ...TIER, dailyBudgetUsd: '0.2' },
    }));
    const response = await post('/v1/session', { store: store.owner, visitor: 'a'.repeat(64) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ unavailable: true, reason: 'budget' });
  });

  it('a running attempt whose session was swept settles to what it spent when it ends', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, 'b'.repeat(64), NOW);
    const admitted = await state.admitAsk(session, ASK_ID, '0.25', epoch, NOW);
    if (!admitted.admitted) {
      throw new Error('not admitted');
    }
    const deadline = (session.sessionEnd + 60) * 1000;
    await state.startAsk(session, ASK_ID, admitted.record.attemptId, epoch, deadline);
    await state.sweep(session.sessionEnd);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0.25' });
    expect(await state.failAsk(session, ASK_ID, admitted.record.attemptId, epoch, '0.01')).toBe(
      false,
    );
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.01', reserved: '0' });
  });

  it('a swept attempt that never ends is charged its reservation past its deadline', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, 'b'.repeat(64), NOW);
    const admitted = await state.admitAsk(session, ASK_ID, '0.25', epoch, NOW);
    if (!admitted.admitted) {
      throw new Error('not admitted');
    }
    const deadline = (session.sessionEnd + 60) * 1000;
    await state.startAsk(session, ASK_ID, admitted.record.attemptId, epoch, deadline);
    await state.sweep(session.sessionEnd);
    await state.sweep(session.sessionEnd + 61);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.25', reserved: '0' });
  });

  it('checks amounts from the environment', () => {
    expect(positiveUsd('X', '0.25')).toBe('0.25');
    expect(() => positiveUsd('X', '0')).toThrow('X must be a decimal above zero');
    expect(() => positiveUsd('X', 'abc')).toThrow();
    expect(() => positiveUsd('X', '-1')).toThrow();
    expect(() => positiveUsd('X', '1e3')).toThrow();
  });

  it('serves over HTTP: a small body reaches the handler, an oversized one gets 413', async () => {
    const server = serveGateway(async () => new Response('ok', { status: 200 }), {
      port: 0,
      trustProxy: false,
    });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const small = await fetch(`http://127.0.0.1:${port}/v1/session`, {
        method: 'POST',
        body: 'x'.repeat(100),
      });
      expect(small.status).toBe(200);
      const large = await fetch(`http://127.0.0.1:${port}/v1/session`, {
        method: 'POST',
        body: 'x'.repeat(20 * 1024),
      });
      expect(large.status).toBe(413);
    } finally {
      server.close();
    }
  });
});

describe('dedup and sweep (5.8)', () => {
  it('records a rumor id only once its ticket checked out', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const leases = new Map<string, LeasedStore>(
      (await state.acquireLeases(HOLDER, NOW, 60)).map((lease) => [lease.store.assistant, lease]),
    );
    const leaseOf = (assistant: string) => leases.get(assistant);
    const gatewaySecret = generateSecretKey();
    const junk = askWrap({
      store,
      visitorSecret: generateSecretKey(),
      gatewaySecret: generateSecretKey(),
      askId: ASK_ID,
      text: 'junk',
    });
    expect(
      (await intakeWrap(junk, leaseOf, state, [getPublicKey(gatewaySecret)], NOW)).action,
    ).toBe('drop');
    const junkRumor = unwrapChatMessage(junk, store.assistantSecret)?.rumorId ?? '';
    expect(junkRumor).not.toBe('');
    expect(await state.rumorSeen(junkRumor, NOW)).toBe(false);
    const good = askWrap({
      store,
      visitorSecret: generateSecretKey(),
      gatewaySecret,
      askId: ASK_ID,
      text: 'hi',
    });
    const intake = await intakeWrap(good, leaseOf, state, [getPublicKey(gatewaySecret)], NOW);
    if (intake.action !== 'ask') {
      throw new Error('not admitted');
    }
    expect(await state.rumorSeen(intake.chat.rumorId, NOW)).toBe(true);
    // The junk one was never recorded: the same rumor with a valid ticket would still pass.
    expect(
      (await intakeWrap(good, leaseOf, state, [getPublicKey(gatewaySecret)], NOW)).action,
    ).toBe('drop');
  });

  it('forgets a rumor id after its TTL', async () => {
    const { state } = await stateWith([]);
    expect(await state.recordRumor('r1', NOW)).toBe(true);
    expect(await state.recordRumor('r2', NOW + 10)).toBe(true);
    expect(await state.rumorSeen('r1', NOW + 24 * 60 * 60 - 1)).toBe(true);
    expect(await state.rumorSeen('r1', NOW + 24 * 60 * 60)).toBe(false);
    expect(await state.rumorSeen('r2', NOW + 24 * 60 * 60)).toBe(true);
  });

  it('sweeps an ended session: its history goes, a running attempt is charged, a queued one released', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const visitor = 'b'.repeat(64);
    const session = await state.session(store.owner, store.assistant, visitor, NOW);
    session.history = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    await state.saveSession(session);
    const running = await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW);
    const queued = await state.admitAsk(session, 'e'.repeat(32), '0.05', epoch, NOW);
    if (!running.admitted || !queued.admitted) {
      throw new Error('not admitted');
    }
    await state.startAsk(session, ASK_ID, running.record.attemptId, epoch, NOW * 1000 + 60_000);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0.1' });
    await state.sweep(session.sessionEnd);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.05', reserved: '0' });
    expect(await state.askRecord(session, ASK_ID)).toBeUndefined();
    // The late answer of the swept attempt settles nothing more.
    expect(
      await state.answerAsk(
        session,
        ASK_ID,
        running.record.attemptId,
        epoch,
        WRAP,
        '0.2',
        NOW + 60,
      ),
    ).toBe(false);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.05', reserved: '0' });
    expect(
      (await state.session(store.owner, store.assistant, visitor, session.sessionEnd)).history,
    ).toEqual([]);
  });

  it('keeps a session that has not ended', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const session = await state.session(store.owner, store.assistant, 'b'.repeat(64), NOW);
    session.history = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    await state.saveSession(session);
    await state.sweep(NOW + 60);
    expect(
      (await state.session(store.owner, store.assistant, 'b'.repeat(64), NOW + 60)).history,
    ).toHaveLength(1);
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

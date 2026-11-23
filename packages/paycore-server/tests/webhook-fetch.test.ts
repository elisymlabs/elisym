import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Server, createServer } from 'node:https';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { verifyWebhook } from '@elisym/commerce/webhook';
import { WEBHOOK_MAX_ANSWER_BYTES } from '@merchant-node/constants';
import { type LedgerState, emptyLedger, newWebhookEntry } from '@merchant-node/ledger';
import { startStoreNode } from '@merchant-node/store-node';
import { type FetchLike, WebhookSender, sendWebhook, testBody } from '@merchant-node/webhook';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type FetchGuardDeps,
  type ResolvedAddress,
  type Transport,
  checkUrl,
  createNodeTransport,
} from '../src/connectors/fetch-guard';
import { WebhookSlots, type WebhookSlotsOptions } from '../src/webhook-fetch';

// A self-signed certificate for `shop.test` (valid to 2126), checked in for these tests only.
const TLS_DIR = join(import.meta.dirname, 'fixtures', 'tls');
const CERT = readFileSync(join(TLS_DIR, 'shop-test.cert.pem'), 'utf8');
const KEY = readFileSync(join(TLS_DIR, 'shop-test.key.pem'), 'utf8');
const LOOPBACK: ResolvedAddress = { address: '127.0.0.1', family: 4 };
const PUBLIC_IP: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const HOOK_URL = 'https://shop.test/hook';
const SECRET = 'k'.repeat(64);
const STORE = 'a'.repeat(64);
const BUYER = 'b'.repeat(64);
const NOW = 1_800_000_000;
const USER_AGENT = 'elisym-merchant-node/test';
const USDC_DEVNET_CAIP19 =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

interface Received {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let port = 0;
const received: Received[] = [];
/** Answers to `/held` wait here until a test releases them. */
const held: (() => void)[] = [];
let endlessProduced = 0;

function answer(request: IncomingMessage, response: ServerResponse): void {
  switch (new URL(request.url ?? '/', 'https://shop.test').pathname) {
    case '/redirect':
      response.writeHead(307, { location: '/hook' }).end();
      return;
    case '/held':
      held.push(() => response.writeHead(200).end('ok'));
      return;
    case '/stalled':
      return;
    case '/endless': {
      response.writeHead(200, { 'content-type': 'text/plain' });
      const filler = new Readable({
        read() {
          endlessProduced += 16 * 1024;
          this.push(Buffer.alloc(16 * 1024, 0x61));
        },
      });
      response.on('close', () => filler.destroy());
      filler.pipe(response);
      return;
    }
    case '/error-page':
      response.writeHead(500, { 'content-type': 'text/html' }).end('e'.repeat(20_000));
      return;
    case '/empty':
      response.writeHead(204).end();
      return;
    default:
      response.writeHead(200, { 'content-type': 'text/plain' }).end('received');
  }
}

beforeAll(async () => {
  server = createServer({ key: KEY, cert: CERT }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      answer(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server has no port');
  }
  port = address.port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  held.length = 0;
});

const testTransport = createNodeTransport({ ca: CERT });

/** Stands in for port 443 and a public answer: the guard passes, the connection goes to the local server. */
const toLocalServer: Transport = (request) => {
  const url = new URL(request.url);
  url.port = String(port);
  return testTransport({ ...request, url, address: LOOPBACK });
};

const LOCAL: FetchGuardDeps = { resolve: async () => [PUBLIC_IP], transport: toLocalServer };

/** One store's adapter over its own slots. */
function webhookFetch(options: WebhookSlotsOptions = {}): FetchLike {
  return new WebhookSlots(options).forStore(STORE);
}

function post(fetchLike: FetchLike, url: string): Promise<Response> {
  return fetchLike(url, { method: 'POST', body: '{}' });
}

function send(fetchLike: FetchLike, url: string, timeoutMs?: number) {
  const { body, eventId } = testBody(STORE);
  return sendWebhook(
    { url, secret: SECRET },
    { name: 'test', eventId, body },
    {
      now: () => NOW,
      userAgent: USER_AGENT,
      fetch: fetchLike,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  );
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function paidLedger(store = STORE): LedgerState {
  const state = emptyLedger();
  const orderId = 'b3a7c2d4-0000-4000-8000-000000000001';
  const order = {
    key: `${BUYER}:${orderId}`,
    buyerPubkey: BUYER,
    orderId,
    rumorId: 'r'.repeat(64),
    createdAt: NOW - 600,
    reference: 'ref',
    product: `30402:${store}:course-101`,
    deliveredAt: NOW,
    reportedTxs: [],
    paid: {
      signature: 's'.repeat(88),
      amount: '1500000',
      blockTime: NOW - 300,
      caip19: USDC_DEVNET_CAIP19,
      medium: 'solana-devnet',
    },
  };
  state.orders[order.key] = { ...order, webhook: newWebhookEntry(store, order, NOW) };
  return state;
}

function onlyEntry(state: LedgerState) {
  const [order] = Object.values(state.orders);
  if (order?.webhook === undefined) {
    throw new Error('the ledger has no webhook entry');
  }
  return order.webhook;
}

describe('webhookFetch carrying merchant-node sendWebhook over TLS', () => {
  it('POSTs the signed event with every header, and the receiver verifies it', async () => {
    const result = await send(webhookFetch({ deps: LOCAL }), HOOK_URL);
    expect(result).toEqual({ ok: true, status: 200 });
    expect(received).toHaveLength(1);
    const [request] = received;
    if (request === undefined) {
      throw new Error('nothing received');
    }
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/hook');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['user-agent']).toBe(USER_AGENT);
    expect(request.headers['content-length']).toBe(String(Buffer.byteLength(request.body)));
    expect(request.headers['transfer-encoding']).toBeUndefined();
    expect(request.headers['x-elisym-event']).toBe('test');
    expect(request.headers['x-elisym-timestamp']).toBe(String(NOW));
    const parsed: unknown = JSON.parse(request.body);
    expect(parsed).toMatchObject({ event: 'test', store: STORE });
    expect(request.headers['x-elisym-event-id']).toBe(
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'eventId') : undefined,
    );
    const verified = await verifyWebhook({
      secret: SECRET,
      body: request.body,
      headers: request.headers,
      now: NOW,
    });
    expect(verified.ok).toBe(true);
    const forged = await verifyWebhook({
      secret: 'other'.repeat(13),
      body: request.body,
      headers: request.headers,
      now: NOW,
    });
    expect(forged).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('a redirect fails the send and is not followed', async () => {
    const result = await send(webhookFetch({ deps: LOCAL }), 'https://shop.test/redirect');
    expect(result).toEqual({ ok: false, error: 'redirect refused' });
    expect(received.map((request) => request.path)).toEqual(['/redirect']);
  });

  it('reads at most 4 KiB of an endless answer, and a 2xx with a long answer still succeeds', async () => {
    endlessProduced = 0;
    const adapter = webhookFetch({ deps: LOCAL });
    const response = await adapter('https://shop.test/endless', {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect((await response.text()).length).toBe(WEBHOOK_MAX_ANSWER_BYTES);
    expect(await send(adapter, 'https://shop.test/endless')).toEqual({ ok: true, status: 200 });
    // The server stopped producing soon after the cut (socket buffers aside), far from endless.
    expect(endlessProduced).toBeLessThan(16 * 1024 * 1024);
  });

  it('a non-2xx answer fails with its status; a 204 succeeds', async () => {
    const adapter = webhookFetch({ deps: LOCAL });
    expect(await send(adapter, 'https://shop.test/error-page')).toEqual({
      ok: false,
      status: 500,
      error: 'HTTP 500',
    });
    expect(await send(adapter, 'https://shop.test/empty')).toEqual({ ok: true, status: 204 });
  });

  it.each([
    ['a private address', [{ address: '10.0.0.5', family: 4 }]],
    ['the metadata address', [{ address: '169.254.169.254', family: 4 }]],
    ['loopback', [{ address: '::1', family: 6 }]],
  ] as const)('refuses a host resolving to %s without connecting', async (_name, addresses) => {
    let connected = 0;
    const adapter = webhookFetch({
      deps: {
        resolve: async () => [...addresses],
        transport: (request) => {
          connected += 1;
          return toLocalServer(request);
        },
      },
    });
    const result = await send(adapter, HOOK_URL);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/non-public address/u);
    expect(connected).toBe(0);
    expect(received).toHaveLength(0);
  });

  it.each(['https://127.0.0.1/hook', 'https://169.254.169.254/latest', 'https://[fd00:ec2::254]/'])(
    'refuses the literal address %s without connecting',
    async (url) => {
      const result = await send(webhookFetch({ deps: LOCAL }), url);
      expect(result.ok === false && result.error).toMatch(/non-public address/u);
      expect(received).toHaveLength(0);
    },
  );

  it('refuses a port other than 443, the same check the webhook URL gets on input', async () => {
    expect(() => checkUrl('https://shop.test:8443/hook')).toThrow(
      expect.objectContaining({ code: 'port_not_allowed' }),
    );
    expect(() => checkUrl('http://shop.test/hook')).toThrow(
      expect.objectContaining({ code: 'not_https' }),
    );
    const result = await send(webhookFetch({ deps: LOCAL }), 'https://shop.test:8443/hook');
    expect(result.ok === false && result.error).toMatch(/default https port/u);
    expect(received).toHaveLength(0);
  });

  it('times a request from when it starts, with its own budget', async () => {
    const adapter = webhookFetch({ deps: LOCAL, timeoutMs: 150 });
    const started = Date.now();
    const result = await send(adapter, 'https://shop.test/stalled', 60_000);
    expect(result.ok === false && result.error).toMatch(/took too long/u);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('refuses anything but a POST with a string or byte body', async () => {
    const adapter = webhookFetch({ deps: LOCAL });
    await expect(adapter(HOOK_URL, { method: 'GET' })).rejects.toThrow(/POST only/u);
    await expect(
      adapter(HOOK_URL, { method: 'POST', body: new URLSearchParams('a=1') }),
    ).rejects.toThrow(/string or byte body/u);
    expect(received).toHaveLength(0);
  });
});

describe('the global concurrency cap', () => {
  it('a saturated cap delays a send without failing it or counting an attempt', async () => {
    // Two held sends ahead of it keep the send queued for about 1.4 s: longer
    // than the adapter's own budget (1 s) and far past the sender's signal
    // (50 ms). Neither may fail or age a queued send.
    const adapter = webhookFetch({ deps: LOCAL, maxConcurrent: 1, timeoutMs: 1_000 });
    const blockers = [
      send(adapter, 'https://shop.test/held'),
      send(adapter, 'https://shop.test/held'),
    ];
    await until(() => held.length === 1, 'the first send to hold the only slot');

    const state = paidLedger();
    const entry = onlyEntry(state);
    const sender = new WebhookSender({
      state,
      store: { storePubkey: STORE },
      target: { url: HOOK_URL, secret: SECRET },
      commit: (change) => change(),
      log: () => undefined,
      now: () => NOW,
      userAgent: USER_AGENT,
      fetch: adapter,
      random: () => 0,
      timeoutMs: 50,
    });
    const queuedAt = Date.now();
    const tick = sender.tick();
    for (let blocker = 0; blocker < 2; blocker++) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(entry).toMatchObject({ state: 'pending', attempts: 0 });
      expect(sender.sending).toBe(1);
      expect(received.every((request) => request.path === '/held')).toBe(true);
      held.shift()?.();
      if (blocker === 0) {
        await until(() => held.length === 1, 'the second held send to start');
      }
    }
    expect(await Promise.all(blockers)).toEqual([
      { ok: true, status: 200 },
      { ok: true, status: 200 },
    ]);
    await tick;
    expect(Date.now() - queuedAt).toBeGreaterThan(1_000);
    expect(entry).toMatchObject({ state: 'sent', attempts: 1, lastStatus: 200 });
    expect(entry.lastError).toBeUndefined();
    const delivered = received.at(-1);
    expect(delivered?.path).toBe('/hook');
    expect(delivered?.headers['x-elisym-event-id']).toBe(entry.eventId);
    const verified = await verifyWebhook({
      secret: SECRET,
      body: delivered?.body ?? '',
      headers: delivered?.headers ?? {},
      now: NOW,
    });
    expect(verified.ok).toBe(true);
  });

  it('runs up to the cap at once and starts queued sends in arrival order', async () => {
    const adapter = webhookFetch({ deps: LOCAL, maxConcurrent: 2 });
    const sends = [0, 1, 2, 3].map(() => send(adapter, 'https://shop.test/held'));
    await until(() => held.length === 2, 'two sends to run');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(held).toHaveLength(2);
    held.shift()?.();
    await until(() => held.length === 2, 'the third send to take the freed slot');
    for (const release of held.splice(0)) {
      release();
    }
    await until(() => held.length === 1, 'the fourth send');
    held.shift()?.();
    const results = await Promise.all(sends);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(received).toHaveLength(4);
  });

  it('a failing send frees its slot', async () => {
    const adapter = webhookFetch({ deps: LOCAL, maxConcurrent: 1 });
    expect((await send(adapter, 'https://shop.test/redirect')).ok).toBe(false);
    expect((await send(adapter, 'https://shop.test:8443/hook')).ok).toBe(false);
    expect(await send(adapter, HOOK_URL)).toEqual({ ok: true, status: 200 });
  });

  it('shutdown refuses the queued sends without making them and aborts the running ones', async () => {
    const shutdown = new AbortController();
    const slots = new WebhookSlots({ deps: LOCAL, maxConcurrent: 1, signal: shutdown.signal });
    const adapter = slots.forStore(STORE);
    const running = send(adapter, 'https://shop.test/held');
    await until(() => held.length === 1, 'the first send to run');
    const queued = slots.forStore('other')(HOOK_URL, { method: 'POST', body: '{}' });
    expect(slots.queued).toBe(1);
    const abortedAt = Date.now();
    shutdown.abort();
    await expect(queued).rejects.toThrow(/shutting down/u);
    const result = await running;
    expect(result.ok === false && result.error).toMatch(/took too long/u);
    // Aborted at once, not at the end of its own 10 s budget.
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
    expect(slots.running).toBe(0);
    expect(slots.queued).toBe(0);
    await expect(adapter(HOOK_URL, { method: 'POST', body: '{}' })).rejects.toThrow(
      /shutting down/u,
    );
    expect(received.map((request) => request.path)).toEqual(['/held']);
  });
});

describe('the slots shared by the stores', () => {
  it("serves the stores in turn: a store with one send waiting goes before another store's backlog", async () => {
    const slots = new WebhookSlots({ deps: LOCAL, maxConcurrent: 1, maxQueuedPerStore: 10 });
    const blocker = post(slots.forStore('c'), 'https://shop.test/held?c');
    await until(() => held.length === 1, 'the blocker to hold the only slot');
    const storeA = slots.forStore('a');
    const backlog = Array.from({ length: 10 }, (_unused, index) =>
      post(storeA, `https://shop.test/held?a${index}`),
    );
    const single = post(slots.forStore('b'), 'https://shop.test/held?b');
    expect(slots.queued).toBe(11);
    for (let served = 0; served < 3; served++) {
      held.shift()?.();
      await until(() => held.length === 1, 'the next send to take the freed slot');
    }
    expect(received.map((request) => request.path)).toEqual([
      '/held?c',
      '/held?a0',
      '/held?b',
      '/held?a1',
    ]);
    while (held.length > 0 || slots.queued > 0) {
      held.shift()?.();
      await until(() => held.length === 1 || slots.running === 0, 'the backlog to move');
    }
    const answers = await Promise.all([blocker, ...backlog, single]);
    expect(answers.every((response) => response.status === 200)).toBe(true);
    expect(slots.running).toBe(0);
  });

  it("refuses a store's send past its waiting limit, leaving the others queued", async () => {
    const slots = new WebhookSlots({ deps: LOCAL, maxConcurrent: 1, maxQueuedPerStore: 2 });
    const blocker = post(slots.forStore('c'), 'https://shop.test/held');
    await until(() => held.length === 1, 'the blocker to run');
    const storeA = slots.forStore('a');
    const waiting = [post(storeA, HOOK_URL), post(storeA, HOOK_URL)];
    await expect(post(storeA, HOOK_URL)).rejects.toThrow(/waiting/u);
    const other = post(slots.forStore('b'), HOOK_URL);
    expect(slots.queued).toBe(3);
    held.shift()?.();
    const answers = await Promise.all([blocker, ...waiting, other]);
    expect(answers.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(slots.running).toBe(0);
  });

  it('a send aborted while waiting leaves the line: the next live one gets the slot', async () => {
    const slots = new WebhookSlots({ deps: LOCAL, maxConcurrent: 1 });
    const blocker = post(slots.forStore('c'), 'https://shop.test/held');
    await until(() => held.length === 1, 'the blocker to run');
    const stopA = new AbortController();
    const storeA = slots.forStore('a', { signal: stopA.signal });
    const abandoned = [post(storeA, HOOK_URL), post(storeA, HOOK_URL)];
    const live = post(slots.forStore('b'), 'https://shop.test/held?b');
    expect(slots.queued).toBe(3);
    stopA.abort();
    await expect(Promise.all(abandoned)).rejects.toThrow(/store is stopping/u);
    expect(slots.queued).toBe(1);
    expect(slots.running).toBe(1);
    held.shift()?.();
    await until(() => held.length === 1, 'the live waiter to get the slot');
    expect(slots.running).toBe(1);
    expect(slots.queued).toBe(0);
    held.shift()?.();
    expect((await blocker).status).toBe(200);
    expect((await live).status).toBe(200);
    expect(slots.running).toBe(0);
    expect(received.map((request) => request.path)).toEqual(['/held', '/held?b']);
  });

  it("a store's stop refuses and aborts only that store's sends", async () => {
    const slots = new WebhookSlots({ deps: LOCAL, maxConcurrent: 2 });
    const stopA = new AbortController();
    const storeA = slots.forStore('a', { signal: stopA.signal });
    const storeB = slots.forStore('b');
    const runningA = post(storeA, 'https://shop.test/held?a-running');
    const runningB = post(storeB, 'https://shop.test/held?b-running');
    await until(() => held.length === 2, 'one send of each store to run');
    const queuedA = post(storeA, HOOK_URL);
    const queuedB = post(storeB, 'https://shop.test/hook?b-queued');
    expect(slots.queued).toBe(2);
    const stoppedAt = Date.now();
    stopA.abort();
    await expect(queuedA).rejects.toThrow(/store is stopping/u);
    await expect(runningA).rejects.toThrow(/took too long/u);
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
    // The slot store A freed goes to store B's waiting send.
    expect((await queuedB).status).toBe(200);
    await expect(post(storeA, HOOK_URL)).rejects.toThrow(/store is stopping/u);
    for (const release of held.splice(0)) {
      release();
    }
    expect((await runningB).status).toBe(200);
    expect((await post(storeB, 'https://shop.test/hook?b-after')).status).toBe(200);
    expect(slots.running).toBe(0);
    expect(received.map((request) => request.path).sort()).toEqual([
      '/held?a-running',
      '/held?b-running',
      '/hook?b-after',
      '/hook?b-queued',
    ]);
  });

  it("a send refused at the store's stop leaves the ledger entry as it was", async () => {
    const slots = new WebhookSlots({ deps: LOCAL, maxConcurrent: 1 });
    const blocker = post(slots.forStore('other'), 'https://shop.test/held');
    await until(() => held.length === 1, 'the other store to hold the only slot');

    const secretKey = generateSecretKey();
    const storePubkey = getPublicKey(secretKey);
    const state = paidLedger(storePubkey);
    const entry = onlyEntry(state);
    const stop = new AbortController();
    let saves = 0;
    const node = await startStoreNode({
      pool: {
        subscribe: () => ({ close: () => undefined }),
        subscribeEose: () => ({ close: () => undefined }),
        ensureRelay: async () => ({ publish: async () => '', auth: async () => '' }),
      },
      config: { name: 'Shop', network: 'devnet', payouts: [], inboxRelays: ['wss://inbox.test'] },
      products: new Map(),
      state,
      storePubkey,
      storeSecretKey: secretKey,
      save: () => {
        saves += 1;
      },
      refreshTreasuries: async () => ({ kind: 'unreachable', problem: 'offline' }),
      eip3009: [],
      webhook: {
        target: { url: HOOK_URL, secret: SECRET },
        userAgent: USER_AGENT,
        fetch: slots.forStore(storePubkey, { signal: stop.signal }),
      },
      log: () => undefined,
      now: () => NOW,
      stop: () => undefined,
    });
    await until(() => slots.queued === 1, "the store's webhook to wait for a slot");
    const savesBeforeStop = saves;
    const stopping = node.stop();
    stop.abort();
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slots.queued).toBe(0);
    expect(entry).toMatchObject({ state: 'pending', attempts: 0, nextAt: NOW });
    expect(entry.lastError).toBeUndefined();
    expect(saves).toBe(savesBeforeStop);
    held.shift()?.();
    expect((await blocker).status).toBe(200);
    expect(received.map((request) => request.path)).toEqual(['/held']);
  });
});

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configProblems, configTemplate, webhookUrlProblem } from '../src/config';
import {
  MAX_WEBHOOKS_IN_FLIGHT,
  WEBHOOK_DEADLINE_SECS,
  WEBHOOK_FIRST_PAUSE_SECS,
  WEBHOOK_MAX_PAUSE_SECS,
} from '../src/constants';
import { planHandAnswer } from '../src/hand';
import { intake } from '../src/intake';
import {
  type LedgerState,
  type MerchantOrder,
  type VerifiedPayment,
  emptyLedger,
  loadLedger,
  newWebhookEntry,
  recordPayment,
  saveLedger,
  webhookEventId,
} from '../src/ledger';
import {
  NO_WEBHOOK_NOTICE,
  WEBHOOK_SECRET_ENV,
  WEBHOOK_SECRET_FILE_ENV,
  WebhookSender,
  applySendResult,
  failureText,
  orderPaidBody,
  readWebhookSecret,
  retryPause,
  sendWebhook,
  webhookSignature,
  webhookTarget,
} from '../src/webhook';
import { orderLines, rearmWebhook, shownRef } from '../src/webhook-commands';
import { PAYOUT, T0, USDC_DEVNET_CAIP19, key, orderFrom, world, productAt } from './fixtures';

const SECRET = 'x'.repeat(32);
const STORE = 'a'.repeat(64);
const BUYER = 'b'.repeat(64);
const ORDER_ID = 'b3a7c2d4-0000-4000-8000-000000000001';
const SIG =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const PRODUCT = `30402:${STORE}:course-101`;
const NOW = T0 + 1_000;

const PAID: VerifiedPayment = {
  signature: SIG,
  amount: '1500000',
  blockTime: T0 + 120,
  caip19: USDC_DEVNET_CAIP19,
  medium: 'solana-devnet',
};

function paidOrder(overrides: Partial<MerchantOrder> = {}, orderId = ORDER_ID): MerchantOrder {
  return {
    key: `${BUYER}:${orderId}`,
    buyerPubkey: BUYER,
    orderId,
    rumorId: 'r'.repeat(64),
    createdAt: T0,
    reference: 'ref',
    product: PRODUCT,
    reportedTxs: [],
    paid: { ...PAID },
    ...overrides,
  };
}

function ledgerWith(...orders: MerchantOrder[]): LedgerState {
  const state = emptyLedger();
  for (const order of orders) {
    state.orders[order.key] = order;
  }
  return state;
}

/** The receiver's check, written independently of the node: HMAC over `timestamp.rawBody`. */
function verifies(secret: string, timestamp: string, rawBody: string, header: string): boolean {
  const expected = Buffer.from(
    `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`,
  );
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

interface Received {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** A local receiver: `answer` decides each response; every request is kept. */
async function receiver(
  answer: (request: Received, response: ServerResponse) => void = (_request, response) => {
    response.writeHead(200).end('ok');
  },
) {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry = {
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(entry);
      answer(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  servers.push(server);
  return { url: `http://127.0.0.1:${port}/hook`, received, server };
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function sender(
  state: LedgerState,
  url: string,
  options: { now?: () => number; timeoutMs?: number; logs?: string[]; saves?: string[] } = {},
) {
  return new WebhookSender({
    state,
    store: { storePubkey: STORE },
    target: { url, secret: SECRET },
    commit: (change) => {
      change();
      options.saves?.push(JSON.stringify(state));
    },
    log: (message) => options.logs?.push(message),
    now: options.now ?? (() => NOW),
    userAgent: 'elisym-merchant-node/test',
    random: () => 0,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

describe('the event id', () => {
  it('is a frozen contract: sha256 of store, order key and payment signature', () => {
    expect(webhookEventId(STORE, `${BUYER}:${ORDER_ID}`, SIG)).toBe(
      'e3770328164348c3e67da64881c7b1d7975899a04704a578be0b8e977383df53',
    );
  });

  it('differs for two orders one Tempo transaction paid, and is the same when recomputed', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const first = webhookEventId(STORE, `${BUYER}:${ORDER_ID}`, hash);
    const second = webhookEventId(STORE, `${BUYER}:b3a7c2d4-0000-4000-8000-000000000002`, hash);
    expect(first).not.toBe(second);
    expect(webhookEventId(STORE, `${BUYER}:${ORDER_ID}`, hash)).toBe(first);
  });
});

describe('the outbox entry', () => {
  it('is written with the payment, in the same change, only when a webhook is configured', () => {
    const order = paidOrder({ paid: undefined });
    recordPayment(order, PAID, { storePubkey: STORE, now: () => NOW });
    expect(order.paid).toEqual(PAID);
    expect(order.webhook).toEqual({
      state: 'pending',
      eventId: webhookEventId(STORE, order.key, SIG),
      createdAt: NOW,
      deadline: NOW + WEBHOOK_DEADLINE_SECS,
      attempts: 0,
      nextAt: NOW,
    });
    const unconfigured = paidOrder({ paid: undefined });
    recordPayment(unconfigured, PAID, undefined);
    expect(unconfigured.paid).toEqual(PAID);
    expect(unconfigured.webhook).toBeUndefined();
  });

  it('survives a crash after the save: a node started on the saved ledger sends it', async () => {
    const order = paidOrder({ paid: undefined });
    const state = ledgerWith(order);
    recordPayment(order, PAID, { storePubkey: STORE, now: () => NOW });
    const path = join(mkdtempSync(join(tmpdir(), 'merchant-webhook-')), 'ledger.json');
    saveLedger(path, state);
    // A new process: only what was saved.
    const reloaded = loadLedger(path);
    const { url, received } = await receiver();
    await sender(reloaded, url).tick();
    expect(received).toHaveLength(1);
    expect(received[0]?.headers['x-elisym-event-id']).toBe(webhookEventId(STORE, order.key, SIG));
    expect(reloaded.orders[order.key]?.webhook?.state).toBe('sent');
  });
});

describe('the order.paid body', () => {
  it('carries what the node verified, in a fixed key order, without title or price', () => {
    const order = paidOrder({ customerRef: 'user-123', email: 'buyer@example.com' });
    const entry = newWebhookEntry(STORE, order, NOW);
    expect(orderPaidBody(order, entry, { storePubkey: STORE })).toBe(
      JSON.stringify({
        event: 'order.paid',
        eventId: entry.eventId,
        store: STORE,
        orderId: ORDER_ID,
        buyerPubkey: BUYER,
        customerRef: 'user-123',
        product: { address: PRODUCT },
        payment: {
          asset: USDC_DEVNET_CAIP19,
          amount: '1500000',
          amountDisplay: '1.5',
          decimals: 6,
          symbol: 'USDC',
          tx: SIG,
          medium: 'solana-devnet',
          paidAt: T0 + 120,
        },
        email: 'buyer@example.com',
      }),
    );
  });

  it('names the product the order named', () => {
    const order = paidOrder({ product: `30402:${STORE}:deposit-10` });
    const named = JSON.parse(
      orderPaidBody(order, newWebhookEntry(STORE, order, NOW), { storePubkey: STORE }),
    ) as { product: { address: string } };
    expect(named.product.address).toBe(`30402:${STORE}:deposit-10`);
  });

  it('has no customerRef or email key when the order has none, and no display for an unknown asset', () => {
    const order = paidOrder({ paid: { ...PAID, caip19: 'solana:unknown/token:nothing' } });
    const body = JSON.parse(
      orderPaidBody(order, newWebhookEntry(STORE, order, NOW), { storePubkey: STORE }),
    ) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('customerRef');
    expect(Object.keys(body)).not.toContain('email');
    expect(body.payment).toEqual({
      asset: 'solana:unknown/token:nothing',
      amount: '1500000',
      tx: SIG,
      medium: 'solana-devnet',
      paidAt: T0 + 120,
    });
  });
});

describe('the signature', () => {
  it('is v1= HMAC-SHA256 over the timestamp, a dot and the raw body', () => {
    expect(webhookSignature(SECRET, 1_791_100_000, '{"a":1}')).toBe(
      'v1=3c8a1c2fe10d3b2f9f419de45b1a81e4ef90265bcf45dd734dc99989fde5ac99',
    );
    // The timestamp is signed: the same body at another time signs differently.
    expect(webhookSignature(SECRET, 1_791_100_001, '{"a":1}')).not.toBe(
      webhookSignature(SECRET, 1_791_100_000, '{"a":1}'),
    );
  });
});

describe('the secret', () => {
  it('comes from the variable or the file, never both, never empty, never short', () => {
    expect(readWebhookSecret({})).toBeUndefined();
    expect(readWebhookSecret({ [WEBHOOK_SECRET_ENV]: '' })).toBeUndefined();
    expect(readWebhookSecret({ [WEBHOOK_SECRET_ENV]: SECRET })).toBe(SECRET);
    expect(readWebhookSecret({ [WEBHOOK_SECRET_FILE_ENV]: '/secret' }, () => `${SECRET}\n`)).toBe(
      SECRET,
    );
    expect(() =>
      readWebhookSecret({ [WEBHOOK_SECRET_ENV]: SECRET, [WEBHOOK_SECRET_FILE_ENV]: '/secret' }),
    ).toThrow(/not both/);
    expect(() => readWebhookSecret({ [WEBHOOK_SECRET_FILE_ENV]: '/secret' }, () => '\n')).toThrow(
      /is empty/,
    );
  });

  it('must be 32 bytes for a configured webhook, and is only warned about without one', () => {
    const webhook = { url: 'https://shop.example/hook' };
    expect(() => webhookTarget(webhook, 'x'.repeat(31))).toThrow(/shorter than 32 bytes/);
    // Bytes, not characters: 16 two-byte characters are 32 bytes.
    expect(webhookTarget(webhook, 'é'.repeat(16)).target?.secret).toBe('é'.repeat(16));
    expect(() => webhookTarget(webhook, 'é'.repeat(15))).toThrow(/shorter/);
    // No webhook: a short secret never stops the node.
    expect(readWebhookSecret({ [WEBHOOK_SECRET_ENV]: 'short' })).toBe('short');
    expect(webhookTarget(undefined, 'short')).toEqual({
      warning: expect.stringMatching(/no webhook/),
      notice: NO_WEBHOOK_NOTICE,
    });
  });

  it('is required with a webhook, and only warned about without one', () => {
    expect(() => webhookTarget({ url: 'https://shop.example/hook' }, undefined)).toThrow(
      /no secret is set/,
    );
    expect(webhookTarget(undefined, SECRET).warning).toMatch(/no webhook/);
    // M7: no webhook at all is said once, as a notice (never a refusal).
    expect(webhookTarget(undefined, undefined)).toEqual({ notice: NO_WEBHOOK_NOTICE });
    expect(NO_WEBHOOK_NOTICE).toBe(
      'no webhook: paid orders reach you only through orders and the admin page',
    );
    expect(webhookTarget({ url: 'https://shop.example/hook' }, SECRET)).toEqual({
      target: { url: 'https://shop.example/hook', secret: SECRET },
    });
  });
});

describe('the webhook URL', () => {
  it('is https to a public name, unless allowInsecure says otherwise', () => {
    expect(webhookUrlProblem('https://shop.example.com/elisym/webhook', false)).toBeUndefined();
    for (const refused of [
      'http://shop.example.com/hook',
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.0.0.1/hook',
      'https://[::1]/hook',
      'https://intranet/hook',
      'https://shop.local/hook',
    ]) {
      expect(webhookUrlProblem(refused, false)).toBeDefined();
    }
    expect(webhookUrlProblem('http://127.0.0.1:8080/hook', true)).toBeUndefined();
    expect(webhookUrlProblem('https://intranet/hook', true)).toBeUndefined();
    // Never a user name or password, never another scheme, insecure or not.
    expect(webhookUrlProblem('https://user:pass@shop.example.com/hook', true)).toMatch(/user/);
    expect(webhookUrlProblem('ftp://shop.example.com/hook', true)).toBeDefined();
    expect(webhookUrlProblem('not a url', true)).toBeDefined();
  });

  it('is checked with the config, and the block takes no other key', () => {
    const config = configTemplate('devnet');
    config.payouts = config.payouts.map((payout) => ({ ...payout, address: PAYOUT }));
    expect(configProblems({ ...config, webhook: { url: 'https://shop.example.com/h' } })).toEqual(
      [],
    );
    expect(configProblems({ ...config, webhook: { url: 'http://127.0.0.1/h' } })).toEqual([
      expect.stringMatching(/^webhook\.url: must be an https:\/\/ URL/),
    ]);
    expect(
      configProblems({ ...config, webhook: { url: 'http://127.0.0.1/h', allowInsecure: true } }),
    ).toEqual([]);
    expect(
      configProblems({ ...config, webhook: { url: 'https://shop.example.com/h', events: [] } }),
    ).not.toEqual([]);
  });
});

describe('retries', () => {
  it('back off from 30 s, doubling to an hour, with at most 10 % jitter', () => {
    expect(retryPause(1, 0)).toBe(WEBHOOK_FIRST_PAUSE_SECS);
    expect(retryPause(2, 0)).toBe(WEBHOOK_FIRST_PAUSE_SECS * 2);
    expect(retryPause(5, 0)).toBe(WEBHOOK_FIRST_PAUSE_SECS * 16);
    expect(retryPause(50, 0)).toBe(WEBHOOK_MAX_PAUSE_SECS);
    expect(retryPause(1, 0.999)).toBe(WEBHOOK_FIRST_PAUSE_SECS + 2);
    expect(retryPause(50, 0.999)).toBeLessThan(WEBHOOK_MAX_PAUSE_SECS * 1.1);
  });

  it('fail for good once past the deadline, and stay pending before it', () => {
    const entry = newWebhookEntry(STORE, paidOrder(), NOW);
    applySendResult(entry, { ok: false, status: 500, error: 'HTTP 500' }, NOW, 0);
    expect(entry).toMatchObject({
      state: 'pending',
      attempts: 1,
      nextAt: NOW + 30,
      lastStatus: 500,
    });
    applySendResult(entry, { ok: false, error: 'TimeoutError' }, NOW + 40, 0);
    expect(entry).toMatchObject({ state: 'pending', attempts: 2, nextAt: NOW + 40 + 60 });
    expect(entry.lastStatus).toBeUndefined();
    applySendResult(entry, { ok: false, error: 'HTTP 500' }, entry.deadline, 0);
    expect(entry.state).toBe('failed');
  });
});

describe('the sender', () => {
  it('signs exactly what it sends, with the headers a receiver checks', async () => {
    const { url, received } = await receiver();
    const order = paidOrder({ customerRef: 'user-123' });
    const state = ledgerWith(order);
    order.webhook = newWebhookEntry(STORE, order, NOW);
    await sender(state, url).tick();
    const [request] = received;
    if (request === undefined) {
      throw new Error('nothing received');
    }
    const timestamp = String(request.headers['x-elisym-timestamp']);
    expect(timestamp).toBe(String(NOW));
    expect(
      verifies(SECRET, timestamp, request.body, String(request.headers['x-elisym-signature'])),
    ).toBe(true);
    // A forged body or another secret does not verify.
    expect(
      verifies(
        SECRET,
        timestamp,
        `${request.body} `,
        String(request.headers['x-elisym-signature']),
      ),
    ).toBe(false);
    expect(request.headers['x-elisym-event']).toBe('order.paid');
    expect(request.headers['x-elisym-event-id']).toBe(order.webhook.eventId);
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['user-agent']).toBe('elisym-merchant-node/test');
    expect(JSON.parse(request.body)).toMatchObject({
      customerRef: 'user-123',
      eventId: order.webhook.eventId,
    });
    expect(order.webhook).toMatchObject({
      state: 'sent',
      sentAt: NOW,
      attempts: 1,
      lastStatus: 200,
    });
  });

  it('retries a 500 later, never sooner', async () => {
    const { url, received } = await receiver((_request, response) => {
      response.writeHead(500).end('nope');
    });
    const order = paidOrder();
    order.webhook = newWebhookEntry(STORE, order, NOW);
    const state = ledgerWith(order);
    let now = NOW;
    const run = sender(state, url, { now: () => now });
    await run.tick();
    expect(order.webhook).toMatchObject({ state: 'pending', attempts: 1, nextAt: NOW + 30 });
    now = NOW + 29;
    await run.tick();
    expect(received).toHaveLength(1);
    now = NOW + 30;
    await run.tick();
    expect(received).toHaveLength(2);
    expect(order.webhook).toMatchObject({ attempts: 2, nextAt: NOW + 30 + 60 });
  });

  it('follows no redirect: a 3xx is a failure, and its target is never asked', async () => {
    const { url, received } = await receiver((request, response) => {
      if (request.path === '/hook') {
        response.writeHead(302, { Location: '/elsewhere' }).end();
      } else {
        response.writeHead(200).end();
      }
    });
    const order = paidOrder();
    order.webhook = newWebhookEntry(STORE, order, NOW);
    await sender(ledgerWith(order), url).tick();
    expect(received.map((request) => request.path)).toEqual(['/hook']);
    expect(order.webhook).toMatchObject({
      state: 'pending',
      attempts: 1,
      lastError: 'redirect refused',
    });
  });

  it('gives up on a receiver that does not answer in time', async () => {
    const { url } = await receiver(() => {
      // Never answers.
    });
    const order = paidOrder();
    order.webhook = newWebhookEntry(STORE, order, NOW);
    await sender(ledgerWith(order), url, { timeoutMs: 100 }).tick();
    expect(order.webhook).toMatchObject({ state: 'pending', attempts: 1 });
    expect(order.webhook.lastError).toMatch(/timeout|abort/i);
  });

  it('fails an entry past its deadline without sending it', async () => {
    const { url, received } = await receiver();
    const order = paidOrder();
    order.webhook = newWebhookEntry(STORE, order, NOW - WEBHOOK_DEADLINE_SECS);
    order.webhook.nextAt = NOW;
    await sender(ledgerWith(order), url).tick();
    expect(received).toHaveLength(0);
    expect(order.webhook.state).toBe('failed');
  });

  it('sends at most four at once, and never one entry twice at once', async () => {
    const held: ServerResponse[] = [];
    const { url, received } = await receiver((_request, response) => {
      held.push(response);
    });
    const orders = Array.from({ length: 6 }, (_unused, index) =>
      paidOrder({}, `b3a7c2d4-0000-4000-8000-00000000000${index}`),
    );
    for (const order of orders) {
      order.webhook = newWebhookEntry(STORE, order, NOW);
    }
    const run = sender(ledgerWith(...orders), url);
    const first = run.tick();
    const second = run.tick();
    await expect.poll(() => received.length).toBe(MAX_WEBHOOKS_IN_FLIGHT);
    expect(run.sending).toBe(MAX_WEBHOOKS_IN_FLIGHT);
    // The second pick found every slot taken and nothing new to start.
    await second;
    expect(received).toHaveLength(MAX_WEBHOOKS_IN_FLIGHT);
    for (const response of held.splice(0)) {
      response.writeHead(204).end();
    }
    await first;
    const third = run.tick();
    await expect.poll(() => received.length).toBe(6);
    for (const response of held.splice(0)) {
      response.writeHead(204).end();
    }
    await third;
    expect(orders.every((order) => order.webhook?.state === 'sent')).toBe(true);
    const ids = received.map((request) => request.headers['x-elisym-event-id']);
    expect(new Set(ids).size).toBe(6);
  });

  it('never sends an entry again while its first send is still out', async () => {
    const held: ServerResponse[] = [];
    const { url, received } = await receiver((_request, response) => {
      held.push(response);
    });
    const order = paidOrder();
    order.webhook = newWebhookEntry(STORE, order, NOW);
    const run = sender(ledgerWith(order), url);
    const first = run.tick();
    await expect.poll(() => received.length).toBe(1);
    // A pick while the request is out, with free slots: the entry is not taken again.
    await run.tick();
    expect(received).toHaveLength(1);
    for (const response of held.splice(0)) {
      response.writeHead(200).end();
    }
    await first;
    expect(order.webhook.state).toBe('sent');
    await run.tick();
    expect(received).toHaveLength(1);
  });

  it('never logs the secret, nor keeps it in an error', async () => {
    const logs: string[] = [];
    const saves: string[] = [];
    const { url } = await receiver((_request, response) => {
      response.writeHead(401).end(SECRET);
    });
    const order = paidOrder();
    order.webhook = newWebhookEntry(STORE, order, NOW);
    const state = ledgerWith(order);
    await sender(state, url, { logs, saves }).tick();
    expect(logs.length).toBeGreaterThan(0);
    for (const text of [...logs, ...saves]) {
      expect(text).not.toContain(SECRET);
    }
  });
});

describe('webhook retry and resend', () => {
  it('retry makes a failed or pending entry due now with a fresh deadline', () => {
    const order = paidOrder();
    order.webhook = newWebhookEntry(STORE, order, T0);
    order.webhook.state = 'failed';
    order.webhook.attempts = 40;
    order.webhook.lastError = 'HTTP 500';
    const state = ledgerWith(order);
    const plan = rearmWebhook(state, order.key, 'retry', STORE, NOW);
    expect(plan.ok).toBe(true);
    expect(order.webhook).toEqual({
      state: 'pending',
      eventId: webhookEventId(STORE, order.key, SIG),
      createdAt: NOW,
      deadline: NOW + WEBHOOK_DEADLINE_SECS,
      attempts: 0,
      nextAt: NOW,
    });
  });

  it('retry refuses a sent entry and an order without one; resend writes one for any paid order', () => {
    const sent = paidOrder();
    sent.webhook = { ...newWebhookEntry(STORE, sent, T0), state: 'sent', sentAt: T0 };
    const before = paidOrder({}, 'b3a7c2d4-0000-4000-8000-000000000009');
    const unpaid = paidOrder({ paid: undefined }, 'b3a7c2d4-0000-4000-8000-000000000008');
    const state = ledgerWith(sent, before, unpaid);
    state.answeredByHand = {
      [`${BUYER}:hand`]: { kind: 'delivered', reportedTxs: [], refusedTxs: [], noLegTxs: [] },
    };
    expect(rearmWebhook(state, sent.key, 'retry', STORE, NOW)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/resend/),
    });
    expect(rearmWebhook(state, before.key, 'retry', STORE, NOW)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/resend/),
    });
    expect(rearmWebhook(state, unpaid.key, 'resend', STORE, NOW)).toMatchObject({ ok: false });
    expect(rearmWebhook(state, `${BUYER}:hand`, 'resend', STORE, NOW)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/by hand/),
    });
    expect(rearmWebhook(state, `${BUYER}:missing`, 'resend', STORE, NOW).ok).toBe(false);
    // Resend: the same event id as the first send, so a receiver dedupes it.
    const resent = rearmWebhook(state, sent.key, 'resend', STORE, NOW);
    expect(resent.ok).toBe(true);
    expect(sent.webhook).toMatchObject({
      state: 'pending',
      eventId: webhookEventId(STORE, sent.key, SIG),
    });
    expect(rearmWebhook(state, before.key, 'resend', STORE, NOW).ok).toBe(true);
    expect(before.webhook?.eventId).toBe(webhookEventId(STORE, before.key, SIG));
  });
});

describe('the orders listing', () => {
  it('shows the ref printable and cut, the webhook state and the event id', () => {
    const withRef = paidOrder({ customerRef: 'user-123' });
    withRef.webhook = newWebhookEntry(STORE, withRef, NOW);
    const without = paidOrder({}, 'b3a7c2d4-0000-4000-8000-000000000002');
    const open = paidOrder({ paid: undefined }, 'b3a7c2d4-0000-4000-8000-000000000003');
    const state = ledgerWith(withRef, without, open);
    state.answeredByHand = {
      [`${BUYER}:hand`]: {
        kind: 'delivered',
        customerRef: 'user-9',
        reportedTxs: [],
        refusedTxs: [],
        noLegTxs: [],
      },
    };
    const lines = orderLines(state, STORE);
    expect(lines[0]).toContain(
      `ref=user-123 webhook=pending event=${webhookEventId(STORE, withRef.key, SIG)}`,
    );
    expect(lines[1]).toContain(`webhook=none event=${webhookEventId(STORE, without.key, SIG)}`);
    expect(lines[1]).not.toContain('ref=');
    expect(lines[2]).not.toContain('webhook=');
    expect(lines.at(-1)).toBe(`answered by hand: ${BUYER}:hand completed ref=user-9`);
    expect(shownRef('a'.repeat(40))).toBe(`${'a'.repeat(21)}...`);
    expect(shownRef('bad\u001b[2Jref')).toBe('bad?[2Jref');
  });
});

describe('the customer reference', () => {
  it('is taken in with the order, and a bad one is dropped even past the parser', () => {
    const { state, store, identity } = world();
    const buyer = key();
    const good = orderFrom(buyer, store, ORDER_ID);
    const taken = intake(
      state,
      { ...good, message: { ...good.message, customerRef: 'user-123' } as typeof good.message },
      identity,
    );
    expect(taken).toMatchObject({
      kind: 'order',
      order: { customerRef: 'user-123', product: productAt(store) },
    });
    const bad = orderFrom(buyer, store, 'b3a7c2d4-0000-4000-8000-000000000002');
    const dropped = intake(
      state,
      { ...bad, message: { ...bad.message, customerRef: 'user 1"; DROP' } as typeof bad.message },
      identity,
    );
    expect(dropped.kind).toBe('order');
    expect(dropped.kind === 'order' && 'customerRef' in dropped.order).toBe(false);
  });

  it('stays with a hand answer', () => {
    const { state } = world();
    const order = paidOrder({ paid: undefined, customerRef: 'user-123' });
    state.orders[order.key] = order;
    const plan = planHandAnswer(state, order.key, { kind: 'delivered' });
    expect(plan).toMatchObject({ ok: true, answer: { customerRef: 'user-123' } });
  });
});

describe('a failure reason', () => {
  const URL_WITH_TOKEN = 'https://shop.example.com/hook?token=TOPSECRET';

  it('says only "redirect refused" for a redirect, as Bun and Node word it', () => {
    const bun = Object.assign(
      new Error(`UnexpectedRedirect fetching "${URL_WITH_TOKEN}". For more information`),
      { code: 'UnexpectedRedirect' },
    );
    const node = new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    expect(failureText(bun, URL_WITH_TOKEN)).toBe('redirect refused');
    expect(failureText(node, URL_WITH_TOKEN)).toBe('redirect refused');
  });

  it('keeps no more of the URL than its origin', () => {
    const quoting = new Error(`Unable to connect to "${URL_WITH_TOKEN}"`);
    const text = failureText(quoting, URL_WITH_TOKEN);
    expect(text).not.toContain('TOPSECRET');
    expect(text).not.toContain('/hook');
    expect(text).toContain('https://shop.example.com');
    // A URL the parser respells (a default port) is caught in its parsed spelling too.
    const respelled = 'https://shop.example.com:443/hook?token=TOPSECRET';
    expect(
      failureText(new Error(`at https://shop.example.com/hook?token=TOPSECRET`), respelled),
    ).not.toContain('TOPSECRET');
  });
});

describe('sending once', () => {
  it("keeps no token of the URL from an error that quotes it (as Bun's do)", async () => {
    const url = 'https://shop.example.com/hook?token=TOPSECRET';
    const result = await sendWebhook(
      { url, secret: SECRET },
      { name: 'test', eventId: 'e', body: '{}' },
      {
        now: () => NOW,
        userAgent: 'test',
        fetch: () => Promise.reject(new Error(`Unable to connect to "${url}"`)),
      },
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.error).not.toContain('TOPSECRET');
    expect(result.ok ? '' : result.error).toContain('https://shop.example.com');
  });

  it('reports a refused connection as a failure, not a throw', async () => {
    const result = await sendWebhook(
      { url: 'http://127.0.0.1:9/hook', secret: SECRET },
      { name: 'test', eventId: 'e', body: '{}' },
      { now: () => NOW, userAgent: 'test', timeoutMs: 2_000 },
    );
    expect(result.ok).toBe(false);
  });
});

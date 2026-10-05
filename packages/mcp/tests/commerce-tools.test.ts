import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type OrderMessage,
  buildOrderMessage,
  buildPaytoEvent,
  buildProductEvent,
  wrapOrderMessage,
} from '@elisym/commerce';
import { type OrderRecord, MemoryOrderBackend } from '@elisym/commerce/buyer';
import { USDC_SOLANA_DEVNET } from '@elisym/pay-core';
import { NATIVE_SOL, assetKey, generateSolanaWallet } from '@elisym/sdk';
import { getBase58Encoder } from '@solana/kit';
import type { NostrEvent } from 'nostr-tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  D,
  DAY,
  MemoryRelays,
  NOW,
  type Shop,
  T0,
  USDC_DEVNET_CAIP19,
  USDC_MAINNET_CAIP19,
  inboxList,
  makeShop,
  sign,
} from '../../commerce/tests/buyer/fixtures';
import { FakeSolana } from '../../commerce/tests/buyer/solana-fixtures';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { defaultSpendLimitsMap } from '../src/session-limits.js';
import { FileOrderBackend } from '../src/storage/orders.js';
import {
  commerceRuntime,
  commerceTools,
  releaseCosts,
  reserveCosts,
} from '../src/tools/commerce.js';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const original = { ...commerceRuntime };

function tool(name: string) {
  const found = commerceTools.find((each) => each.name === name);
  if (found === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return found;
}

function text(result: { content: { text: string }[] }): string {
  const joined = result.content.map((part) => part.text).join('\n');
  // Every value is rendered: no object ever reaches the model as "[object Object]".
  expect(joined).not.toContain('[object Object]');
  return joined;
}

interface World {
  ctx: AgentContext;
  agent: AgentInstance;
  shop: Shop;
  relays: MemoryRelays;
  chain: FakeSolana;
  /** The events every relay holds; a test may add to it. */
  events: NostrEvent[];
}

async function world(
  options: { network?: 'devnet' | 'mainnet'; agentDir?: boolean } = {},
): Promise<World> {
  const network = options.network ?? 'devnet';
  const shop = makeShop(network === 'mainnet' ? { caip19: USDC_MAINNET_CAIP19 } : {});
  const events = [...shop.events, inboxList(shop.store, INBOX)];
  const relays = new MemoryRelays(events);
  const wallet = await generateSolanaWallet();
  const chain = new FakeSolana(wallet.signer.address, shop.payout);
  chain.blockTime = NOW + 60;
  const root = mkdtempSync(join(tmpdir(), 'elisym-commerce-'));
  const agentDir = join(root, 'buyer');
  mkdirSync(agentDir);
  const agent = {
    client: {} as never,
    identity: {} as never,
    name: 'buyer',
    network,
    security: {},
    ...(options.agentDir === false ? {} : { agentDir }),
    solanaKeypair: {
      publicKey: wallet.signer.address,
      secretKey: new Uint8Array(getBase58Encoder().encode(wallet.secretKeyBase58)),
    },
  } as AgentInstance;
  const ctx = new AgentContext();
  ctx.sessionSpendLimits = defaultSpendLimitsMap();
  ctx.register(agent);
  Object.assign(commerceRuntime, {
    relayClient: () => relays,
    solanaRpc: () => chain.rpc,
    purchaseRpc: async () => ({ url: 'fake', canProveOver: true }),
    judgeStorage: async () => ({ durable: true }),
    guardedFetch: () => fetch,
    now: () => NOW + 30,
    buyBudgetMs: 200,
    followBudgetMs: 200,
    watchEveryMs: 20,
  });
  return { ctx, agent, shop, relays, chain, events };
}

async function quoteId(run: World): Promise<{ id: string; warnings: string[]; body: string }> {
  const result = await tool('buy_product').handler(run.ctx, { product: run.shop.naddr });
  const body = text(result as never);
  const id = /quote_id: ([0-9a-f-]{36})/.exec(body)?.[1];
  if (id === undefined) {
    throw new Error(body);
  }
  const warnings = [...body.matchAll(/confirmation \(([a-z_]+)\)/g)].map(
    (match) => match[1] as string,
  );
  return { id, warnings, body };
}

async function orders(run: World): Promise<OrderRecord[]> {
  return new FileOrderBackend(run.agent.agentDir as string, { durable: false }).list();
}

async function storeDelivers(run: World, record: OrderRecord, message: Partial<OrderMessage> = {}) {
  const status = {
    type: 'status',
    buyerPubkey: record.buyerPubkey,
    orderId: record.orderId,
    status: 'completed',
    delivery: { method: 'access', value: 'https://shop.example/course' },
    ...message,
  } as OrderMessage;
  await run.relays.publish(
    INBOX,
    wrapOrderMessage(
      buildOrderMessage(status, NOW + 100),
      run.shop.store.secretKey,
      record.buyerPubkey,
    ).recipientWrap,
  );
}

beforeEach(() => {
  Object.assign(commerceRuntime, original);
});
afterEach(() => {
  Object.assign(commerceRuntime, original);
});

describe('buy_product', () => {
  it('quotes the exact terms and orders nothing', async () => {
    const run = await world();
    const quote = await quoteId(run);
    expect(quote.body).toContain('nothing was ordered or paid');
    expect(quote.body).toContain(run.shop.payout);
    expect(quote.body).toContain('Trust level');
    expect(await orders(run)).toEqual([]);
    expect(run.chain.sent).toEqual([]);
  });

  it('buys only with every warning of the quote confirmed, once per quote', async () => {
    const run = await world();
    const quote = await quoteId(run);
    if (quote.warnings.length > 0) {
      const partial = await tool('buy_product').handler(run.ctx, {
        quote_id: quote.id,
        accept_warnings: [],
      });
      expect((partial as { isError?: boolean }).isError).toBe(true);
      expect(await orders(run)).toEqual([]);
    }
    const bought = await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    expect(text(bought as never)).toMatch(/paid|confirming|Delivered/);
    expect(new Set(run.chain.sent).size).toBe(1);
    expect(run.chain.landed.size).toBe(1);
    const [record] = await orders(run);
    // The attempt recorded is the transaction that landed.
    expect(run.chain.landed.has(record?.paidTx ?? record?.marker?.signature ?? '')).toBe(true);
    // The quote is spent: the same id never buys again.
    const again = await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    expect(text(again as never)).toContain('Unknown or expired quote_id');
    expect(new Set(run.chain.sent).size).toBe(1);
  });

  it('counts the payment against the session limits', async () => {
    const run = await world();
    const quote = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    const spent = [...run.ctx.sessionSpent.values()].reduce((sum, value) => sum + value, 0n);
    expect(spent).toBeGreaterThan(0n);
  });

  it('settles a landed attempt: its reservation can no longer be given back', async () => {
    const run = await world();
    const quote = await quoteId(run);
    let attemptId: string | undefined;
    run.chain.onSend = async () => {
      const [record] = await orders(run);
      attemptId = record?.marker?.attemptId;
    };
    await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    expect(attemptId).toBeDefined();
    // A slow run may end the buy before the payment is seen: following the
    // order again (as get_order does) settles it the same way.
    let [record] = await orders(run);
    for (let tries = 0; tries < 50 && record?.paidTx === undefined; tries++) {
      await tool('get_order').handler(run.ctx, { order_id: record?.orderId });
      [record] = await orders(run);
    }
    expect(record?.paidTx).toBeDefined();
    const before = new Map(run.ctx.sessionSpent);
    releaseCosts(run.ctx, attemptId ?? '', true);
    expect(run.ctx.sessionSpent).toEqual(before);
  }, 20_000);

  describe('spend warnings', () => {
    // Once reserved, the payment is the whole cap: every warning is due. A
    // store that delivers ends the follow at once, so no case waits out its budget.
    async function buyAtTheCap(options: { lands: boolean; delivered: boolean }) {
      const run = await world();
      const quote = await quoteId(run);
      run.chain.dropSends = !options.lands;
      commerceRuntime.buyBudgetMs = options.delivered ? 10_000 : 200;
      run.chain.onSend = async () => {
        run.ctx.sessionSpendLimits = new Map(run.ctx.sessionSpent);
        if (options.delivered) {
          const [record] = await orders(run);
          await storeDelivers(run, record as OrderRecord);
        }
      };
      const bought = await tool('buy_product').handler(run.ctx, {
        quote_id: quote.id,
        accept_warnings: quote.warnings,
      });
      return { run, body: text(bought as never) };
    }

    it('keeps them for a payment never seen on chain', async () => {
      const unseen = await buyAtTheCap({ lands: false, delivered: false });
      expect(unseen.body).not.toContain('Warning: session spend');
      expect(
        [...unseen.run.ctx.sessionSpendWarnings.values()].every((fired) => fired.size === 0),
      ).toBe(true);
    });

    it('uses them, token and SOL, for a payment that landed', async () => {
      const landed = await buyAtTheCap({ lands: true, delivered: true });
      expect(landed.body).toContain('Warning: session spend reached 50%');
      expect(landed.body).toContain('Warning: session spend reached 50% of the SOL cap');
    }, 20_000);

    it('uses them for a delivery that came before the payment was seen', async () => {
      const delivered = await buyAtTheCap({ lands: false, delivered: true });
      expect(delivered.body).toContain('Warning: session spend reached 50%');
    }, 20_000);
  });

  it('refuses over the spend limit before anything is recorded', async () => {
    const run = await world();
    run.ctx.sessionSpendLimits = new Map([...run.ctx.sessionSpendLimits].map(([key]) => [key, 1n]));
    const quote = await quoteId(run);
    const refused = await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    expect(text(refused as never)).toContain('spend limit');
    expect(run.chain.sent).toEqual([]);
    const [record] = await orders(run);
    expect(record?.state).toBe('ordered');
    expect(record?.marker).toBeUndefined();
  });

  it('shows a delivery already bought instead of paying again, unless asked to buy again', async () => {
    const run = await world();
    const first = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: first.id,
      accept_warnings: first.warnings,
    });
    const [record] = await orders(run);
    await storeDelivers(run, record as OrderRecord);
    const followed = await tool('get_order').handler(run.ctx, { order_id: record?.orderId });
    expect(text(followed as never)).toContain('shop.example/course');
    const second = await quoteId(run);
    const shown = await tool('buy_product').handler(run.ctx, {
      quote_id: second.id,
      accept_warnings: second.warnings,
    });
    expect(text(shown as never)).toContain('already bought');
    expect(new Set(run.chain.sent).size).toBe(1);
  });

  it('refuses a mainnet purchase on storage that cannot keep a payment record', async () => {
    const run = await world({ network: 'mainnet' });
    commerceRuntime.judgeStorage = async () => ({
      durable: false,
      reason: 'a virtiofs filesystem',
    });
    const quote = await quoteId(run);
    const refused = await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    expect(text(refused as never)).toContain('virtiofs');
    expect(await orders(run)).toEqual([]);
    expect(run.chain.sent).toEqual([]);
  });

  it('refuses warnings the quote did not name', async () => {
    const run = await world();
    const quote = await quoteId(run);
    const refused = await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: [...quote.warnings, 'domain_unverified'],
    });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(await orders(run)).toEqual([]);
  });

  it('refuses an email the checkout widget would not send, before ordering', async () => {
    const run = await world();
    const quote = await quoteId(run);
    for (const email of [
      'alice at example.com',
      'alice@example',
      'a@b.com\nBcc: x@y.com',
      `${'a'.repeat(65)}@example.com`,
    ]) {
      const refused = await tool('buy_product').handler(run.ctx, {
        quote_id: quote.id,
        accept_warnings: quote.warnings,
        email,
      });
      expect((refused as { isError?: boolean }).isError).toBe(true);
    }
    expect(await orders(run)).toEqual([]);
    expect(run.chain.sent).toEqual([]);
  });

  it('refuses to buy when the terms changed since the quote', async () => {
    const run = await world();
    const quote = await quoteId(run);
    run.events.push(
      sign(
        buildProductEvent({
          d: D,
          title: 'Agents 101',
          description: 'Twelve lessons.',
          price: { amount: '59', currency: 'USD' },
          accept: [USDC_DEVNET_CAIP19],
          createdAt: T0 + 1,
        }),
        run.shop.store,
      ),
    );
    const refused = await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    expect(text(refused as never)).toMatch(/changed/i);
    expect(await orders(run)).toEqual([]);
    expect(run.chain.sent).toEqual([]);
  });

  it('spends a quote once even when two calls with it run at once', async () => {
    const run = await world();
    for (const [key, limit] of run.ctx.sessionSpendLimits) {
      run.ctx.sessionSpendLimits.set(key, limit * 1000n);
    }
    const quote = await quoteId(run);
    const call = () =>
      tool('buy_product').handler(run.ctx, {
        quote_id: quote.id,
        accept_warnings: quote.warnings,
        buy_again: true,
      });
    // The store delivers as soon as a payment is under way: the first call ends
    // with a completed order, which buy_again would otherwise buy past.
    let stop = false;
    const delivered = new Set<string>();
    async function deliverEachPayment() {
      while (!stop) {
        for (const record of await orders(run)) {
          if (!delivered.has(record.orderId) && record.marker !== undefined) {
            delivered.add(record.orderId);
            await storeDelivers(run, record);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const deliverer = deliverEachPayment();
    const results = await Promise.all([call(), call()]);
    stop = true;
    await deliverer;
    expect(results.map((result) => text(result as never)).join('\n')).toContain(
      'Unknown or expired quote_id',
    );
    expect(await orders(run)).toHaveLength(1);
    expect(new Set(run.chain.sent).size).toBe(1);
  });

  it('ends an expired attempt whose terms changed, then buys on the new quote', async () => {
    const run = await world();
    for (const [key, limit] of run.ctx.sessionSpendLimits) {
      run.ctx.sessionSpendLimits.set(key, limit * 1000n);
    }
    run.chain.dropSends = true;
    const first = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: first.id,
      accept_warnings: first.warnings,
    });
    const [stuck] = await orders(run);
    expect(stuck?.state).toBe('paying');
    run.chain.expire();
    run.chain.nextBlockhash();
    run.chain.dropSends = false;
    run.events.push(
      sign(
        buildProductEvent({
          d: D,
          title: 'Agents 101',
          description: 'Twelve lessons.',
          price: { amount: '59', currency: 'USD' },
          accept: [USDC_DEVNET_CAIP19],
          createdAt: T0 + 1,
        }),
        run.shop.store,
      ),
    );
    const second = await quoteId(run);
    const bought = await tool('buy_product').handler(run.ctx, {
      quote_id: second.id,
      accept_warnings: second.warnings,
    });
    expect(text(bought as never)).toMatch(/paid|confirming/);
    const after = await orders(run);
    expect(after.find((record) => record.orderId === stuck?.orderId)?.state).toBe('ended-unpaid');
    expect(after).toHaveLength(2);
    expect(run.chain.landed.size).toBe(1);
  });

  it("settles an order on the order's own network after the agent's network changed", async () => {
    const run = await world();
    run.chain.dropSends = true;
    const quote = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    const [record] = await orders(run);
    run.chain.expire();
    // Only devnet has a full-history endpoint here; the agent now runs on mainnet.
    commerceRuntime.purchaseRpc = async (network) => ({
      url: 'fake',
      canProveOver: network === 'devnet',
    });
    run.agent.network = 'mainnet';
    const followed = await tool('get_order').handler(run.ctx, { order_id: record?.orderId });
    expect(text(followed as never)).toContain('expired and nothing was paid');
  });

  it('ends an order that can no longer be paid in time, so the next quote places a new one', async () => {
    const run = await world();
    run.chain.lamports = 0n;
    const first = await quoteId(run);
    const unfunded = await tool('buy_product').handler(run.ctx, {
      quote_id: first.id,
      accept_warnings: first.warnings,
    });
    expect(text(unfunded as never)).toContain('Not enough SOL');
    const [old] = await orders(run);
    expect(old?.state).toBe('ordered');
    // Three days on: too late to pay that order before the store stops watching.
    run.chain.lamports = 1_000_000_000n;
    const later = NOW + 3 * DAY;
    commerceRuntime.now = () => later + 30;
    run.chain.blockTime = later + 60;
    const second = await quoteId(run);
    const ended = await tool('buy_product').handler(run.ctx, {
      quote_id: second.id,
      accept_warnings: second.warnings,
    });
    expect(text(ended as never)).toContain('it was ended and nothing was paid');
    expect((await orders(run))[0]?.state).toBe('ended-unpaid');
    const third = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: third.id,
      accept_warnings: third.warnings,
    });
    const after = await orders(run);
    expect(after).toHaveLength(2);
    expect(run.chain.landed.size).toBe(1);
  });

  it("ends an attempt proven over on the agent's old network and buys on the new one", async () => {
    const run = await world();
    for (const [key, limit] of run.ctx.sessionSpendLimits) {
      run.ctx.sessionSpendLimits.set(key, limit * 1000n);
    }
    run.chain.dropSends = true;
    const first = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: first.id,
      accept_warnings: first.warnings,
    });
    const [stuck] = await orders(run);
    expect(stuck?.state).toBe('paying');
    run.chain.expire();
    run.chain.nextBlockhash();
    run.chain.dropSends = false;
    const both = [USDC_DEVNET_CAIP19, USDC_MAINNET_CAIP19];
    run.events.push(
      sign(
        buildProductEvent({
          d: D,
          title: 'Agents 101',
          description: 'Twelve lessons.',
          price: { amount: '49', currency: 'USD' },
          accept: both,
          createdAt: T0 + 1,
        }),
        run.shop.store,
      ),
      sign(
        buildPaytoEvent({
          ownerPubkey: run.shop.owner.pubkey,
          accept: both.map((caip19) => ({ caip19, address: run.shop.payout })),
          createdAt: T0 + 1,
        }),
        run.shop.owner,
      ),
    );
    run.agent.network = 'mainnet';
    const second = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: second.id,
      accept_warnings: second.warnings,
    });
    const after = await orders(run);
    expect(after.find((record) => record.orderId === stuck?.orderId)?.state).toBe('ended-unpaid');
    expect(after).toHaveLength(2);
    expect(run.chain.landed.size).toBe(1);
  });

  it('shows why an offer was refused as untrusted data', async () => {
    const run = await world();
    run.events.splice(0, run.events.length);
    const refused = await tool('buy_product').handler(run.ctx, { product: run.shop.naddr });
    expect(text(refused as never)).toContain('UNTRUSTED');
  });

  it('refuses for an ephemeral agent', async () => {
    const run = await world({ agentDir: false });
    const refused = await tool('buy_product').handler(run.ctx, { product: run.shop.naddr });
    expect(text(refused as never)).toContain('ephemeral');
  });
});

describe('get_order', () => {
  it('lists the orders, their titles as data', async () => {
    const run = await world();
    const empty = await tool('get_order').handler(run.ctx, {});
    expect(text(empty as never)).toContain('no orders');
    const quote = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    const listed = await tool('get_order').handler(run.ctx, {});
    expect(text(listed as never)).toContain('store-provided data');
  });
});

void MemoryOrderBackend;

describe('the spend reservations of a payment attempt', () => {
  function spent(ctx: AgentContext) {
    return {
      token: ctx.sessionSpent.get(assetKey(USDC_SOLANA_DEVNET)) ?? 0n,
      lamports: ctx.sessionSpent.get(assetKey(NATIVE_SOL)) ?? 0n,
    };
  }

  it('gives back an attempt once: all of it before a broadcast, all but the fee once proven over', () => {
    const ctx = new AgentContext();
    ctx.sessionSpendLimits = defaultSpendLimitsMap();
    const costs = {
      asset: USDC_SOLANA_DEVNET,
      tokenAmount: 1_000n,
      lamports: 5_000n,
      feeLamports: 700n,
    };
    reserveCosts(ctx, costs, 'a');
    reserveCosts(ctx, costs, 'b');
    releaseCosts(ctx, 'a', true);
    expect(spent(ctx)).toEqual({ token: 1_000n, lamports: 5_000n });
    // A second release of the same attempt gives back nothing more.
    releaseCosts(ctx, 'a', true);
    expect(spent(ctx)).toEqual({ token: 1_000n, lamports: 5_000n });
    // Proven over: only the fee stays counted (a failed transaction spent it).
    releaseCosts(ctx, 'b', false);
    expect(spent(ctx)).toEqual({ token: 0n, lamports: 700n });
  });

  it('gives back the price of a native SOL attempt proven over', () => {
    const ctx = new AgentContext();
    ctx.sessionSpendLimits = defaultSpendLimitsMap();
    reserveCosts(
      ctx,
      { asset: NATIVE_SOL, tokenAmount: 0n, lamports: 50_005_000n, feeLamports: 5_000n },
      'a',
    );
    releaseCosts(ctx, 'a', false);
    expect(spent(ctx).lamports).toBe(5_000n);
  });
});

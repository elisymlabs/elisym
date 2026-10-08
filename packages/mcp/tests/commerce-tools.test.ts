import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type OrderMessage,
  buildOrderMessage,
  buildPaytoEvent,
  buildProductEvent,
  buildStoreProfileEvent,
  wrapOrderMessage,
} from '@elisym/commerce';
import {
  type OrderRecord,
  MemoryOrderBackend,
  OrderStore,
  applyStatus,
} from '@elisym/commerce/buyer';
import { FeeConfigError, USDC_SOLANA_DEVNET } from '@elisym/pay-core';
import { NATIVE_SOL, assetKey, generateSolanaWallet } from '@elisym/sdk';
import { address, getBase58Encoder } from '@solana/kit';
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
  solanaAddress,
} from '../../commerce/tests/buyer/fixtures';
import { FakeSolana } from '../../commerce/tests/buyer/solana-fixtures';
import { getConfigEncoder } from '../../config-client/src/generated/accounts/config';
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
    feeTerms: async () => ({ feeBps: 0, treasury: '' }),
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

/**
 * The store's status for `record`, stored as the agent's listener stores it once
 * heard: written here so no test waits on a follow budget to hear it.
 */
async function storeCompletes(
  run: World,
  record: OrderRecord,
  message: Partial<OrderMessage> = {},
): Promise<OrderRecord> {
  const status = {
    type: 'status',
    buyerPubkey: record.buyerPubkey,
    orderId: record.orderId,
    status: 'completed',
    ...message,
  } as Parameters<typeof applyStatus>[2];
  const agentStore = new OrderStore(
    new FileOrderBackend(run.agent.agentDir as string, { durable: false }),
  );
  const applied = await applyStatus(agentStore, record.orderId, status, NOW + 100);
  if (applied?.state !== 'completed') {
    throw new Error(`not completed: ${applied?.state ?? 'no record'}`);
  }
  return applied;
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

  it('says a purchase is complete instead of paying again, unless asked to buy again', async () => {
    const run = await world();
    const first = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: first.id,
      accept_warnings: first.warnings,
    });
    const record = await paidOrder(run);
    await storeCompletes(run, record);
    const followed = text(
      (await tool('get_order').handler(run.ctx, { order_id: record.orderId })) as never,
    );
    expect(followed).toContain(`Payment complete (order ${record.orderId})`);
    const second = await quoteId(run);
    const shown = text(
      (await tool('buy_product').handler(run.ctx, {
        quote_id: second.id,
        accept_warnings: second.warnings,
      })) as never,
    );
    expect(shown).toContain(`Payment complete (order ${record.orderId})`);
    expect(shown).toContain(
      `This agent already completed a purchase of this product (order ${record.orderId}). To buy it again, call buy_product with buy_again: true.`,
    );
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

  function stopListing(run: Awaited<ReturnType<typeof world>>): void {
    run.events.push(
      sign(
        buildProductEvent({
          d: D,
          title: 'Agents 101',
          description: 'Twelve lessons.',
          price: { amount: '49', currency: 'USD' },
          accept: [USDC_DEVNET_CAIP19],
          visibility: 'sold-out',
          createdAt: T0 + 1,
        }),
        run.shop.store,
      ),
    );
  }

  it('quotes a sold-out product as sold out, without the store text, ordering nothing', async () => {
    const run = await world();
    stopListing(run);
    const refused = await tool('buy_product').handler(run.ctx, { product: run.shop.naddr });
    const shown = text(refused as never);
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(shown).toContain('This product is sold out');
    expect(shown).not.toContain('The listing is sold-out');
    expect(shown).not.toContain('store-provided');
    expect(await orders(run)).toEqual([]);
  });

  it('a product sold out since the quote: nothing ordered or paid', async () => {
    const run = await world();
    const quote = await quoteId(run);
    stopListing(run);
    const refused = await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    const shown = text(refused as never);
    expect(shown).toContain('sold out since the quote');
    expect(shown).toContain('Do not retry.');
    expect(shown).not.toContain('The listing is sold-out');
    expect(await orders(run)).toEqual([]);
    expect(run.chain.sent).toEqual([]);
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

/** The completed order's own look-up answers `answer`; the payment watch reads the chain as is. */
function lookupAnswers(run: World, answer: () => Promise<unknown>) {
  const state = { reads: 0, configs: [] as unknown[] };
  const rpc = new Proxy(run.chain.rpc, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== 'getSignatureStatuses' || typeof value !== 'function') {
        return value;
      }
      return (signatures: string[], config: unknown) => {
        const real = value(signatures, config) as { send(options?: unknown): Promise<unknown> };
        return {
          send: (options?: { abortSignal?: AbortSignal }) => {
            // Only the completed order's look-up carries a timeout (the watch's reads do not).
            if (options?.abortSignal === undefined) {
              return real.send(options);
            }
            state.reads += 1;
            state.configs.push(config);
            return answer();
          },
        };
      };
    },
  });
  commerceRuntime.solanaRpc = () => rpc as never;
  return state;
}

/** A purchase whose payment this agent never saw land: the store completed it first. */
async function completedUnseen(run: World): Promise<OrderRecord> {
  run.chain.indexLag = true;
  const quote = await quoteId(run);
  await tool('buy_product').handler(run.ctx, {
    quote_id: quote.id,
    accept_warnings: quote.warnings,
  });
  const [record] = await orders(run);
  if (record?.marker?.rail !== 'solana' || record.marker.signature === undefined) {
    throw new Error('no signed attempt');
  }
  expect(record.paidTx).toBeUndefined();
  return storeCompletes(run, record);
}

const NEUTRAL = (orderId: string) => `Order ${orderId} completed by the store.`;

/**
 * A bought order with its payment recorded, as the watch records it once it
 * sees the landed transaction: written here so no test waits on the watch's timing.
 */
async function paidOrder(run: World): Promise<OrderRecord> {
  const [record] = await orders(run);
  const signature = record?.marker?.rail === 'solana' ? record.marker.signature : undefined;
  if (record === undefined || signature === undefined || !run.chain.landed.has(signature)) {
    throw new Error('no landed attempt');
  }
  if (record.paidTx !== undefined) {
    return record;
  }
  const paidStore = new OrderStore(
    new FileOrderBackend(run.agent.agentDir as string, { durable: false }),
  );
  const written = await paidStore.update(record.orderId, record.version, {
    state: 'paid',
    paidTx: signature,
    paidAt: NOW + 40,
  });
  if (!written.ok) {
    throw new Error(`paid not written: ${written.reason}`);
  }
  return written.record;
}

describe('a completed order, in words (D6, rev 4 #1, rev 5 #1)', () => {
  for (const [name, status, expected] of [
    ['confirmed, no error', { err: null, confirmationStatus: 'confirmed' }, 'complete'],
    ['finalized, no error', { err: null, confirmationStatus: 'finalized' }, 'complete'],
    ['confirmed with an error', { err: { failed: 1 }, confirmationStatus: 'confirmed' }, 'none'],
    ['finalized with an error', { err: { failed: 1 }, confirmationStatus: 'finalized' }, 'none'],
    ['unknown to the chain', null, 'neutral'],
    ['only processed', { err: null, confirmationStatus: 'processed' }, 'neutral'],
    ['processed with an error', { err: { failed: 1 }, confirmationStatus: 'processed' }, 'neutral'],
  ] as const) {
    it(`its own transaction ${name} (M29, M33)`, async () => {
      const run = await world();
      const record = await completedUnseen(run);
      const probe = lookupAnswers(run, async () => ({ value: [status] }));
      const said = text(
        (await tool('get_order').handler(run.ctx, { order_id: record.orderId })) as never,
      );
      expect(probe.reads).toBe(1);
      // Searched in the full history, as the checkout and the payment watch do (L2).
      expect(probe.configs).toEqual([{ searchTransactionHistory: true }]);
      if (expected === 'complete') {
        expect(said).toContain(`Payment complete (order ${record.orderId})`);
      } else if (expected === 'none') {
        expect(said).toContain(
          `Order ${record.orderId} completed by the store; no payment recorded.`,
        );
      } else {
        expect(said).toContain(NEUTRAL(record.orderId));
        expect(said).not.toContain('no payment');
        expect(said).not.toContain('Payment complete');
      }
    });
  }

  it('a look-up that throws is neutral', async () => {
    const run = await world();
    const record = await completedUnseen(run);
    const probe = lookupAnswers(run, async () => {
      throw new Error('node down');
    });
    const said = text(
      (await tool('get_order').handler(run.ctx, { order_id: record.orderId })) as never,
    );
    expect(probe.reads).toBe(1);
    expect(said).toContain(NEUTRAL(record.orderId));
    expect(said).not.toContain('no payment');
  });

  it('no RPC of the order’s own network: neutral, with no look-up made', async () => {
    const run = await world();
    const record = await completedUnseen(run);
    const probe = lookupAnswers(run, async () => ({ value: [null] }));
    // The agent runs on mainnet now, and no devnet endpoint can be reached.
    run.agent.network = 'mainnet';
    commerceRuntime.purchaseRpc = async (network) => {
      if (network === 'devnet') {
        throw new Error('no devnet endpoint');
      }
      return { url: 'fake', canProveOver: false };
    };
    const said = text(
      (await tool('get_order').handler(run.ctx, { order_id: record.orderId })) as never,
    );
    expect(probe.reads).toBe(0);
    expect(said).toContain(NEUTRAL(record.orderId));
    expect(said).not.toContain('no payment');
  });

  it('a payment this agent saw land: complete, with no look-up', async () => {
    const run = await world();
    const quote = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    const record = await paidOrder(run);
    expect(record.paidTx).toBeDefined();
    await storeCompletes(run, record);
    const probe = lookupAnswers(run, async () => ({ value: [null] }));
    const said = text(
      (await tool('get_order').handler(run.ctx, { order_id: record.orderId })) as never,
    );
    expect(probe.reads).toBe(0);
    expect(said).toContain(`Payment complete (order ${record.orderId})`);
  });

  it('completed by hand with no attempt at all: no payment recorded, with no look-up', async () => {
    const run = await world();
    run.chain.lamports = 0n;
    const quote = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    const [record] = await orders(run);
    expect(record?.state).toBe('ordered');
    expect(record?.marker).toBeUndefined();
    await storeCompletes(run, record as OrderRecord);
    const probe = lookupAnswers(run, async () => ({ value: [null] }));
    const said = text(
      (await tool('get_order').handler(run.ctx, { order_id: record?.orderId })) as never,
    );
    expect(probe.reads).toBe(0);
    expect(said).toContain(`Order ${record?.orderId} completed by the store; no payment recorded.`);
  });

  it('never outputs a delivery an older store node sent (M19)', async () => {
    const run = await world();
    const quote = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    const [record] = await orders(run);
    await storeCompletes(run, record as OrderRecord, {
      delivery: { method: 'access', value: 'LICENSE-KEY-1234' },
    });
    const followed = text(
      (await tool('get_order').handler(run.ctx, { order_id: record?.orderId })) as never,
    );
    expect((await orders(run))[0]?.status?.delivery).toBe('LICENSE-KEY-1234');
    const second = await quoteId(run);
    const guarded = text(
      (await tool('buy_product').handler(run.ctx, {
        quote_id: second.id,
        accept_warnings: second.warnings,
      })) as never,
    );
    for (const said of [followed, guarded]) {
      expect(said).not.toContain('LICENSE-KEY-1234');
      expect(said).not.toContain('delivery_link');
      expect(said).not.toContain('delivery_text');
      expect(said).not.toContain('Delivered');
    }
  });

  it('the buy-again guard uses the same neutral words when the chain cannot say', async () => {
    const run = await world();
    const record = await completedUnseen(run);
    lookupAnswers(run, async () => ({ value: [null] }));
    expect((await orders(run))[0]?.state).toBe('completed');
    const sent = new Set(run.chain.sent).size;
    const second = await quoteId(run);
    const guarded = text(
      (await tool('buy_product').handler(run.ctx, {
        quote_id: second.id,
        accept_warnings: second.warnings,
      })) as never,
    );
    expect(guarded).toContain(NEUTRAL(record.orderId));
    expect(guarded).not.toContain('no payment');
    expect(guarded).toContain('To buy it again, call buy_product with buy_again: true.');
    expect(new Set(run.chain.sent).size).toBe(sent);
  });

  it('a paid order waits for the store to confirm', async () => {
    const run = await world();
    const quote = await quoteId(run);
    await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    const record = await paidOrder(run);
    expect(record.state).toBe('paid');
    const said = text(
      (await tool('get_order').handler(run.ctx, { order_id: record.orderId })) as never,
    );
    expect(said).toContain('Waiting for the store to confirm; call get_order later.');
  });
});

describe('the elisym protocol fee (commerce-fee plan, sections 5 and 7)', () => {
  const TREASURY = solanaAddress();

  /** The store's node declares fee support: a newer profile with `['fee', '1']`. */
  function declaresFee(run: World): void {
    run.events.push(
      sign(
        buildStoreProfileEvent({
          name: 'Shop',
          ownerPubkey: run.shop.owner.pubkey,
          createdAt: T0 + 1,
          fee: true,
        }),
        run.shop.store,
      ),
    );
  }

  type Answer = number | Error;

  /**
   * The fee terms answer each read in turn (the last answer repeats): a rate
   * in bps to `TREASURY`, or a thrown error. Reads, in a buy: the quote, the
   * check before ordering, the compose, the check before paying.
   */
  function feeAnswers(...answers: Answer[]): { reads: () => number } {
    let reads = 0;
    commerceRuntime.feeTerms = async () => {
      const answer = answers[Math.min(reads, answers.length - 1)] as Answer;
      reads += 1;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer === 0 ? { feeBps: 0, treasury: '' } : { feeBps: answer, treasury: TREASURY };
    };
    return { reads: () => reads };
  }

  async function buy(run: World): Promise<{ body: string; isError: boolean }> {
    const quote = await quoteId(run);
    const result = await tool('buy_product').handler(run.ctx, {
      quote_id: quote.id,
      accept_warnings: quote.warnings,
    });
    return {
      body: text(result as never),
      isError: (result as { isError?: boolean }).isError === true,
    };
  }

  const UNAVAILABLE = new FeeConfigError('unavailable', 'rpc down');
  const WRONG_CLUSTER = new FeeConfigError('wrong_cluster', 'devnet rpc as mainnet');

  describe('the wiring', () => {
    const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
    const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

    function devnetRpc() {
      const fail = () => ({
        send: async () => {
          throw new Error('down');
        },
      });
      return {
        getGenesisHash: () => ({ send: async () => DEVNET_GENESIS }),
        getAccountInfo: fail,
        getMultipleAccounts: fail,
      } as never;
    }

    it("reads the config of the order chain's own network, genesis-checked", async () => {
      // A devnet endpoint asked for mainnet terms: refused before any read.
      await expect(original.feeTerms(devnetRpc(), SOLANA_MAINNET)).rejects.toMatchObject({
        code: 'wrong_cluster',
      });
      // The same endpoint for devnet passes the check and reads the config (down here).
      await expect(original.feeTerms(devnetRpc(), SOLANA_DEVNET)).rejects.toMatchObject({
        code: 'unavailable',
      });
    });

    it("reads the Solana rail's treasury of that config, never the EVM one", async () => {
      const solanaTreasury = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy';
      const bytes = getConfigEncoder().encode({
        version: 1,
        bump: 255,
        admin: address(solanaTreasury),
        pendingAdmin: null,
        treasury: address(solanaTreasury),
        feeBps: 100,
        paused: false,
        lastUpdated: 0,
        evmTreasury: new Uint8Array(20).fill(0x11),
        reserved: new Uint8Array(108),
      });
      const account = {
        data: [Buffer.from(bytes).toString('base64'), 'base64'],
        executable: false,
        lamports: 1_000_000n,
        owner: '11111111111111111111111111111111',
        rentEpoch: 0n,
        space: BigInt(bytes.length),
      };
      const rpc = {
        getGenesisHash: () => ({ send: async () => DEVNET_GENESIS }),
        getAccountInfo: () => ({ send: async () => ({ context: { slot: 1n }, value: account }) }),
      } as never;
      await expect(original.feeTerms(rpc, SOLANA_DEVNET)).resolves.toEqual({
        feeBps: 100,
        treasury: solanaTreasury,
      });
    });
  });

  describe('the quote', () => {
    it('says the fee the price includes, in the coin, never as a float', async () => {
      const run = await world();
      declaresFee(run);
      feeAnswers(100);
      const quote = await quoteId(run);
      expect(quote.body).toContain('Price: 49 USDC');
      expect(quote.body).toContain('Includes elisym fee 0.49 USDC');
    });

    it('adds no fee line at a zero fee', async () => {
      const run = await world();
      feeAnswers(0);
      const quote = await quoteId(run);
      expect(quote.body).not.toMatch(/fee/i);
    });

    it('says the fee is unknown when the terms cannot be read, never "no fee"', async () => {
      for (const error of [UNAVAILABLE, WRONG_CLUSTER, new Error('anything')]) {
        const run = await world();
        declaresFee(run);
        feeAnswers(error);
        const quote = await quoteId(run);
        expect(quote.body).toContain('Fee: unknown');
        expect(quote.body).toContain('cannot buy now');
        expect(quote.body).not.toMatch(/no fee/i);
      }
    });

    it('says the store must update when the fee is above 0 and the store does not declare it', async () => {
      const run = await world();
      feeAnswers(100);
      const quote = await quoteId(run);
      expect(quote.body).toContain('store must update');
      expect(quote.body).not.toContain('Includes elisym fee');
    });
  });

  describe('a treasury that is the payer itself', () => {
    it('carries no fee leg: an outdated store is not refused, and the order is paid', async () => {
      const run = await world();
      const payer = (run.agent.solanaKeypair as { publicKey: string }).publicKey;
      commerceRuntime.feeTerms = async () => ({ feeBps: 100, treasury: payer });
      const quote = await quoteId(run);
      expect(quote.body).not.toMatch(/fee/i);
      const bought = await tool('buy_product').handler(run.ctx, {
        quote_id: quote.id,
        accept_warnings: quote.warnings,
      });
      expect(text(bought as never)).toMatch(/paid|confirming/);
      const [record] = await orders(run);
      expect(record?.paymentRequest).not.toContain('fee_address');
      expect(run.chain.landed.size).toBe(1);
    });
  });

  describe('before ordering', () => {
    it('refuses an outdated store: nothing ordered or signed, not retryable', async () => {
      const run = await world();
      feeAnswers(100);
      const bought = await buy(run);
      expect(bought.isError).toBe(true);
      expect(bought.body).toContain('must be updated');
      expect(bought.body).toContain('Nothing was ordered');
      expect(bought.body).not.toMatch(/try again|retry/i);
      expect(await orders(run)).toEqual([]);
      expect(run.chain.sent).toEqual([]);
    });

    it('refuses while the terms cannot be read: nothing ordered, retryable', async () => {
      const run = await world();
      // The quote reads them fine; the buy re-checks anyway.
      feeAnswers(0, UNAVAILABLE);
      const bought = await buy(run);
      expect(bought.isError).toBe(true);
      expect(bought.body).toContain('could not be read');
      expect(bought.body).toContain('try again');
      expect(await orders(run)).toEqual([]);
    });

    it('refuses an unusable configuration without retry wording', async () => {
      const run = await world();
      feeAnswers(0, WRONG_CLUSTER);
      const bought = await buy(run);
      expect(bought.isError).toBe(true);
      expect(bought.body).toContain('cannot be used right now');
      expect(bought.body).not.toMatch(/try again|retry/i);
      expect(await orders(run)).toEqual([]);
    });
  });

  describe('composing the request after the order exists', () => {
    it('ends the order when the fee rose and the store is outdated (not "could not be prepared")', async () => {
      const run = await world();
      feeAnswers(0, 0, 100);
      const bought = await buy(run);
      expect(bought.isError).toBe(true);
      expect(bought.body).toContain('store_outdated');
      expect(bought.body).toContain('it was ended and nothing was paid');
      expect(bought.body).not.toContain('could not be prepared');
      const [record] = await orders(run);
      expect(record?.state).toBe('ended-unpaid');
      expect(record?.paymentRequest).toBeUndefined();
      expect(run.chain.sent).toEqual([]);
      // The product is free again: the next buy places a new order (here refused before ordering).
      feeAnswers(0);
      const again = await buy(run);
      expect(again.isError).toBe(false);
      expect(await orders(run)).toHaveLength(2);
    });

    it('leaves the record while the terms cannot be read, and pays it on the next call', async () => {
      const run = await world();
      feeAnswers(0, 0, UNAVAILABLE);
      const bought = await buy(run);
      expect(bought.isError).toBe(true);
      expect(bought.body).toContain('try again');
      expect(bought.body).not.toContain('could not be prepared');
      const [record] = await orders(run);
      expect(record?.state).toBe('ordered');
      expect(record?.paymentRequest).toBeUndefined();
      expect(run.chain.sent).toEqual([]);
      feeAnswers(0);
      const again = await buy(run);
      expect(again.body).toMatch(/paid|confirming/);
      const after = await orders(run);
      expect(after).toHaveLength(1);
      expect(after[0]?.orderId).toBe(record?.orderId);
      expect(run.chain.landed.size).toBe(1);
    });

    it('leaves the record on an unusable configuration, without retry wording', async () => {
      const run = await world();
      feeAnswers(0, 0, WRONG_CLUSTER);
      const bought = await buy(run);
      expect(bought.isError).toBe(true);
      expect(bought.body).toContain('cannot be used right now');
      expect(bought.body).not.toMatch(/try again|retry/i);
      expect((await orders(run))[0]?.state).toBe('ordered');
      expect(run.chain.sent).toEqual([]);
    });
  });

  describe('a fee raised between the compose and the first payment', () => {
    it('ends a stored fee-0 request with offer_changed (never not_payable), nothing signed', async () => {
      const run = await world();
      declaresFee(run);
      feeAnswers(0, 0, 0, 100);
      const bought = await buy(run);
      expect(bought.isError).toBe(true);
      expect(bought.body).toContain('offer_changed');
      expect(bought.body).toContain('it was ended and nothing was paid');
      const [record] = await orders(run);
      expect(record?.state).toBe('ended-unpaid');
      expect(record?.paymentRequest).toBeDefined();
      expect(run.chain.sent).toEqual([]);
    });

    it('ends it with store_outdated when the store does not declare fee support', async () => {
      const run = await world();
      feeAnswers(0, 0, 0, 100);
      const bought = await buy(run);
      expect(bought.body).toContain('store_outdated');
      expect(bought.body).toContain('must be updated');
      expect((await orders(run))[0]?.state).toBe('ended-unpaid');
      expect(run.chain.sent).toEqual([]);
    });

    it('leaves the record when the terms cannot be read before paying, retryable', async () => {
      const run = await world();
      feeAnswers(0, 0, 0, UNAVAILABLE);
      const bought = await buy(run);
      expect(bought.isError).toBe(true);
      expect(bought.body).toContain('try again');
      expect((await orders(run))[0]?.state).toBe('ordered');
      expect(run.chain.sent).toEqual([]);
    });

    it('leaves the record on an unusable configuration before paying, without retry wording', async () => {
      const run = await world();
      feeAnswers(0, 0, 0, WRONG_CLUSTER);
      const bought = await buy(run);
      expect(bought.isError).toBe(true);
      expect(bought.body).toContain('cannot be used right now');
      expect(bought.body).not.toMatch(/try again|retry/i);
      expect((await orders(run))[0]?.state).toBe('ordered');
    });
  });

  describe('a retry after an attempt proven over', () => {
    async function overAttempt(run: World): Promise<OrderRecord> {
      for (const [key, limit] of run.ctx.sessionSpendLimits) {
        run.ctx.sessionSpendLimits.set(key, limit * 1000n);
      }
      feeAnswers(0);
      run.chain.dropSends = true;
      await buy(run);
      const [stuck] = await orders(run);
      expect(stuck?.state).toBe('paying');
      run.chain.expire();
      run.chain.nextBlockhash();
      run.chain.dropSends = false;
      return stuck as OrderRecord;
    }

    it('ends the order when the store became outdated for the fee', async () => {
      const run = await world();
      const stuck = await overAttempt(run);
      feeAnswers(100);
      const bought = await buy(run);
      expect(bought.isError).toBe(true);
      expect(bought.body).toContain('store_outdated');
      expect(bought.body).toContain('it was ended and nothing was paid');
      const after = await orders(run);
      expect(after).toHaveLength(1);
      expect(after[0]?.orderId).toBe(stuck.orderId);
      expect(after[0]?.state).toBe('ended-unpaid');
      expect(run.chain.landed.size).toBe(0);
    });

    it('leaves the attempt while the terms cannot be read, retryable', async () => {
      const run = await world();
      const stuck = await overAttempt(run);
      feeAnswers(UNAVAILABLE);
      const bought = await buy(run);
      expect(bought.isError).toBe(true);
      expect(bought.body).toContain('try again');
      const after = await orders(run);
      expect(after).toHaveLength(1);
      expect(after[0]?.state).toBe('paying');
      expect(after[0]?.marker?.attemptId).toBe(stuck.marker?.attemptId);
      expect(run.chain.landed.size).toBe(0);
    });
  });
});

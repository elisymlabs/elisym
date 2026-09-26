import { buildOrderMessage, wrapOrderMessage } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { MAX_LIVE_CHECKS_PER_MINUTE } from '../src/constants';
import type { MerchantOrder } from '../src/ledger';
import { MerchantRuntime, type RuntimeDeps } from '../src/runtime';
import type { PaymentCheck } from '../src/solana';
import { T0, chain, key, referenceFor, signatureOf, world } from './fixtures';

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-00000000c001';
const SIG = signatureOf(7);

function wrapped(
  message: Parameters<typeof buildOrderMessage>[0],
  sender: ReturnType<typeof key>,
  recipient: string,
) {
  return wrapOrderMessage(buildOrderMessage(message, T0 + 60), sender.secretKey, recipient)
    .recipientWrap;
}

function harness(
  verdict: PaymentCheck['kind'] = 'paid',
  delivered = true,
  clock: () => number = () => Math.floor(Date.now() / 1000),
) {
  const setup = world();
  const buyer = key();
  const events: string[] = [];
  const saved: string[] = [];
  const deps: RuntimeDeps = {
    state: setup.state,
    store: setup.identity,
    storeSecretKey: setup.store.secretKey,
    context: { rpc: chain({}).rpc, network: 'devnet' },
    save: () => {
      events.push('save');
      saved.push(JSON.stringify(setup.state));
    },
    deliver: async (order: MerchantOrder) => {
      events.push(`deliver:${order.key}`);
      return delivered;
    },
    log: () => undefined,
    // Real time by default: wraps are dated by NIP-59 from the real clock.
    now: clock,
    checkPayment: async (state, order, signature) => {
      events.push(`check:${signature}`);
      if (verdict === 'paid') {
        state.claims[signature] = order.key;
        order.paid = {
          signature,
          amount: '1000000',
          blockTime: T0 + 90,
          caip19: 'x',
          medium: 'solana-devnet',
        };
        return { kind: 'paid', order };
      }
      return verdict === 'ask_again'
        ? { kind: 'ask_again' }
        : { kind: 'refused', reason: 'not_a_payment_for_this_order' };
    },
    catchUp: async () => ({ paid: [], incomplete: [] }),
  };
  const runtime = new MerchantRuntime(deps);
  const order = wrapped(
    {
      type: 'order',
      storePubkey: setup.store.pubkey,
      orderId: ORDER_ID,
      items: [{ product: setup.identity.productAddress, quantity: 1 }],
      total: { amount: '1', currency: 'USD' },
    },
    buyer,
    setup.store.pubkey,
  );
  const receipt = wrapped(
    {
      type: 'receipt',
      storePubkey: setup.store.pubkey,
      orderId: ORDER_ID,
      payment: {
        medium: 'solana-devnet',
        reference: referenceFor(setup.store, buyer, ORDER_ID),
        tx: SIG,
      },
    },
    buyer,
    setup.store.pubkey,
  );
  return { ...setup, deps, runtime, events, saved, order, receipt, buyer };
}

describe('admitting wraps', () => {
  it('takes each wrap once, and never one dated past the skew allowance', () => {
    const { runtime, order } = harness();
    expect(runtime.admit(order)).toBe(true);
    expect(runtime.admit(order)).toBe(false);
    const future = {
      ...order,
      id: 'f'.repeat(64),
      created_at: Math.floor(Date.now() / 1000) + 16 * 60,
    } as NostrEvent;
    expect(runtime.admit(future)).toBe(false);
    expect(runtime.seenWraps.size).toBe(1);
  });
});

describe('handling wraps', () => {
  it('saves the claim before it delivers', async () => {
    const { runtime, events, saved, order, receipt, state, buyer } = harness();
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    expect(state.orders[`${buyer.pubkey}:${ORDER_ID}`]?.deliveredAt).toBeDefined();
    // The mark is on disk: the last save came after it.
    const lastSaved = JSON.parse(saved.at(-1) ?? '{}') as typeof state;
    expect(lastSaved.orders[`${buyer.pubkey}:${ORDER_ID}`]?.deliveredAt).toBeDefined();
    const deliverAt = events.findIndex((event) => event.startsWith('deliver:'));
    expect(deliverAt).toBeGreaterThan(0);
    expect(events[deliverAt - 1]).toBe('save');
    const beforeDelivery =
      saved[events.slice(0, deliverAt).filter((event) => event === 'save').length - 1];
    expect(beforeDelivery).toContain(`"${SIG}"`);
    expect(events.at(-1)).toBe('save');
  });

  it('reads again a receipt that came before its order', async () => {
    const { runtime, events, order, receipt } = harness();
    expect(runtime.admit(receipt)).toBe(true);
    await runtime.handleWrap(receipt);
    expect(events).toEqual([]);
    // Forgotten: its re-send is offered again, and read once the order is in.
    expect(runtime.admit(receipt)).toBe(true);
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    expect(events).toContain(`check:${SIG}`);
  });

  it('remembers a refused transaction and never checks it again', async () => {
    const { runtime, events, state, order, receipt, buyer } = harness('refused');
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    expect(state.orders[`${buyer.pubkey}:${ORDER_ID}`]?.refusedTxs).toEqual([SIG]);
    events.length = 0;
    // The same transaction reported again (another rumor) is not checked.
    state.seenRumors = {};
    await runtime.handleWrap(receipt);
    expect(events.filter((event) => event.startsWith('check:'))).toEqual([]);
  });

  it('checks a reported transaction once, however often it is re-reported', async () => {
    const { runtime, events, store, order, buyer } = harness('ask_again');
    await runtime.handleWrap(order);
    for (let second = 0; second < 5; second += 1) {
      // Each re-report is a new rumor (another date), free to send.
      const rereport = wrapOrderMessage(
        buildOrderMessage(
          {
            type: 'receipt',
            storePubkey: store.pubkey,
            orderId: ORDER_ID,
            payment: {
              medium: 'solana-devnet',
              reference: referenceFor(store, buyer, ORDER_ID),
              tx: SIG,
            },
          },
          T0 + 60 + second,
        ),
        buyer.secretKey,
        store.pubkey,
      ).recipientWrap;
      await runtime.handleWrap(rereport);
    }
    expect(events.filter((event) => event.startsWith('check:'))).toEqual([`check:${SIG}`]);
  });

  it('checks receipts on arrival only within a per-minute budget', async () => {
    // One frozen minute, so the budget cannot roll over mid-test.
    const frozen = Math.floor(Date.now() / 1000);
    const { runtime, events, store, identity } = harness('ask_again', true, () => frozen);
    for (let index = 0; index < MAX_LIVE_CHECKS_PER_MINUTE + 5; index += 1) {
      const buyer = key();
      const orderId = `b3a7c2d4-0000-4000-8000-0000000d${String(index).padStart(4, '0')}`;
      await runtime.handleWrap(
        wrapped(
          {
            type: 'order',
            storePubkey: store.pubkey,
            orderId,
            items: [{ product: identity.productAddress, quantity: 1 }],
            total: { amount: '1', currency: 'USD' },
          },
          buyer,
          store.pubkey,
        ),
      );
      await runtime.handleWrap(
        wrapped(
          {
            type: 'receipt',
            storePubkey: store.pubkey,
            orderId,
            payment: {
              medium: 'solana-devnet',
              reference: referenceFor(store, buyer, orderId),
              tx: signatureOf(60 + index),
            },
          },
          buyer,
          store.pubkey,
        ),
      );
    }
    expect(events.filter((event) => event.startsWith('check:'))).toHaveLength(
      MAX_LIVE_CHECKS_PER_MINUTE,
    );
  });

  it('asks again without remembering anything', async () => {
    const { runtime, state, order, receipt, buyer } = harness('ask_again');
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    expect(state.orders[`${buyer.pubkey}:${ORDER_ID}`]?.refusedTxs).toBeUndefined();
  });
});

describe('the sweep', () => {
  it('saves and delivers even when the chain cannot be read', async () => {
    const { runtime, deps, events, state } = harness();
    state.orders.k = {
      key: 'k',
      buyerPubkey: 'b'.repeat(64),
      orderId: ORDER_ID,
      rumorId: 'r',
      createdAt: T0,
      reference: 'Ref',
      reportedTxs: [],
      paid: { signature: SIG, amount: '1', blockTime: T0, caip19: 'x', medium: 'solana-devnet' },
    };
    deps.catchUp = async () => {
      throw new Error('node down');
    };
    const failing = new MerchantRuntime(deps);
    await expect(failing.sweep(true, T0 + 100)).rejects.toThrow('node down');
    expect(events).toEqual(['save', 'deliver:k', 'save']);
    expect(state.resumeAt).toBe(T0 + 100);
    expect(runtime).toBeDefined();
  });

  it('closes unpaid orders past the window on each sweep', async () => {
    const { runtime, state } = harness();
    state.orders.old = {
      key: 'old',
      buyerPubkey: 'b'.repeat(64),
      orderId: ORDER_ID,
      rumorId: 'r',
      createdAt: Math.floor(Date.now() / 1000) - 4 * 24 * 60 * 60,
      reference: 'Ref',
      reportedTxs: [],
    };
    await runtime.sweep(false, T0);
    expect(state.orders.old).toBeUndefined();
    expect(state.closedOrders).toEqual({ old: true });
  });

  it('moves the resume point only when all relays were live, and forgets old wraps', async () => {
    const { runtime, state, order } = harness();
    state.resumeAt = T0;
    runtime.admit({ ...order, created_at: T0 - 10 * 24 * 60 * 60 } as NostrEvent);
    await runtime.sweep(false, T0 + 100);
    expect(state.resumeAt).toBe(T0);
    expect(runtime.seenWraps.size).toBe(0);
  });

  it('keeps a delivery no relay took, and retries it next time', async () => {
    const { runtime, state, events } = harness('paid', false);
    state.orders.k = {
      key: 'k',
      buyerPubkey: 'b'.repeat(64),
      orderId: ORDER_ID,
      rumorId: 'r',
      createdAt: T0,
      reference: 'Ref',
      reportedTxs: [],
      paid: { signature: SIG, amount: '1', blockTime: T0, caip19: 'x', medium: 'solana-devnet' },
    };
    await runtime.deliverPending();
    expect(state.orders.k.deliveredAt).toBeUndefined();
    expect(events).toEqual(['deliver:k']);
  });
});

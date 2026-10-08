import { buildOrderMessage, deriveOrderPaymentReference, wrapOrderMessage } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  ASK_AGAIN_DELAYS_MS,
  DELIVERY_SETTLE_SECS,
  MAX_LIVE_CHECKS_PER_MINUTE,
  MAX_REPEATS_IN_FLIGHT,
  RESEND_EVERY_SECS,
} from '../src/constants';
import type { MerchantOrder } from '../src/ledger';
import { type DeliveryAttempt, MerchantRuntime, type RuntimeDeps } from '../src/runtime';
import { SelfCopies } from '../src/self-copies';
import type { PaymentCheck } from '../src/solana';
import {
  T0,
  chain,
  key,
  landedPayment,
  referenceFor,
  requestFor,
  signatureOf,
  world,
  productAt,
} from './fixtures';

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-00000000c001';
const SIG = signatureOf(7);
const INBOX = ['wss://inbox-a', 'wss://inbox-b'];

function wrapped(
  message: Parameters<typeof buildOrderMessage>[0],
  sender: ReturnType<typeof key>,
  recipient: string,
) {
  return wrapOrderMessage(buildOrderMessage(message, T0 + 60), sender.secretKey, recipient)
    .recipientWrap;
}

/** A stand-in for the store's copy of a reply: what the copy queue is handed. */
const COPY = wrapped(
  { type: 'status', buyerPubkey: 'b'.repeat(64), orderId: ORDER_ID, status: 'completed' },
  key(),
  key().pubkey,
);

function attempt(taken: string[], selfWrap: NostrEvent = COPY): DeliveryAttempt {
  return { taken, selfWrap };
}

function harness(
  verdict: PaymentCheck['kind'] | (() => PaymentCheck['kind']) = 'paid',
  delivered = true,
  clock: () => number = () => Math.floor(Date.now() / 1000),
) {
  const setup = world();
  const buyer = key();
  const events: string[] = [];
  const saved: string[] = [];
  const later: { ms: number; task: () => Promise<void> }[] = [];
  const deps: RuntimeDeps = {
    state: setup.state,
    store: setup.identity,
    storeSecretKey: setup.store.secretKey,
    context: { rpc: chain({}).rpc, network: 'devnet' },
    save: () => {
      events.push('save');
      saved.push(JSON.stringify(setup.state));
    },
    deliver: async (order: MerchantOrder, skip: readonly string[]) => {
      events.push(`deliver:${order.key}`);
      return attempt(delivered ? INBOX.filter((relay) => !skip.includes(relay)) : []);
    },
    inboxRelayCount: INBOX.length,
    log: () => undefined,
    // Real time by default: wraps are dated by NIP-59 from the real clock.
    now: clock,
    later: (ms, task) => {
      later.push({ ms, task });
    },
    checkPayment: async (state, order, signature) => {
      events.push(`check:${signature}`);
      const kind = typeof verdict === 'function' ? verdict() : verdict;
      if (kind === 'paid') {
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
      return kind === 'ask_again'
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
      items: [{ product: productAt(setup.store), quantity: 1 }],
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
  return { ...setup, deps, runtime, events, saved, later, order, receipt, buyer };
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

describe('the webhook outbox', () => {
  it('is on disk in every save that holds the payment, never after it', async () => {
    const setup = harness();
    const saved: string[] = [];
    const reference = referenceFor(setup.store, setup.buyer, ORDER_ID);
    const { rpc } = chain({ [SIG]: await landedPayment(requestFor(reference)) });
    const { checkPayment: _replaced, ...deps } = setup.deps;
    const runtime = new MerchantRuntime({
      ...deps,
      // The real check: it records the payment and its entry in one change.
      context: {
        rpc,
        network: 'devnet',
        outbox: { storePubkey: setup.store.pubkey, now: () => T0 + 500 },
      },
      save: () => saved.push(JSON.stringify(setup.state)),
    });
    await runtime.handleWrap(setup.order);
    await runtime.handleWrap(setup.receipt);
    const key = `${setup.buyer.pubkey}:${ORDER_ID}`;
    const withPayment = saved
      .map((text) => JSON.parse(text) as typeof setup.state)
      .filter((snapshot) => snapshot.orders[key]?.paid !== undefined);
    expect(withPayment.length).toBeGreaterThan(0);
    for (const snapshot of withPayment) {
      expect(snapshot.orders[key]?.webhook?.state).toBe('pending');
    }
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
    const { runtime, events, store } = harness('ask_again', true, () => frozen);
    for (let index = 0; index < MAX_LIVE_CHECKS_PER_MINUTE + 5; index += 1) {
      const buyer = key();
      const orderId = `b3a7c2d4-0000-4000-8000-0000000d${String(index).padStart(4, '0')}`;
      await runtime.handleWrap(
        wrapped(
          {
            type: 'order',
            storePubkey: store.pubkey,
            orderId,
            items: [{ product: productAt(store), quantity: 1 }],
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
      product: `30402:${'s'.repeat(64)}:course-101`,
      reportedTxs: [],
      paid: { signature: SIG, amount: '1', blockTime: T0, caip19: 'x', medium: 'solana-devnet' },
    };
    deps.catchUp = async () => {
      throw new Error('node down');
    };
    let tempoSwept = false;
    const failing = new MerchantRuntime({
      ...deps,
      tempo: {} as never,
      catchUpTempo: async () => {
        tempoSwept = true;
        return { paid: [], incomplete: [] };
      },
    });
    // The Solana RPC failing neither throws out of the sweep nor stops the Tempo catch-up.
    await failing.sweep(true, T0 + 100);
    expect(tempoSwept).toBe(true);
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
      product: `30402:${'s'.repeat(64)}:course-101`,
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
      product: `30402:${'s'.repeat(64)}:course-101`,
      reportedTxs: [],
      paid: { signature: SIG, amount: '1', blockTime: T0, caip19: 'x', medium: 'solana-devnet' },
    };
    await runtime.deliverPending();
    expect(state.orders.k.deliveredAt).toBeUndefined();
    expect(events).toEqual(['deliver:k']);
  });
});

describe('a receipt the RPC does not see yet', () => {
  it('is checked again soon, and delivered once it lands', async () => {
    const verdicts: PaymentCheck['kind'][] = ['ask_again', 'ask_again', 'paid'];
    const { runtime, events, later, order, receipt, state, buyer } = harness(
      () => verdicts.shift() ?? 'paid',
    );
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    expect(later.map((entry) => entry.ms)).toEqual([ASK_AGAIN_DELAYS_MS[0]]);
    await later[0]?.task();
    expect(later.map((entry) => entry.ms)).toEqual(ASK_AGAIN_DELAYS_MS.slice(0, 2));
    await later[1]?.task();
    expect(events.filter((event) => event.startsWith('check:'))).toHaveLength(3);
    expect(state.orders[`${buyer.pubkey}:${ORDER_ID}`]?.deliveredAt).toBeDefined();
    expect(later).toHaveLength(2);
  });

  it('stops after the last pause, leaving the rest to the sweep', async () => {
    const { runtime, events, later, order, receipt } = harness('ask_again');
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    for (let index = 0; index < later.length; index += 1) {
      await later[index]?.task();
    }
    expect(later).toHaveLength(ASK_AGAIN_DELAYS_MS.length);
    expect(events.filter((event) => event.startsWith('check:'))).toHaveLength(
      ASK_AGAIN_DELAYS_MS.length + 1,
    );
  });

  it('is not checked again once the order was paid meanwhile', async () => {
    const { runtime, events, later, order, receipt, state, buyer } = harness('ask_again');
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    const held = state.orders[`${buyer.pubkey}:${ORDER_ID}`];
    if (held === undefined) {
      throw new Error('no order');
    }
    held.paid = {
      signature: SIG,
      amount: '1',
      blockTime: T0,
      caip19: 'x',
      medium: 'solana-devnet',
    };
    await later[0]?.task();
    expect(events.filter((event) => event.startsWith('check:'))).toHaveLength(1);
  });

  it('is not checked again past the live budget', async () => {
    const { runtime, events, later, order, receipt } = harness('ask_again', true, () => T0);
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    // Spend the rest of this minute's budget.
    const budget = runtime as unknown as { liveChecks: [number, number] };
    budget.liveChecks = [Math.floor(T0 / 60), MAX_LIVE_CHECKS_PER_MINUTE];
    await later[0]?.task();
    expect(events.filter((event) => event.startsWith('check:'))).toHaveLength(1);
  });
});

describe('a delivered order read again', () => {
  it('sends its status again when its order is read again', async () => {
    const { runtime, events, order, receipt, deps } = harness();
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    const delivered = events.filter((event) => event.startsWith('deliver:')).length;
    // A restarted merchant reads the same order rumor again.
    const again = new MerchantRuntime(deps);
    await again.handleWrap(order);
    expect(events.filter((event) => event.startsWith('deliver:'))).toHaveLength(delivered + 1);
  });

  it('sends its status again for a receipt, without checking it', async () => {
    const { runtime, events, order, receipt, deps } = harness();
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    const checks = events.filter((event) => event.startsWith('check:')).length;
    const again = new MerchantRuntime(deps);
    await again.handleWrap(receipt);
    expect(events.filter((event) => event.startsWith('check:'))).toHaveLength(checks);
    expect(events.filter((event) => event.startsWith('deliver:'))).toHaveLength(2);
  });

  it('sends it again at most every few minutes', async () => {
    let clock = Math.floor(Date.now() / 1000);
    const { runtime, events, order, receipt } = harness('paid', true, () => clock);
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    await runtime.handleWrap(order);
    await runtime.handleWrap(order);
    expect(events.filter((event) => event.startsWith('deliver:'))).toHaveLength(2);
    clock += RESEND_EVERY_SECS;
    await runtime.handleWrap(order);
    expect(events.filter((event) => event.startsWith('deliver:'))).toHaveLength(3);
  });

  it('sends only a few again at once, off the queue', async () => {
    const { runtime, events, deps, store } = harness();
    const orders: NostrEvent[] = [];
    for (let index = 0; index < MAX_REPEATS_IN_FLIGHT + 2; index += 1) {
      const buyer = key();
      const orderId = `b3a7c2d4-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`;
      const orderWrap = wrapped(
        {
          type: 'order',
          storePubkey: store.pubkey,
          orderId,
          items: [{ product: productAt(store), quantity: 1 }],
          total: { amount: '1', currency: 'USD' },
        },
        buyer,
        store.pubkey,
      );
      const receiptWrap = wrapped(
        {
          type: 'receipt',
          storePubkey: store.pubkey,
          orderId,
          payment: {
            medium: 'solana-devnet',
            reference: referenceFor(store, buyer, orderId),
            tx: signatureOf(20 + index),
          },
        },
        buyer,
        store.pubkey,
      );
      await runtime.handleWrap(orderWrap);
      await runtime.handleWrap(receiptWrap);
      orders.push(orderWrap);
    }
    const before = events.filter((event) => event.startsWith('deliver:')).length;
    // A restarted merchant whose relays hang: every resend stays in flight.
    const hanging = new MerchantRuntime({
      ...deps,
      deliver: (order) => {
        events.push(`deliver:${order.key}`);
        return new Promise<DeliveryAttempt>(() => undefined);
      },
    });
    for (const orderWrap of orders) {
      // Each returns at once: the queue is never held by a resend.
      await hanging.handleWrap(orderWrap);
    }
    expect(events.filter((event) => event.startsWith('deliver:')).length - before).toBe(
      MAX_REPEATS_IN_FLIGHT,
    );
  });

  it('leaves an order paid but not yet delivered to the delivery loop', async () => {
    const { runtime, events, order, receipt, deps } = harness('paid', false);
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    expect(events.filter((event) => event.startsWith('deliver:'))).toHaveLength(1);
    await new MerchantRuntime(deps).handleWrap(order);
    expect(events.filter((event) => event.startsWith('deliver:'))).toHaveLength(1);
  });
});

describe('delivering to the inbox relays', () => {
  it('counts a delivery done at two relays, and retries only the one that missed it', async () => {
    let clock = T0 + 100;
    const { runtime, deps, order, receipt, state, buyer } = harness('paid', true, () => clock);
    const sentTo: string[][] = [];
    const flaky = new MerchantRuntime({
      ...deps,
      deliver: async (_order, skip) => {
        const targets = INBOX.filter((relay) => !skip.includes(relay));
        sentTo.push(targets);
        // The second relay is down.
        return attempt(targets.filter((relay) => relay === INBOX[0]));
      },
    });
    await flaky.handleWrap(order);
    await flaky.handleWrap(receipt);
    const held = state.orders[`${buyer.pubkey}:${ORDER_ID}`];
    expect(held?.deliveredTo).toEqual([INBOX[0]]);
    expect(held?.deliveredAt).toBeUndefined();
    await flaky.deliverPending();
    // The relay that took it gets no second copy.
    expect(sentTo).toEqual([INBOX, [INBOX[1]]]);
    expect(held?.deliveredAt).toBeUndefined();
    // Long after the payment, the one relay is enough.
    clock = (held?.paid?.blockTime ?? 0) + DELIVERY_SETTLE_SECS;
    await flaky.deliverPending();
    expect(held?.deliveredAt).toBe(clock);
    void runtime;
  });

  it('saves a relay that took the delivery, even while the delivery is not done yet', async () => {
    const { deps, state, saved } = harness('paid', true, () => T0 + 100);
    state.orders.k = {
      key: 'k',
      buyerPubkey: 'b',
      orderId: 'o',
      rumorId: 'r',
      createdAt: T0,
      reference: 'x',
      product: `30402:${'s'.repeat(64)}:course-101`,
      reportedTxs: [],
      paid: {
        signature: signatureOf(41),
        amount: '1',
        blockTime: T0 + 90,
        caip19: 'x',
        medium: 'solana-devnet',
      },
    };
    const answers: string[][] = [[], [INBOX[0] as string]];
    const runtime = new MerchantRuntime({
      ...deps,
      deliver: async () => attempt(answers.shift() ?? []),
    });
    await runtime.deliverPending();
    expect(saved).toHaveLength(0);
    await runtime.deliverPending();
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0] ?? '{}').orders.k.deliveredTo).toEqual([INBOX[0]]);
    expect(state.orders.k?.deliveredAt).toBeUndefined();
  });

  it('delivers every pending order at once, so one hung relay costs one wait', async () => {
    const { deps, state } = harness();
    let inFlight = 0;
    let most = 0;
    for (const [index, signature] of [
      signatureOf(31),
      signatureOf(32),
      signatureOf(33),
    ].entries()) {
      state.orders[`k${index}`] = {
        key: `k${index}`,
        buyerPubkey: 'b',
        orderId: `o${index}`,
        rumorId: `r${index}`,
        createdAt: T0,
        reference: 'x',
        product: `30402:${'s'.repeat(64)}:course-101`,
        reportedTxs: [],
        paid: { signature, amount: '1', blockTime: T0, caip19: 'x', medium: 'solana-devnet' },
      };
    }
    const runtime = new MerchantRuntime({
      ...deps,
      deliver: async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return attempt(INBOX);
      },
    });
    await runtime.deliverPending();
    expect(most).toBe(3);
    expect(Object.values(state.orders).every((order) => order.deliveredAt !== undefined)).toBe(
      true,
    );
  });
});

describe("the store's copy of a delivery", () => {
  function copyQueue() {
    const published: NostrEvent[] = [];
    const selfCopies = new SelfCopies({
      publish: async (wrap) => {
        published.push(wrap);
        return ['wss://inbox-a'];
      },
      log: () => undefined,
      later: () => undefined,
    });
    return { selfCopies, published };
  }

  it('is queued once per order, on the attempt that makes it delivered, never on a resend', async () => {
    let clock = T0 + 100;
    const { deps, order, receipt, state, buyer } = harness('paid', true, () => clock);
    const { selfCopies, published } = copyQueue();
    const copies: NostrEvent[] = [];
    let call = 0;
    const runtime = new MerchantRuntime({
      ...deps,
      selfCopies,
      deliver: async (_order, skip) => {
        call += 1;
        const own = wrapped(
          { type: 'status', buyerPubkey: buyer.pubkey, orderId: ORDER_ID, status: 'completed' },
          key(),
          key().pubkey,
        );
        copies.push(own);
        // First attempt: one relay of two. Then the other relay stays down.
        const taken = call === 1 ? [INBOX[0] as string] : [];
        return attempt(
          taken.filter((relay) => !skip.includes(relay)),
          own,
        );
      },
    });
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    await runtime.deliverPending();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const held = state.orders[`${buyer.pubkey}:${ORDER_ID}`];
    expect(held?.deliveredAt).toBeUndefined();
    expect(published).toEqual([]);
    // The settle path: the attempt that makes it delivered reached no relay itself.
    clock = (held?.paid?.blockTime ?? 0) + DELIVERY_SETTLE_SECS;
    await runtime.deliverPending();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held?.deliveredAt).toBe(clock);
    expect(published).toEqual([copies.at(-1)]);
    // A resend sends the buyer the delivery again, and makes no second copy.
    clock += RESEND_EVERY_SECS;
    const callsBefore = call;
    await runtime.handleWrap(order);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(call).toBe(callsBefore + 1);
    expect(published).toHaveLength(1);
  });

  it('never holds up or fails a delivery when its copy hangs or fails', async () => {
    for (const publish of [
      () => new Promise<string[]>(() => undefined),
      async (): Promise<string[]> => {
        throw new Error('relay down');
      },
    ]) {
      const { deps, state, events } = harness('paid', true, () => T0 + 100);
      state.orders.k = {
        key: 'k',
        buyerPubkey: 'b',
        orderId: 'o',
        rumorId: 'r',
        createdAt: T0,
        reference: 'x',
        product: `30402:${'s'.repeat(64)}:course-101`,
        reportedTxs: [],
        paid: {
          signature: signatureOf(53),
          amount: '1',
          blockTime: T0 + 90,
          caip19: 'x',
          medium: 'solana-devnet',
        },
      };
      const selfCopies = new SelfCopies({ publish, log: () => undefined, later: () => undefined });
      const runtime = new MerchantRuntime({ ...deps, selfCopies });
      await runtime.deliverPending();
      expect(state.orders.k?.deliveredAt).toBe(T0 + 100);
      expect(events.at(-1)).toBe('save');
    }
  });

  it('waits while buyer deliveries are published', async () => {
    const { deps, state } = harness('paid', true, () => T0 + 100);
    const { selfCopies, published } = copyQueue();
    state.orders.k = {
      key: 'k',
      buyerPubkey: 'b',
      orderId: 'o',
      rumorId: 'r',
      createdAt: T0,
      reference: 'x',
      product: `30402:${'s'.repeat(64)}:course-101`,
      reportedTxs: [],
      paid: {
        signature: signatureOf(51),
        amount: '1',
        blockTime: T0 + 90,
        caip19: 'x',
        medium: 'solana-devnet',
      },
    };
    let release: (() => void) | undefined;
    const runtime = new MerchantRuntime({
      ...deps,
      selfCopies,
      deliver: () =>
        new Promise<DeliveryAttempt>((resolve) => {
          release = () => resolve(attempt(INBOX));
        }),
    });
    const delivering = runtime.deliverPending();
    // A copy queued earlier (say, a retry) must not go out while the buyer's does.
    selfCopies.add(COPY, 'earlier');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published).toEqual([]);
    release?.();
    await delivering;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published).toEqual([COPY, COPY]);
  });

  it('logs a copy it could not make when the delivery itself could not be built', async () => {
    const logs: string[] = [];
    const { deps, state } = harness('paid', true, () => T0 + 100 + DELIVERY_SETTLE_SECS);
    const { selfCopies, published } = copyQueue();
    state.orders.k = {
      key: 'k',
      buyerPubkey: 'b',
      orderId: 'o',
      rumorId: 'r',
      createdAt: T0,
      reference: 'x',
      product: `30402:${'s'.repeat(64)}:course-101`,
      reportedTxs: [],
      deliveredTo: [INBOX[0] as string],
      paid: {
        signature: signatureOf(52),
        amount: '1',
        blockTime: T0 + 90,
        caip19: 'x',
        medium: 'solana-devnet',
      },
    };
    const runtime = new MerchantRuntime({
      ...deps,
      selfCopies,
      log: (message) => logs.push(message),
      deliver: async () => {
        throw new Error('cannot build');
      },
    });
    await runtime.deliverPending();
    expect(state.orders.k?.deliveredAt).toBeDefined();
    expect(published).toEqual([]);
    expect(logs).toContain('copy for k not made: the completed status could not be built');
  });
});

describe('Tempo receipts at the runtime', () => {
  const TEMPO_HASH = `0x${'ab'.repeat(32)}`;

  function tempoReceipt(run: ReturnType<typeof harness>) {
    return wrapped(
      {
        type: 'receipt',
        storePubkey: run.store.pubkey,
        orderId: ORDER_ID,
        payment: {
          medium: 'tempo',
          reference: deriveOrderPaymentReference({
            storePubkey: run.store.pubkey,
            buyerPubkey: run.buyer.pubkey,
            orderId: ORDER_ID,
          }).tempo,
          tx: TEMPO_HASH,
        },
      },
      run.buyer,
      run.store.pubkey,
    );
  }

  it('checks a reported Tempo hash on the Tempo side, and sets a no-leg hash aside', async () => {
    const run = harness();
    run.state.orders = {};
    const checked: string[] = [];
    const runtime = new MerchantRuntime({
      ...run.deps,
      store: { ...run.identity, mediums: ['solana-devnet', 'tempo'] },
      tempo: {} as never,
      checkTempoPayment: async (_state, _order, hash) => {
        checked.push(hash);
        return { kind: 'no_leg' };
      },
    });
    await runtime.handleWrap(run.order);
    await runtime.handleWrap(tempoReceipt(run));
    expect(checked).toEqual([TEMPO_HASH]);
    expect(run.events).not.toContain(`check:${TEMPO_HASH}`);
    const order = Object.values(run.state.orders)[0];
    expect(order?.noLegTxs).toEqual([TEMPO_HASH]);
    expect(order?.refusedTxs).toBeUndefined();
    expect(run.state.version).toBe(4);
  });

  it('leaves a Tempo hash alone on a node with no tempo block', async () => {
    const run = harness();
    const runtime = new MerchantRuntime({
      ...run.deps,
      store: { ...run.identity, mediums: ['solana-devnet', 'tempo'] },
    });
    await runtime.handleWrap(run.order);
    await runtime.handleWrap(tempoReceipt(run));
    expect(run.events).not.toContain(`check:${TEMPO_HASH}`);
    const order = Object.values(run.state.orders)[0];
    expect(order?.refusedTxs).toBeUndefined();
  });
});

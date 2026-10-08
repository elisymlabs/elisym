/**
 * The running node and the protocol fee: the treasury read at each sweep (a
 * config RPC of another cluster stops the node, one that is down is retried),
 * and how an unresolved payment (paid rule 3) is kept and told.
 */
import { buildOrderMessage, wrapOrderMessage } from '@elisym/commerce';
import { describe, expect, it } from 'vitest';
import type { TreasuryRefresh } from '../src/fee';
import { FEE_UNRESOLVED_NOTE, MerchantRuntime, type RuntimeDeps } from '../src/runtime';
import type { PaymentCheck } from '../src/solana';
import { T0, chain, key, productAt, referenceFor, signatureOf, world } from './fixtures';

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-00000000f0f0';
const SIG = signatureOf(7);

function harness(refresh?: () => Promise<TreasuryRefresh>, check?: () => PaymentCheck) {
  const setup = world();
  const buyer = key();
  const events: string[] = [];
  const logs: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  const deps: RuntimeDeps = {
    state: setup.state,
    store: setup.identity,
    storeSecretKey: setup.store.secretKey,
    context: { rpc: chain({}).rpc, network: 'devnet' },
    save: () => {
      events.push('save');
    },
    deliver: async () => ({ taken: [], selfWrap: {} as never }),
    inboxRelayCount: 2,
    log: (message) => {
      logs.push(message);
    },
    now: () => now,
    checkPayment: async () => check?.() ?? { kind: 'ask_again' },
    catchUp: async () => {
      events.push('catch-up');
      return { paid: [], incomplete: [], unresolved: ['k tx'] };
    },
    ...(refresh === undefined
      ? {}
      : {
          refreshTreasuries: async () => {
            events.push('refresh');
            return await refresh();
          },
        }),
    stop: (problem) => {
      events.push(`stop:${problem}`);
    },
  };
  const wrap = (message: Parameters<typeof buildOrderMessage>[0]) =>
    wrapOrderMessage(buildOrderMessage(message, now - 30), buyer.secretKey, setup.store.pubkey)
      .recipientWrap;
  const order = wrap({
    type: 'order',
    storePubkey: setup.store.pubkey,
    orderId: ORDER_ID,
    items: [{ product: productAt(setup.store), quantity: 1 }],
    total: { amount: '1', currency: 'USD' },
  });
  const receipt = wrap({
    type: 'receipt',
    storePubkey: setup.store.pubkey,
    orderId: ORDER_ID,
    payment: {
      medium: 'solana-devnet',
      reference: referenceFor(setup.store, buyer, ORDER_ID),
      tx: SIG,
    },
  });
  return {
    runtime: new MerchantRuntime(deps),
    deps,
    events,
    logs,
    now,
    order,
    receipt,
    setup,
  };
}

describe('the treasury read of a sweep', () => {
  it('runs before the catch-up', async () => {
    const { runtime, events } = harness(async () => ({
      kind: 'read',
      feeBps: 0,
    }));
    await runtime.sweep(true, T0);
    expect(events.slice(0, 2)).toEqual(['refresh', 'catch-up']);
  });

  it('stops the node on a config RPC of another cluster, before any catch-up', async () => {
    const { runtime, events, logs } = harness(async () => ({
      kind: 'wrong_cluster',
      problem: 'not devnet',
    }));
    await runtime.sweep(true, T0);
    expect(events).toEqual(['refresh', 'save', 'stop:not devnet']);
    expect(logs.join('\n')).toMatch(/not devnet: stopping/);
  });

  it('warns about a config RPC that is down and catches up with the treasuries known', async () => {
    const { runtime, events, logs } = harness(async () => ({
      kind: 'unreachable',
      problem: 'ECONNREFUSED',
    }));
    await runtime.sweep(true, T0);
    expect(events).toContain('catch-up');
    expect(events.some((event) => event.startsWith('stop'))).toBe(false);
    expect(logs.join('\n')).toMatch(/fee config could not be read \(ECONNREFUSED\)/);
    // The catch-up's newly unresolved payments are told.
    expect(logs).toContain(`warning: k tx: ${FEE_UNRESOLVED_NOTE}`);
  });
});

describe('an unresolved payment at the runtime', () => {
  it('a reported payment matching no known treasury is marked and told once', async () => {
    const { runtime, deps, order, receipt, logs, setup, now } = harness(undefined, () => ({
      kind: 'ask_again',
      feeUnresolved: true,
    }));
    const later: (() => Promise<void>)[] = [];
    deps.later = (_ms, task) => {
      later.push(task);
    };
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    const held = Object.values(setup.state.orders)[0];
    expect(held?.feeUnresolved).toEqual({ [SIG]: now });
    expect(held?.refusedTxs).toBeUndefined();
    expect(logs.filter((line) => line.includes(FEE_UNRESOLVED_NOTE))).toHaveLength(1);
    // Checked again and still unresolved: the mark stands and nothing is told twice.
    const retry = later.shift();
    expect(retry).toBeDefined();
    await retry?.();
    expect(logs.filter((line) => line.startsWith(`receipt ${held?.key} ${SIG}:`))).toHaveLength(2);
    expect(held?.feeUnresolved).toEqual({ [SIG]: now });
    expect(logs.filter((line) => line.includes(FEE_UNRESOLVED_NOTE))).toHaveLength(1);
  });

  it('a reported payment still unresolved on its retry keeps its place in the recheck queue', async () => {
    const { runtime, deps, order, receipt, setup, now } = harness(undefined, () => ({
      kind: 'ask_again',
      feeUnresolved: true,
    }));
    const later: (() => Promise<void>)[] = [];
    deps.later = (_ms, task) => {
      later.push(task);
    };
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    const held = Object.values(setup.state.orders)[0];
    expect(held?.recheckedAt?.[SIG]).toBe(now);
    // The retry runs later: the payment is still ranked by when it was reported.
    deps.now = () => now + 600;
    const retry = later.shift();
    expect(retry).toBeDefined();
    await retry?.();
    expect(held?.recheckedAt?.[SIG]).toBe(now);
  });

  it('a reported payment asked again for no fee reason is neither marked nor told', async () => {
    const { runtime, order, receipt, logs, setup } = harness(undefined, () => ({
      kind: 'ask_again',
    }));
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    const held = Object.values(setup.state.orders)[0];
    expect(held?.reportedTxs).toEqual([SIG]);
    expect(held?.feeUnresolved).toBeUndefined();
    expect(logs.some((line) => line.includes(FEE_UNRESOLVED_NOTE))).toBe(false);
  });

  it('a reported payment refused on its next check drops its unresolved mark', async () => {
    const answers: PaymentCheck[] = [
      { kind: 'ask_again', feeUnresolved: true },
      { kind: 'refused', reason: 'not_a_payment_for_this_order' },
    ];
    const { runtime, deps, order, receipt, setup, now } = harness(
      undefined,
      () => answers.shift() ?? { kind: 'ask_again' },
    );
    const later: (() => Promise<void>)[] = [];
    deps.later = (_ms, task) => {
      later.push(task);
    };
    await runtime.handleWrap(order);
    await runtime.handleWrap(receipt);
    const held = Object.values(setup.state.orders)[0];
    expect(held?.feeUnresolved).toEqual({ [SIG]: now });
    const retry = later.shift();
    expect(retry).toBeDefined();
    await retry?.();
    expect(held?.refusedTxs).toEqual([SIG]);
    expect(held?.feeUnresolved).toBeUndefined();
  });

  it('an order closed by the window with an unresolved payment is told loudly', async () => {
    const { runtime, logs, setup, now } = harness();
    setup.state.orders.old = {
      key: 'old',
      buyerPubkey: 'b'.repeat(64),
      orderId: ORDER_ID,
      rumorId: 'r',
      createdAt: now - 4 * 86_400,
      reference: 'Ref',
      product: `30402:${'s'.repeat(64)}:course-101`,
      reportedTxs: [],
      feeUnresolved: { [SIG]: now - 3 * 86_400 },
    };
    await runtime.sweep(false, T0);
    expect(setup.state.unresolvedPayments).toEqual([{ key: 'old', tx: SIG, at: now - 3 * 86_400 }]);
    expect(logs.join('\n')).toMatch(new RegExp(`WARNING: old closed unpaid with ${SIG}`));
  });
});

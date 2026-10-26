import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The `eip3009` rail inside the running node: receipts routed by their medium,
 * each chain behind its start check, and a Base Sepolia payment delivered with
 * and without a reported hash.
 */
import {
  buildOrderMessage,
  buildPaytoEvent,
  buildProductEvent,
  parsePayto,
  wrapOrderMessage,
} from '@elisym/commerce';
import { mediumOf } from '@elisym/commerce/buyer';
import { chainByCaip2 } from '@elisym/pay-core';
import type { Eip1193Client } from '@elisym/pay-core/evm';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { offersNotHonoured } from '../src/checks';
import { configProblems } from '../src/config';
import { EIP3009_BIND_READS } from '../src/constants';
import {
  type Eip3009Context,
  catchUpEip3009,
  checkEip3009Payment,
  eip3009ChainsOf,
  eip3009ContextsFor,
  newScanMemory,
  startEip3009Chains,
  startEip3009Rail,
  storeMediums,
  sweepEip3009,
} from '../src/eip3009';
import { intake } from '../src/intake';
import { type MerchantOrder, loadLedger, webhookEventId } from '../src/ledger';
import { type DeliveryAttempt, MerchantRuntime, type RuntimeDeps } from '../src/runtime';
import { type TempoContext, catchUpTempo } from '../src/tempo';
import { publishTerms } from '../src/terms';
import {
  type NodeChain,
  nodeChain,
  payWithAuthorization,
  plainTransfer,
  txHashOf,
} from './eip3009-chain';
import {
  EVM_PAYOUT,
  NOW,
  OTHER_PAYOUT,
  PAYER,
  PRICE,
  type Run,
  blockAt,
  nonceOf,
  orderAt,
  setup,
} from './eip3009-support';
import { D, type Key, delivered, key, productAt } from './fixtures';

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-00000000e001';
const HASH = txHashOf(1);

function wrap(run: Run, message: Parameters<typeof buildOrderMessage>[0], buyer: Key, at: number) {
  return wrapOrderMessage(buildOrderMessage(message, at), buyer.secretKey, run.store.pubkey)
    .recipientWrap;
}

function orderWrap(run: Run, buyer: Key, orderId = ORDER_ID, at = NOW - 3600) {
  return wrap(
    run,
    {
      type: 'order',
      storePubkey: run.store.pubkey,
      orderId,
      items: [{ product: productAt(run.store), quantity: 1 }],
      total: { amount: '5', currency: 'USD' },
    },
    buyer,
    at,
  );
}

function receiptWrap(run: Run, buyer: Key, reference: string, tx: string, medium = run.medium) {
  return wrap(
    run,
    {
      type: 'receipt',
      storePubkey: run.store.pubkey,
      orderId: ORDER_ID,
      payment: { medium, reference, tx },
    },
    buyer,
    NOW - 60,
  );
}

interface Harness {
  run: Run;
  runtime: MerchantRuntime;
  deps: RuntimeDeps;
  events: string[];
  logs: string[];
  clock: { now: number };
}

/** A node with one `eip3009` chain (the run's), and Solana and Tempo stubs that note their sweeps. */
function harness(run: Run, overrides: Partial<RuntimeDeps> = {}): Harness {
  const events: string[] = [];
  const logs: string[] = [];
  const clock = { now: NOW };
  const deps: RuntimeDeps = {
    state: run.state,
    store: run.identity,
    storeSecretKey: run.store.secretKey,
    context: { rpc: {} as never, network: 'devnet' },
    save: () => undefined,
    deliver: async (order: MerchantOrder): Promise<DeliveryAttempt> => {
      events.push(`deliver:${order.key}`);
      return { taken: ['wss://a', 'wss://b'], selfWrap: orderWrap(run, key()) };
    },
    inboxRelayCount: 2,
    log: (message) => logs.push(message),
    now: () => clock.now,
    catchUp: async () => {
      events.push('solana');
      return { paid: [], incomplete: [] };
    },
    tempo: {} as never,
    catchUpTempo: async () => {
      events.push('tempo');
      return { paid: [], incomplete: [] };
    },
    eip3009: [run.context],
    ...overrides,
  };
  return { run, runtime: new MerchantRuntime(deps), deps, events, logs, clock };
}

function onlyOrder(run: Run): MerchantOrder {
  const [order] = Object.values(run.state.orders);
  if (order === undefined) {
    throw new Error('no order');
  }
  return order;
}

describe('a Base Sepolia payment at the running node', () => {
  it('is delivered on its receipt, checked on its chain only', async () => {
    const run = setup();
    const buyer = key();
    const tempoChecks: string[] = [];
    const node = harness(run, {
      checkTempoPayment: async (_state, _order, hash) => {
        tempoChecks.push(hash);
        return { kind: 'no_leg' };
      },
    });
    await node.runtime.handleWrap(orderWrap(run, buyer));
    const order = onlyOrder(run);
    payWithAuthorization(run.fake, {
      hash: HASH,
      authorizer: PAYER,
      nonce: nonceOf(run, order),
      payee: EVM_PAYOUT,
      value: PRICE,
      block: run.fake.safe - 3,
    });
    await node.runtime.handleWrap(receiptWrap(run, buyer, nonceOf(run, order), HASH));
    expect(order.reportedMedia).toEqual({ [HASH]: 'base-devnet' });
    expect(order.paid?.signature).toBe(HASH);
    expect(order.paid?.medium).toBe('base-devnet');
    expect(node.events).toEqual([`deliver:${order.key}`]);
    expect(tempoChecks).toEqual([]);
  });

  it('is found by the sweep for a payer who sends no hash, and delivered', async () => {
    const run = setup();
    const buyer = key();
    const node = harness(run);
    await node.runtime.handleWrap(orderWrap(run, buyer));
    const order = onlyOrder(run);
    payWithAuthorization(run.fake, {
      hash: HASH,
      authorizer: PAYER,
      nonce: nonceOf(run, order),
      payee: EVM_PAYOUT,
      value: PRICE,
      block: run.fake.safe - 3,
    });
    await node.runtime.sweep(true, NOW);
    expect(order.paid?.signature).toBe(HASH);
    expect(node.events).toEqual(['solana', 'tempo', `deliver:${order.key}`]);
  });

  it('leaves a receipt for a chain whose RPC is not verified to the sweep', async () => {
    const run = setup();
    const buyer = key();
    run.context.gate = { kind: 'deferred', attempts: 1, nextAt: NOW + 60, problem: 'x' };
    const checked: string[] = [];
    const node = harness(run, {
      checkEip3009Payment: async (_state, _order, hash) => {
        checked.push(hash);
        return { kind: 'ask_again' };
      },
    });
    await node.runtime.handleWrap(orderWrap(run, buyer));
    await node.runtime.handleWrap(receiptWrap(run, buyer, nonceOf(run, onlyOrder(run)), HASH));
    expect(checked).toEqual([]);
    expect(node.logs.at(-1)).toBe(
      `receipt ${onlyOrder(run).key} ${HASH}: the Base Sepolia RPC is not verified; checked once it is`,
    );
  });
});

describe('the start check at the running node', () => {
  it.each([
    [
      'answers 429',
      () => {
        throw new Error('rpc eth_chainId answered HTTP 429');
      },
    ],
    [
      'times out',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ],
  ] as const)(
    'lets the node start when it %s, sweeps Solana and Tempo, and scans the chain once a later check passes',
    async (_label, failure) => {
      const run = setup();
      run.context.gate = { kind: 'deferred', attempts: 0, nextAt: NOW, problem: 'not checked yet' };
      run.fake.script = () => failure();
      const node = harness(run);
      await node.runtime.handleWrap(orderWrap(run, key()));
      const order = onlyOrder(run);
      payWithAuthorization(run.fake, {
        hash: HASH,
        authorizer: PAYER,
        nonce: nonceOf(run, order),
        payee: EVM_PAYOUT,
        value: PRICE,
        block: run.fake.safe - 3,
      });
      await node.runtime.sweep(true, NOW);
      expect(node.events).toEqual(['solana', 'tempo']);
      expect(run.context.gate.kind).toBe('deferred');
      expect(
        node.logs.some((line) => line.startsWith('WARNING: Base Sepolia RPC not yet verified')),
      ).toBe(true);
      // The RPC recovers; the chain is checked again after its pause.
      run.fake.script = undefined;
      node.clock.now = NOW + 30;
      await node.runtime.sweep(true, NOW + 30);
      expect(order.paid).toBeUndefined();
      node.clock.now = NOW + 60;
      await node.runtime.sweep(true, NOW + 60);
      expect(run.context.gate).toEqual({ kind: 'verified' });
      expect(order.paid?.signature).toBe(HASH);
      expect(node.events).toEqual([
        'solana',
        'tempo',
        'solana',
        'tempo',
        'solana',
        'tempo',
        `deliver:${order.key}`,
      ]);
    },
  );

  it('keeps a mainnet chain off for good when a later check answers [] near the floor, never stopping the node', async () => {
    const run = setup({ caip2: 'eip155:8453' });
    run.context.gate = { kind: 'deferred', attempts: 1, nextAt: NOW + 60, problem: 'HTTP 429' };
    const stops: string[] = [];
    const node = harness(run, { stop: (problem) => stops.push(problem) });
    run.identity.mediums = [run.medium];
    await node.runtime.handleWrap(orderWrap(run, key()));
    for (const at of [NOW + 60, NOW + 120, NOW + 3600]) {
      node.clock.now = at;
      await node.runtime.sweep(true, at);
    }
    expect(run.context.gate).toEqual({
      kind: 'failed',
      problem: expect.stringMatching(/^no USDC transfer in the 1000 blocks/),
    });
    expect(node.logs).toContainEqual(
      expect.stringMatching(
        /^error: Base RPC failed the start check: no USDC transfer.*not scanned until a restart$/,
      ),
    );
    // Only the check's own search: never a payout scan, never a check again.
    const payoutScans = run.fake.calls.filter(
      ({ method, params }) =>
        method === 'eth_getLogs' && (params[0] as { topics: unknown[] }).topics.length === 3,
    );
    expect(payoutScans).toEqual([]);
    expect(run.fake.calls.filter(({ method }) => method === 'eth_chainId')).toHaveLength(1);
    expect(node.events).toEqual(['solana', 'tempo', 'solana', 'tempo', 'solana', 'tempo']);
    expect(stops).toEqual([]);
  });
});

/** A Tempo client that answers no receipt and no head, and notes each receipt it is asked for. */
function tempoReader(): { client: Eip1193Client; receipts: string[] } {
  const receipts: string[] = [];
  return {
    receipts,
    client: {
      request: async ({ method, params = [] }) => {
        if (method === 'eth_getTransactionReceipt') {
          receipts.push(String(params[0]));
        }
        return null;
      },
    },
  };
}

describe('reportedMedia routing at the Tempo catch-up', () => {
  it('never checks a Base hash on Tempo nor spends its budget, and an old entry without a medium stays Tempo', async () => {
    const run = setup();
    const tempoUsdc = 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50';
    run.state.terms = publishTerms(
      run.state.terms,
      { d: D, caip19: tempoUsdc, payout: EVM_PAYOUT, amount: PRICE.toString() },
      NOW - 86_400,
      NOW - 86_400,
    );
    const taken = intake(
      run.state,
      delivered(
        {
          type: 'order',
          storePubkey: run.store.pubkey,
          orderId: ORDER_ID,
          items: [{ product: productAt(run.store), quantity: 1 }],
          total: { amount: '5', currency: 'USD' },
        },
        key(),
        run.store,
        NOW - 3600,
      ),
      run.identity,
      NOW - 3600,
    );
    if (taken.kind !== 'order') {
      throw new Error('no order');
    }
    const order = taken.order;
    // Base hashes reported first, more than a sweep's budget.
    for (let index = 0; index < 25; index += 1) {
      const hash = txHashOf(300 + index);
      order.reportedTxs.push(hash);
      order.recheckedAt = { ...order.recheckedAt, [hash]: NOW - 3000 + index };
      order.reportedMedia = { ...order.reportedMedia, [hash]: 'base-devnet' };
    }
    const legacy = txHashOf(400);
    const tempo = txHashOf(401);
    order.reportedTxs.push(legacy, tempo);
    order.recheckedAt = { ...order.recheckedAt, [legacy]: NOW - 100, [tempo]: NOW - 99 };
    order.reportedMedia = { ...order.reportedMedia, [tempo]: 'tempo' };
    const reader = tempoReader();
    const chain = chainByCaip2('eip155:4217');
    if (chain === undefined) {
      throw new Error('no Tempo');
    }
    const context: TempoContext = {
      client: reader.client,
      chain,
      medium: 'tempo',
      storePubkey: run.store.pubkey,
    };
    await catchUpTempo(run.state, context, NOW);
    expect(reader.receipts).toEqual([legacy, tempo]);
  });
});

describe('the node config and offer checks for eip3009 chains', () => {
  it('makes one context per evm entry, on the node network, with its own range cap', () => {
    const contexts = eip3009ContextsFor(
      {
        network: 'devnet',
        evm: {
          base: { rpcUrl: 'https://base.example' },
          arbitrum: { rpcUrl: 'https://arb.example', logRangeCap: 100_000, credit: 'safe' },
        },
      },
      'a'.repeat(64),
    );
    expect(
      contexts.map((context: Eip3009Context) => [
        context.chain.caip2,
        context.medium,
        context.rangeCap,
        context.asset.symbol,
        context.gate.kind,
        context.credit,
      ]),
    ).toEqual([
      ['eip155:421614', 'arbitrum-devnet', 100_000, 'USDC', 'deferred', 'safe'],
      // No `credit`: fast.
      ['eip155:84532', 'base-devnet', 1000, 'USDC', 'deferred', 'fast'],
    ]);
  });

  it('honours an eip3009 payout only for a chain of its evm block, on its network', () => {
    const run = setup();
    const owner = key();
    const payto = finalizeEvent(
      buildPaytoEvent({
        accept: [{ caip19: run.caip19, address: EVM_PAYOUT }],
        createdAt: NOW - 100,
      }),
      owner.secretKey,
    );
    expect(parsePayto(payto).targets).toHaveLength(1);
    const listing = finalizeEvent(
      buildProductEvent({
        d: D,
        title: 'Course',
        description: '',
        price: { amount: '5', currency: 'USD' },
        accept: [run.caip19],
        createdAt: NOW - 100,
      }),
      run.store.secretKey,
    );
    const standing = [{ d: D, caip19: run.caip19, payout: EVM_PAYOUT, amount: PRICE.toString() }];
    expect(
      offersNotHonoured([listing], payto, 'devnet', standing, undefined, ['eip155:84532']),
    ).toEqual([]);
    expect(
      offersNotHonoured([listing], payto, 'devnet', standing, undefined, ['eip155:421614']),
    ).toEqual([`${run.caip19} ${EVM_PAYOUT}`]);
    expect(
      offersNotHonoured([listing], payto, 'mainnet', standing, undefined, ['eip155:84532']),
    ).toEqual([`${run.caip19} ${EVM_PAYOUT}`]);
    expect(
      offersNotHonoured(
        [listing],
        payto,
        'devnet',
        [{ d: D, caip19: run.caip19, payout: OTHER_PAYOUT, amount: PRICE.toString() }],
        undefined,
        ['eip155:84532'],
      ),
    ).toEqual([`${run.caip19} ${EVM_PAYOUT}`, `${D}: ${run.caip19} at ${PRICE}`]);
    expect(
      configProblems({
        name: 'Store',
        network: 'devnet',
        evm: { base: { rpcUrl: 'https://base.example' } },
        inboxRelays: ['wss://relay.elisym.network'],
        payouts: [{ caip19: run.caip19, address: EVM_PAYOUT }],
      }),
    ).toEqual([]);
  });
});

/** A second `eip3009` chain for the run's store: its own fake chain and context. */
function secondChain(run: Run, caip2: string): { fake: NodeChain; context: Eip3009Context } {
  const fake = nodeChain({ caip2, headTime: NOW });
  return {
    fake,
    context: {
      client: fake.client,
      chain: fake.chain,
      asset: fake.asset,
      medium: mediumOf(fake.chain),
      storePubkey: run.store.pubkey,
      rangeCap: fake.chain.logRangeCap ?? 1000,
      credit: 'safe',
      samples: new Map(),
      scan: newScanMemory(),
      gate: { kind: 'verified' },
    },
  };
}

function payOrder(run: Run, order: MerchantOrder, hash = HASH): void {
  payWithAuthorization(run.fake, {
    hash,
    authorizer: PAYER,
    nonce: nonceOf(run, order),
    payee: EVM_PAYOUT,
    value: PRICE,
    block: run.fake.safe - 3,
  });
}

describe('review round 1 at the running node', () => {
  it('judges each chain only by its own bindings and receipts, on a node with two eip3009 chains', async () => {
    const run = setup();
    const arbitrum = secondChain(run, 'eip155:421614');
    // Arbitrum's sweep runs first: a Base binding must never be judged there.
    const node = harness(run, { eip3009: [arbitrum.context, run.context] });
    await node.runtime.handleWrap(orderWrap(run, key()));
    const order = onlyOrder(run);
    payOrder(run, order);
    await node.runtime.sweep(true, NOW);
    expect(order.paid?.medium).toBe('base-devnet');
    // Even with the order open again and the Base binding cached, Arbitrum reads none of it.
    delete order.paid;
    await node.runtime.sweep(true, NOW + 60);
    expect(
      arbitrum.fake.calls.filter(({ method }) => method === 'eth_getTransactionReceipt'),
    ).toEqual([]);
    expect(node.logs.some((line) => line.includes('catch-up failed'))).toBe(false);
    // Judged on Arbitrum, the Base payment would be set aside as refused for good.
    const again = run.state.orders[order.key];
    expect(again?.refusedTxs).toBeUndefined();
    expect(again?.paid?.signature).toBe(HASH);
  });

  it('credits a payment to a chain that was off once its check passes, with and without a receipt', async () => {
    const run = setup();
    run.context.gate = { kind: 'deferred', attempts: 1, nextAt: NOW + 60, problem: 'HTTP 429' };
    const node = harness(run);
    const buyer = key();
    await node.runtime.handleWrap(orderWrap(run, buyer));
    await node.runtime.handleWrap(orderWrap(run, key(), 'b3a7c2d4-0000-4000-8000-00000000e002'));
    const [reported, silent] = Object.values(run.state.orders);
    if (reported === undefined || silent === undefined) {
      throw new Error('no orders');
    }
    payOrder(run, reported, txHashOf(51));
    payOrder(run, silent, txHashOf(52));
    await node.runtime.handleWrap(receiptWrap(run, buyer, nonceOf(run, reported), txHashOf(51)));
    await node.runtime.sweep(true, NOW);
    expect([reported.paid, silent.paid]).toEqual([undefined, undefined]);
    node.clock.now = NOW + 60;
    await node.runtime.sweep(true, NOW + 60);
    expect([reported.paid?.signature, silent.paid?.signature]).toEqual([
      txHashOf(51),
      txHashOf(52),
    ]);
  });

  it('credits a payment to a chain turned off until a restart once the node restarts', async () => {
    const run = setup();
    run.context.gate = { kind: 'failed', problem: 'refused' };
    const node = harness(run);
    await node.runtime.handleWrap(orderWrap(run, key()));
    const order = onlyOrder(run);
    payOrder(run, order);
    await node.runtime.sweep(true, NOW);
    expect(order.paid).toBeUndefined();
    // A restart: a new context, checked at start, on the same ledger.
    run.context.gate = { kind: 'verified' };
    run.context.scan = newScanMemory();
    const restarted = harness(run);
    await restarted.runtime.sweep(true, NOW + 60);
    expect(order.paid?.signature).toBe(HASH);
  });

  it('credits from a ledger saved before 0.12, which has no eip3009Bindings', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    payOrder(run, order);
    const path = join(mkdtempSync(join(tmpdir(), 'merchant-ledger-')), 'ledger.json');
    const old: Record<string, unknown> = JSON.parse(JSON.stringify(run.state));
    delete old.eip3009Bindings;
    writeFileSync(path, JSON.stringify(old));
    const { state } = loadLedger(path);
    expect(state.eip3009Bindings).toEqual({});
    expect((await catchUpEip3009(state, run.context, NOW)).paid.map((paid) => paid.key)).toEqual([
      order.key,
    ]);
  });

  /** The run log's lines that start with `warning: `, from a node that swept `sweeps` times. */
  async function warningsAfter(run: Run, sweeps: number): Promise<string[]> {
    const node = harness(run);
    for (let index = 0; index < sweeps; index += 1) {
      node.clock.now = NOW + index * 60;
      await node.runtime.sweep(true, node.clock.now);
    }
    return node.logs.filter((line) => line.startsWith('warning: '));
  }

  function failingOn(run: Run, wanted: (method: string, params: readonly unknown[]) => boolean) {
    run.fake.script = (method, params) => {
      if (wanted(method, params)) {
        throw new Error(`rpc ${method} answered HTTP 503`);
      }
      return undefined;
    };
  }

  it.each([
    [
      'a chunk failing on two sweeps',
      (run: Run) =>
        failingOn(run, (method, params) => {
          const filter = params[0] as { toBlock?: string } | undefined;
          return method === 'eth_getLogs' && filter?.toBlock === `0x${run.fake.safe.toString(16)}`;
        }),
      2,
      /^warning: Base Sepolia: blocks \d+-\d+ of transfers to 0x5696\S+ failed on 2 sweeps in a row; older payments on Base Sepolia may be missed$/,
    ],
    [
      'a receipt failing on two sweeps',
      (run: Run) => {
        plainTransfer(run.fake, {
          hash: txHashOf(60),
          from: PAYER,
          to: EVM_PAYOUT,
          value: PRICE,
          block: run.fake.safe - 5,
        });
        failingOn(
          run,
          (method, params) => method === 'eth_getTransactionReceipt' && params[0] === txHashOf(60),
        );
      },
      2,
      new RegExp(
        `^warning: Base Sepolia: the receipt of ${txHashOf(60)} failed on 2 sweeps in a row; older payments on Base Sepolia may be missed$`,
      ),
    ],
    [
      'hits left unread across sweeps',
      (run: Run) => {
        for (let index = 0; index < 2 * EIP3009_BIND_READS + 6; index += 1) {
          plainTransfer(run.fake, {
            hash: txHashOf(1000 + index),
            from: PAYER,
            to: EVM_PAYOUT,
            value: PRICE,
            block: run.fake.safe - 1500 + index,
          });
        }
      },
      2,
      /^warning: Base Sepolia: 6 transfer\(s\) to the payouts not read yet; older payments on Base Sepolia may be missed$/,
    ],
    [
      'a head that cannot be read',
      (run: Run) =>
        failingOn(
          run,
          (method, params) => method === 'eth_getBlockByNumber' && params[0] === 'safe',
        ),
      1,
      /^warning: Base Sepolia: the chain's head could not be read; payments there were not scanned this time$/,
    ],
    [
      'an implementation that cannot be read',
      (run: Run) => failingOn(run, (method) => method === 'eth_getStorageAt'),
      1,
      /^warning: Base Sepolia: the USDC implementation could not be read at block \d+; no transfer is set aside as unbound this time$/,
    ],
    [
      'an implementation that changed',
      (run: Run) => {
        run.fake.implementation = `0x${'99'.repeat(20)}`;
      },
      1,
      /^warning: WARNING: Base Sepolia: the USDC proxy runs implementation 0x9{40}, not the pinned 0x\S+: upgrade the node; no transfer is set aside as unbound meanwhile$/,
    ],
  ] as const)('logs %s', async (_label, arrange, sweeps, expected) => {
    const run = setup();
    orderAt(run, NOW - 3600);
    arrange(run);
    expect(await warningsAfter(run, sweeps)).toContainEqual(expect.stringMatching(expected));
  });
});

describe('the receipt mediums of a store with eip3009 chains', () => {
  it('lists each evm entry, so intake takes a receipt for a configured chain', () => {
    const run = setup();
    const contexts = eip3009ContextsFor(
      { network: 'devnet', evm: { base: { rpcUrl: 'https://base.example' } } },
      run.store.pubkey,
    );
    const mediums = storeMediums('solana-devnet', undefined, contexts);
    expect(mediums).toEqual(['solana-devnet', 'base-devnet']);
    expect(storeMediums(undefined, 'tempo', [])).toEqual(['tempo']);
    expect(
      storeMediums(undefined, undefined, [
        { medium: 'base-devnet' },
        { medium: 'arbitrum-devnet' },
      ]),
    ).toEqual(['base-devnet', 'arbitrum-devnet']);
    run.identity.mediums = mediums;
    const buyer = key();
    const order = intake(
      run.state,
      delivered(
        {
          type: 'order',
          storePubkey: run.store.pubkey,
          orderId: ORDER_ID,
          items: [{ product: productAt(run.store), quantity: 1 }],
          total: { amount: '5', currency: 'USD' },
        },
        buyer,
        run.store,
        NOW - 3600,
      ),
      run.identity,
      NOW - 3600,
    );
    if (order.kind !== 'order') {
      throw new Error('no order');
    }
    const receipt = intake(
      run.state,
      delivered(
        {
          type: 'receipt',
          storePubkey: run.store.pubkey,
          orderId: ORDER_ID,
          payment: { medium: 'base-devnet', reference: nonceOf(run, order.order), tx: HASH },
        },
        buyer,
        run.store,
        NOW - 60,
      ),
      run.identity,
      NOW - 60,
    );
    expect(receipt.kind).toBe('receipt');
  });
});

describe('review round 4: the wiring of the eip3009 rail', () => {
  it('queues the order.paid webhook with an eip3009 payment, keyed by its transaction hash', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    payOrder(run, order);
    const outbox = { storePubkey: run.store.pubkey, now: () => NOW };
    // Through the contexts a node builds from its config, as `run` does.
    const [context] = eip3009ContextsFor(
      { network: 'devnet', evm: { base: { rpcUrl: 'https://base.example' } } },
      run.store.pubkey,
      { outbox, clientFor: () => run.fake.client },
    );
    if (context === undefined) {
      throw new Error('no context');
    }
    expect(context.outbox).toBe(outbox);
    expect((await checkEip3009Payment(run.state, order, HASH, context)).kind).toBe('paid');
    expect(order.webhook).toMatchObject({
      state: 'pending',
      eventId: webhookEventId(run.store.pubkey, order.key, HASH),
      createdAt: NOW,
    });
  });

  it('starts the rail through its start check: a mainnet RPC answering [] near the floor refuses start-up', async () => {
    const run = setup({ caip2: 'eip155:8453' });
    const config = {
      network: 'mainnet' as const,
      evm: { base: { rpcUrl: 'https://base.example' } },
    };
    await expect(
      startEip3009Rail(config, run.store.pubkey, {
        now: NOW,
        log: () => undefined,
        clientFor: () => run.fake.client,
      }),
    ).rejects.toThrow(/^Base RPC failed the start check: no USDC transfer in the 1000 blocks/);
  });

  it('starts a rail with a deferred chain and its outbox, and lists its chains for the offer check', async () => {
    const run = setup();
    run.fake.script = () => {
      throw new Error('rpc eth_chainId answered HTTP 503');
    };
    const outbox = { storePubkey: run.store.pubkey, now: () => NOW };
    const config = {
      network: 'devnet' as const,
      evm: {
        base: { rpcUrl: 'https://base.example' },
        ethereum: { rpcUrl: 'https://eth.example' },
      },
    };
    const contexts = await startEip3009Rail(config, run.store.pubkey, {
      now: NOW,
      log: () => undefined,
      outbox,
      clientFor: () => run.fake.client,
    });
    expect(
      contexts.map((context) => [context.chain.caip2, context.gate.kind, context.outbox]),
    ).toEqual([
      ['eip155:11155111', 'deferred', outbox],
      ['eip155:84532', 'deferred', outbox],
    ]);
    expect(eip3009ChainsOf(config)).toEqual(['eip155:11155111', 'eip155:84532']);
    expect(
      eip3009ChainsOf({ network: 'mainnet', evm: { arbitrum: { rpcUrl: 'https://a.example' } } }),
    ).toEqual(['eip155:42161']);
    expect(eip3009ChainsOf({ network: 'devnet' })).toEqual([]);
  });

  it('checks a receipt for the SECOND chain of a two-chain node on that chain, live, before any sweep', async () => {
    const run = setup();
    const arbitrum = secondChain(run, 'eip155:421614');
    const arbitrumUsdc = `${arbitrum.fake.chain.caip2}/erc20:${arbitrum.fake.mint}`;
    run.state.terms = publishTerms(
      run.state.terms,
      { d: D, caip19: arbitrumUsdc, payout: EVM_PAYOUT, amount: PRICE.toString() },
      NOW - 5 * 86_400,
      NOW - 5 * 86_400,
    );
    run.identity.mediums = [run.medium, arbitrum.context.medium];
    const node = harness(run, { eip3009: [run.context, arbitrum.context] });
    const buyer = key();
    await node.runtime.handleWrap(orderWrap(run, buyer));
    const order = onlyOrder(run);
    payWithAuthorization(arbitrum.fake, {
      hash: HASH,
      authorizer: PAYER,
      nonce: nonceOf(run, order),
      payee: EVM_PAYOUT,
      value: PRICE,
      block: arbitrum.fake.safe - 3,
    });
    await node.runtime.handleWrap(
      receiptWrap(run, buyer, nonceOf(run, order), HASH, 'arbitrum-devnet'),
    );
    expect(order.paid?.medium).toBe('arbitrum-devnet');
    expect(order.paid?.caip19).toBe(arbitrumUsdc);
    expect(run.fake.calls.filter(({ method }) => method === 'eth_getTransactionReceipt')).toEqual(
      [],
    );
  });

  it.each([
    [
      'a transfer with no leg for the order',
      (run: Run) =>
        plainTransfer(run.fake, {
          hash: HASH,
          from: PAYER,
          to: EVM_PAYOUT,
          value: PRICE,
          block: run.fake.safe - 3,
        }),
      'noLegTxs',
    ],
    [
      'a leg below the order floor',
      (run: Run, order: MerchantOrder) =>
        payWithAuthorization(run.fake, {
          hash: HASH,
          authorizer: PAYER,
          nonce: nonceOf(run, order),
          payee: EVM_PAYOUT,
          value: PRICE,
          block: blockAt(run, NOW - 3600 - 1800) - 10,
        }),
      'refusedTxs',
    ],
  ] as const)('keeps the live verdict on %s without a sweep', async (_label, land, field) => {
    const run = setup();
    const node = harness(run);
    const buyer = key();
    await node.runtime.handleWrap(orderWrap(run, buyer));
    const order = onlyOrder(run);
    land(run, order);
    await node.runtime.handleWrap(receiptWrap(run, buyer, nonceOf(run, order), HASH));
    expect(order[field]).toEqual([HASH]);
    expect(order.paid).toBeUndefined();
  });
});

describe('review round 8: every gate transition from its real initial state', () => {
  function builtContext(run: Run): Eip3009Context {
    const [context] = eip3009ContextsFor(
      { network: 'devnet', evm: { base: { rpcUrl: 'https://base.example' } } },
      run.store.pubkey,
      { clientFor: () => run.fake.client },
    );
    if (context === undefined) {
      throw new Error('no context');
    }
    return context;
  }

  it('starts not checked, is verified by a start check that passes, and checks a live receipt at once', async () => {
    const run = setup();
    const context = builtContext(run);
    expect(context.gate).toEqual({
      kind: 'deferred',
      attempts: 0,
      nextAt: 0,
      problem: 'not checked yet',
    });
    await startEip3009Chains([context], NOW, () => undefined);
    expect(context.gate).toEqual({ kind: 'verified' });
    const node = harness(run, { eip3009: [context] });
    const buyer = key();
    await node.runtime.handleWrap(orderWrap(run, buyer));
    const order = onlyOrder(run);
    payOrder(run, order);
    await node.runtime.handleWrap(receiptWrap(run, buyer, nonceOf(run, order), HASH));
    expect(order.paid?.signature).toBe(HASH);
  });

  it('defers a freshly built chain on a transient start check, backing off from 60 seconds', async () => {
    const run = setup();
    const context = builtContext(run);
    await startEip3009Chains(
      [context],
      NOW,
      () => undefined,
      async () => ({
        kind: 'transient',
        problem: 'HTTP 503',
      }),
    );
    expect(context.gate).toEqual({
      kind: 'deferred',
      attempts: 1,
      nextAt: NOW + 60,
      problem: 'HTTP 503',
    });
    await sweepEip3009(run.state, context, NOW + 60, () => undefined, {
      check: async () => ({ kind: 'transient', problem: 'HTTP 503' }),
    });
    expect(context.gate).toEqual({
      kind: 'deferred',
      attempts: 2,
      nextAt: NOW + 180,
      problem: 'HTTP 503',
    });
  });

  it('turns a deferred chain off until a restart on a wrong answer, and a freshly built one stops start-up', async () => {
    const run = setup();
    const deferred = builtContext(run);
    await startEip3009Chains(
      [deferred],
      NOW,
      () => undefined,
      async () => ({
        kind: 'transient',
        problem: 'HTTP 429',
      }),
    );
    const logs: string[] = [];
    await sweepEip3009(run.state, deferred, NOW + 60, (line) => logs.push(line), {
      check: async () => ({ kind: 'wrong', problem: 'HTTP 404' }),
    });
    expect(deferred.gate).toEqual({ kind: 'failed', problem: 'HTTP 404' });
    // Off for good: never checked or scanned again.
    let checks = 0;
    await sweepEip3009(run.state, deferred, NOW + 10_000, () => undefined, {
      check: async () => {
        checks += 1;
        return { kind: 'passed' };
      },
      catchUp: async () => {
        throw new Error('scanned');
      },
    });
    expect(checks).toBe(0);
    const fresh = builtContext(run);
    await expect(
      startEip3009Chains(
        [fresh],
        NOW,
        () => undefined,
        async () => ({
          kind: 'wrong',
          problem: 'HTTP 401',
        }),
      ),
    ).rejects.toThrow('Base Sepolia RPC failed the start check: HTTP 401');
  });
});

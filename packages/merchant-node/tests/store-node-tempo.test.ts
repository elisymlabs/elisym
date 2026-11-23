/**
 * A store node taking Tempo payouts, against pay-core's fake chain: its sweep
 * finds a payment no receipt reported and saves it with its webhook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSFER_WITH_MEMO_TOPIC } from '../../pay-core/src/evm/constants';
import { type FakeChainOptions, fakeTempoChain } from '../../pay-core/tests/tempo-chain';
import type { MerchantConfig } from '../src/config';
import { intake, storeIdentity } from '../src/intake';
import { emptyLedger } from '../src/ledger';
import type { ListenerPool } from '../src/listener';
import type { PublishPool, PublishRelay } from '../src/publish';
import { startStoreNode } from '../src/store-node';
import { tempoMemo } from '../src/tempo';
import { publishTerms } from '../src/terms';
import { D, T0, key, orderFrom } from './fixtures';

const USDCE = '0x20c000000000000000000000b9537d11c60e8b50';
const TEMPO_USDC = `eip155:4217/erc20:${USDCE}`;
const PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const PAYER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const PRICE = 49_000_000n;
const HEAD = 40_000_000;
const HEAD_TIME = T0 + 3600;
const LAND = HEAD - 100;
const HASH = `0x${'ab'.repeat(32)}`;
const RELAY = 'wss://inbox.example.com';

const CONFIG: MerchantConfig = {
  name: 'Shop',
  network: 'devnet',
  payouts: [],
  inboxRelays: [RELAY],
  tempo: { network: 'mainnet' },
};

function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

/** One block per second up to the head: every block has a time. */
function timestamps(): Record<number, number> {
  return new Proxy({} as Record<number, number>, {
    get: (_target, property) => {
      const number = Number(property);
      return Number.isInteger(number) && number >= 0 && number <= HEAD
        ? HEAD_TIME - (HEAD - number)
        : undefined;
    },
  });
}

/** Ordinary traffic on the coin: without it an empty window cannot be vouched for. */
function controlTraffic(): NonNullable<FakeChainOptions['logs']> {
  return [HEAD - 5400, HEAD - 50].map((blockNumber, index) => ({
    address: USDCE,
    topics: [`0x${'55'.repeat(32)}`],
    data: '0x',
    blockNumber,
    transactionHash: `0x${String(index + 2)
      .repeat(2)
      .repeat(32)}`,
    logIndex: 0,
  }));
}

class FakePool implements ListenerPool, PublishPool {
  subscribe() {
    return { close: () => undefined };
  }

  subscribeEose() {
    return { close: () => undefined };
  }

  ensureRelay(): Promise<PublishRelay> {
    return Promise.resolve({
      publish: () => Promise.resolve(''),
      auth: () => Promise.resolve(''),
    });
  }
}

async function settle() {
  for (let turn = 0; turn < 40; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('a store node taking Tempo payouts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves a payment its sweep finds together with its webhook, and completes it', async () => {
    const store = key();
    const buyer = key();
    const state = emptyLedger();
    state.terms = publishTerms(
      [],
      { d: D, caip19: TEMPO_USDC, payout: PAYOUT, amount: PRICE.toString() },
      T0 - 86_400,
      T0 - 86_400,
    );
    const taken = intake(
      state,
      orderFrom(buyer, store, 'b3a7c2d4-0000-4000-8000-000000000001'),
      storeIdentity(store.pubkey, [D], ['tempo']),
    );
    if (taken.kind !== 'order') {
      throw new Error('order not taken');
    }
    const memo = tempoMemo(taken.order, store.pubkey);
    const log = {
      address: USDCE,
      topics: [TRANSFER_WITH_MEMO_TOPIC, `0x${word(PAYER)}`, `0x${word(PAYOUT)}`, memo],
      data: `0x${word(PRICE)}`,
      blockNumber: LAND,
      transactionHash: HASH,
      logIndex: 0,
    };
    const at = `0x${LAND.toString(16)}`;
    const options = {
      chainId: '0x1079',
      finalized: HEAD,
      timestamps: timestamps(),
      receipts: {
        [HASH]: {
          transactionHash: HASH,
          status: '0x1',
          blockNumber: at,
          blockHash: `0x${'cd'.repeat(32)}`,
          logs: [{ ...log, blockNumber: at, logIndex: '0x0', blockHash: `0x${'cd'.repeat(32)}` }],
        },
      } as Record<string, unknown>,
      logs: [...controlTraffic(), log],
    };
    const snapshots: string[] = [];
    const node = await startStoreNode({
      pool: new FakePool(),
      config: CONFIG,
      products: new Map(),
      state,
      storePubkey: store.pubkey,
      storeSecretKey: store.secretKey,
      tempoClient: fakeTempoChain(options).client,
      save: () => {
        snapshots.push(JSON.stringify(state));
      },
      refreshTreasuries: async () => ({ kind: 'unreachable', problem: 'offline' }),
      eip3009: [],
      outbox: { storePubkey: store.pubkey, now: () => HEAD_TIME },
      log: () => undefined,
      now: () => HEAD_TIME,
      stop: () => undefined,
    });
    await settle();
    const order = state.orders[taken.order.key];
    expect(order?.paid?.signature).toBe(HASH);
    expect(order?.webhook?.state).toBe('pending');
    expect(order?.deliveredAt).toBe(HEAD_TIME);
    const withPayment = snapshots
      .map((text) => JSON.parse(text) as typeof state)
      .filter((snapshot) => snapshot.orders[taken.order.key]?.paid !== undefined);
    expect(withPayment.length).toBeGreaterThan(0);
    for (const snapshot of withPayment) {
      expect(snapshot.orders[taken.order.key]?.webhook?.state).toBe('pending');
    }
    await node.stop();
  });
});

/**
 * The widget paying USDC over EIP-3009 (Ethereum, Arbitrum, Base): offered only
 * with the build's own RPC of that chain and network, at a protocol fee of 0
 * (E7); paid from an EIP-6963 wallet against a fake chain and a wallet that
 * signs with a real key; its own timers (a retry at once, another wallet after
 * the end proof, "taking long" from the registry waits); and the load-time
 * reconciliation that ends a signed attempt only through the end proof.
 */
import {
  type OrderMessage,
  buildOrderMessage,
  parseCaip19,
  wrapOrderMessage,
} from '@elisym/commerce';
import {
  EIP3009_VALID_SECS,
  type Eip3009Wallet,
  type LoadedOffer,
  type OrderRecord,
  OrderStore,
  applyStatus,
  type PricedPayout,
  SEND_MARGIN_SECS,
  loadOffer,
} from '@elisym/commerce/buyer';
import { CHAINS, type ChainConfig, FeeConfigError, assetsFor } from '@elisym/pay-core';
import type { Eip1193Client } from '@elisym/pay-core/evm';
import { IDBFactory } from 'fake-indexeddb';
import { hexToBytes } from 'nostr-tools/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeChain,
  type WalletState,
  blockHashOf,
  fakeChain,
  fakeWallet,
  land,
  selectorOf,
} from '../../commerce/tests/buyer/eip3009-chain';
import {
  EIP3009_USDC,
  MemoryRelays,
  NOW,
  type Shop,
  USDC_DEVNET_CAIP19,
  inboxList,
  makeShop,
  solanaAddress,
} from '../../commerce/tests/buyer/fixtures';
import { EIP3009_CHAINS, eip3009RpcEnvName, eip3009RpcUrls } from '../src/app/evm-rpc';
import { recordRail } from '../src/app/receipts';
import {
  type Banner,
  CheckoutSession,
  type SessionDeps,
  UNSURE_AFTER_SECS,
  type View,
} from '../src/app/session';
import { EIP3009_WAIT, FEE_HIDES_EIP3009, eip3009SendWords } from '../src/app/ui/text';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';
const PAYEE = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const PRICE = 49_000_000n;
const SECRET = hexToBytes('11'.repeat(32));
const OTHER_SECRET = hexToBytes('22'.repeat(32));
const BASE_SEPOLIA = CHAINS.BASE_DEVNET;
const GET_L1_FEE = '0x49948e0e';
const AUTHORIZATION_STATE = '0xe94a0102';
const NO_NETWORK = 'This network is not available here yet.';

type Ready = Extract<LoadedOffer, { ok: true }>;
type WaitingView = Extract<View, { kind: 'waiting_payment' }>;
type OfferView = Extract<View, { kind: 'offer' }>;

let store: OrderStore;
let backend: IndexedDbOrderBackend;

beforeEach(async () => {
  backend = new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory()));
  store = new OrderStore(backend);
});

// The fake chain answers on microtasks only: without this the worker never
// reaches its event loop and a slow CI runner times out vitest's own RPC.
/**
 * Every request a Tempo client of this file is asked: none may be, ever. The
 * default deps carry a Tempo client on every network, as production does, so
 * an `eip3009` record that reaches a Tempo helper fails the test that drove it.
 */
const TEMPO_CALLS: string[] = [];
const TEMPO_EVERYWHERE: Eip1193Client = {
  request: async ({ method }) => {
    TEMPO_CALLS.push(method);
    throw new Error('an eip3009 record reached a Tempo client');
  },
};

beforeEach(() => {
  TEMPO_CALLS.length = 0;
});

afterEach(() => {
  expect(TEMPO_CALLS).toEqual([]);
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

class Timers {
  private next = 1;
  readonly running = new Map<number, () => void>();
  set = (handler: () => void) => {
    const id = this.next;
    this.next += 1;
    this.running.set(id, handler);
    return id;
  };
  clear = (id: unknown) => {
    this.running.delete(id as number);
  };
  async tick(): Promise<void> {
    for (const handler of [...this.running.values()]) {
      handler();
    }
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 80; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function caip19Of(chain: ChainConfig): string {
  const [coin] = assetsFor(chain.slug, chain.network);
  return `${chain.caip2}/erc20:${coin?.mint ?? ''}`;
}

/** A priced payout of `caip19` to `address`, as a verified offer lists it. */
function payoutOf(caip19: string, address: string, amount = PRICE): PricedPayout {
  const parsed = parseCaip19(caip19);
  if (parsed === undefined) {
    throw new Error(`not a registry coin: ${caip19}`);
  }
  return { target: { caip19: parsed, address, walletSigned: true }, amount };
}

/** The offer with exactly these payouts, in this order. */
function listing(offer: Ready, payouts: PricedPayout[]): Ready {
  return {
    ...offer,
    offer: { ...offer.offer, payouts: payouts.map((payout) => payout.target) },
    payouts,
  };
}

const SOLANA_DEVNET_USDC = USDC_DEVNET_CAIP19;
const TEMPO_MAINNET_USDC = 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50';
const TEMPO_DEVNET_USDC = 'eip155:42431/erc20:0x20c0000000000000000000000000000000000000';

interface Run {
  shop: Shop;
  offer: Ready;
  relays: MemoryRelays;
  chain: FakeChain;
  wallet: WalletState;
  other: WalletState;
  timers: Timers;
  views: View[];
  banners: Banner[];
  deps: SessionDeps;
  fee: { bps: number };
  /** Whether the build serves the chain paid on (an unset variable: `false`). */
  served: { on: boolean };
  /** How the build RPC answers `eth_getTransactionByHash`. */
  reads: SenderReads;
  session: CheckoutSession;
  advance(seconds: number): void;
  now(): number;
  last(): View | undefined;
}

async function setup(
  options: {
    chain?: ChainConfig;
    transform?: (offer: Ready) => Ready;
    /** The build's RPC of each `eip3009` chain; default: only the chain paid on. */
    eip3009For?: (chain: ChainConfig, client: Eip1193Client) => Eip1193Client | undefined;
    feeBps?: number;
    deps?: Partial<SessionDeps>;
  } = {},
): Promise<Run> {
  const chainConfig = options.chain ?? BASE_SEPOLIA;
  const transform = options.transform ?? ((offer: Ready) => offer);
  const shop = makeShop({ caip19: caip19Of(chainConfig), payout: PAYEE });
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const load = async (now: number): Promise<LoadedOffer> => {
    const loaded = await loadOffer(shop.naddr, {
      client: relays,
      pageOrigin: PAGE,
      families: ['solana', 'evm'],
      now,
    });
    return loaded.ok ? transform(loaded) : loaded;
  };
  const offer = (await load(NOW)) as Ready;
  const [asset] = assetsFor(chainConfig.slug, chainConfig.network);
  if (asset === undefined) {
    throw new Error('no asset');
  }
  const chain = fakeChain(chainConfig, asset, NOW);
  const first = fakeWallet(SECRET, chainConfig.evmChainId ?? 0);
  const second = fakeWallet(OTHER_SECRET, chainConfig.evmChainId ?? 0);
  for (const account of [first.state.account, second.state.account]) {
    chain.tokens.set(account, PRICE * 2n);
    chain.native.set(account, 10n ** 18n);
  }
  const reads = readsOf(chain, [first.wallet, second.wallet]);
  const timers = new Timers();
  const views: View[] = [];
  const banners: Banner[] = [];
  const fee = { bps: options.feeBps ?? 0 };
  let clock = NOW + 30;
  const served = { on: true };
  const eip3009For =
    options.eip3009For ??
    ((each: ChainConfig, client: Eip1193Client) =>
      served.on && each.caip2 === chainConfig.caip2 ? client : undefined);
  const deps: SessionDeps = {
    store,
    readClient: relays,
    clientFor: () => relays,
    rpcFor: () => undefined,
    feeTerms: async () => ({ feeBps: fee.bps, treasury: '' }),
    wallets: () => [],
    tempoFor: () => TEMPO_EVERYWHERE,
    tempoWallets: () => [],
    eip3009For: (each) => eip3009For(each, chain.client),
    eip3009Wallets: () => [
      { name: 'MetaMask', wallet: first.wallet },
      { name: 'Rabby', wallet: second.wallet },
    ],
    reloadOffer: () => load(clock),
    now: () => clock,
    chainTime: async () => clock,
    setInterval: timers.set,
    clearInterval: timers.clear,
    setTimeout: timers.set,
    clearTimeout: timers.clear,
    onView: (view) => views.push(view),
    onStatus: () => undefined,
    onBanner: (banner) => {
      if (banner !== undefined) {
        banners.push(banner);
      }
    },
    ...options.deps,
  };
  return {
    shop,
    offer,
    relays,
    chain,
    wallet: first.state,
    other: second.state,
    timers,
    views,
    banners,
    deps,
    fee,
    served,
    reads,
    session: new CheckoutSession(offer, deps),
    advance: (seconds) => {
      clock += seconds;
    },
    now: () => clock,
    last: () => views.at(-1),
  };
}

async function recordOf(run: Run): Promise<OrderRecord> {
  const [record, ...rest] = await store.forProduct(run.offer.productAddress);
  if (record === undefined || rest.length > 0) {
    throw new Error('expected one order');
  }
  return record;
}

function markerOf(record: OrderRecord) {
  const marker = record.marker;
  if (marker?.rail !== 'eip3009') {
    throw new Error('no eip3009 marker');
  }
  return marker;
}

function waiting(run: Run): WaitingView {
  const view = run.last();
  if (view?.kind !== 'waiting_payment') {
    throw new Error(`expected the wait, got ${view?.kind}`);
  }
  return view;
}

function offerView(run: Run): OfferView {
  const view = run.last();
  if (view?.kind !== 'offer') {
    throw new Error(`expected the offer, got ${view?.kind}`);
  }
  return view;
}

/** A first attempt whose send prompt the buyer declined: signed, not sent. */
async function signedNotSent(run: Run): Promise<OrderRecord> {
  run.wallet.sendError = { code: 4001 };
  await run.session.start();
  await run.session.pay('MetaMask');
  run.wallet.sendError = undefined;
  return await recordOf(run);
}

/** Past the end proof of `record`: a finalized block after its `validBefore`, and the clock at `switchAt`. */
function pastSwitch(run: Run, record: OrderRecord): void {
  const validBefore = Number(markerOf(record).validBefore);
  run.chain.finalized = { number: 1100, timestamp: validBefore + 1 };
  run.chain.safe = { number: 1150, timestamp: validBefore + 30 };
  run.chain.latest = { number: 1200, timestamp: validBefore + 60 };
  const waits = BASE_SEPOLIA.waits;
  run.advance(validBefore + waits.finalizedSecs - run.now());
}

/** A new page load over the same store and chain, with the same deps. */
async function reload(run: Run, deps: Partial<SessionDeps> = {}): Promise<CheckoutSession> {
  run.session.dispose();
  const session = new CheckoutSession(run.offer, { ...run.deps, ...deps });
  await session.start();
  await settle();
  return session;
}

describe('which eip3009 payouts the widget offers', () => {
  /** The session's first view for `offer`, with the build serving the chains `env` names. */
  async function firstView(
    offer: (base: Ready) => Ready,
    env: Record<string, string>,
    deps: Partial<SessionDeps> = {},
  ): Promise<View | undefined> {
    const urls = eip3009RpcUrls(env);
    const run = await setup({
      transform: offer,
      eip3009For: (chain, client) => (urls.has(chain.caip2) ? client : undefined),
      deps,
    });
    await run.session.start();
    await settle();
    return run.last();
  }

  const BASE_DEVNET_ENV = { VITE_EVM_RPC_URL_BASE_DEVNET: 'https://base-sepolia.example' };

  it('keeps a Base Sepolia payout once its chain-and-network RPC variable is set, and drops it otherwise', async () => {
    expect(await firstView((base) => base, BASE_DEVNET_ENV)).toMatchObject({
      kind: 'offer',
      payouts: [{ target: { caip19: { id: caip19Of(BASE_SEPOLIA) } } }],
    });
    // The other chain's variable, or the mainnet one, does not serve it.
    const others: Record<string, string>[] = [
      {},
      { VITE_EVM_RPC_URL_BASE_MAINNET: 'https://base.example' },
      { VITE_EVM_RPC_URL_ETHEREUM_DEVNET: 'https://sepolia.example' },
      { VITE_EVM_RPC_URL_BASE_DEVNET: '' },
    ];
    for (const env of others) {
      expect(await firstView((base) => base, env)).toMatchObject({
        kind: 'refused',
        message: NO_NETWORK,
      });
    }
  });

  const TESTNETS = EIP3009_CHAINS.filter((chain) => chain.network === 'devnet');
  const TESTNET_ENV = Object.fromEntries(
    TESTNETS.map((chain) => [eip3009RpcEnvName(chain), `https://${chain.slug}.example`]),
  );

  it.each(TESTNETS)(
    'a production build with the testnet variables offers the $chainName payout, and a build without its one does not',
    async (chain) => {
      const only = (base: Ready) => listing(base, [payoutOf(caip19Of(chain), PAYEE)]);
      expect(await firstView(only, TESTNET_ENV)).toMatchObject({
        kind: 'offer',
        payouts: [{ target: { caip19: { id: caip19Of(chain) } } }],
      });
      const { [eip3009RpcEnvName(chain)]: _dropped, ...without } = TESTNET_ENV;
      expect(await firstView(only, without)).toMatchObject({
        kind: 'refused',
        message: NO_NETWORK,
      });
    },
  );

  it.each(EIP3009_CHAINS.filter((chain) => chain.network === 'mainnet'))(
    'a build with no mainnet variable for $chainName offers no mainnet payout on it; Tempo mainnet is offered as today',
    async (chain) => {
      const tempo = { request: async () => undefined };
      const view = await firstView(
        (base) =>
          listing(base, [payoutOf(caip19Of(chain), PAYEE), payoutOf(TEMPO_MAINNET_USDC, PAYEE)]),
        TESTNET_ENV,
        { tempoFor: (network) => (network === 'mainnet' ? tempo : undefined) },
      );
      expect(view).toMatchObject({
        kind: 'offer',
        payout: { target: { caip19: { id: TEMPO_MAINNET_USDC } } },
        payouts: [{ target: { caip19: { id: TEMPO_MAINNET_USDC } } }],
      });
    },
  );

  it('opens on a servable payout of the same network when an unserved eip3009 one is listed first', async () => {
    const view = await firstView(
      (base) =>
        listing(base, [
          payoutOf(caip19Of(CHAINS.ARBITRUM_DEVNET), PAYEE),
          payoutOf(caip19Of(BASE_SEPOLIA), PAYEE),
        ]),
      BASE_DEVNET_ENV,
    );
    expect(view).toMatchObject({
      kind: 'offer',
      payout: { target: { caip19: { id: caip19Of(BASE_SEPOLIA) } } },
      payouts: [{ target: { caip19: { id: caip19Of(BASE_SEPOLIA) } } }],
    });
  });

  it('says "no new payment on this network" only when no payout of that network is servable', async () => {
    // Base mainnet first, with no mainnet variable: the page's network is mainnet,
    // and the servable Base Sepolia payout is on the other network.
    expect(
      await firstView(
        (base) =>
          listing(base, [
            payoutOf(caip19Of(CHAINS.BASE_MAINNET), PAYEE),
            payoutOf(caip19Of(BASE_SEPOLIA), PAYEE),
          ]),
        BASE_DEVNET_ENV,
      ),
    ).toMatchObject({ kind: 'refused', message: NO_NETWORK });
  });

  it('offers a mixed store only its servable payouts on the first payout network, in order', async () => {
    const solanaPayee = solanaAddress();
    const tempo = { request: async () => undefined };
    const view = await firstView(
      (base) =>
        listing(base, [
          payoutOf(caip19Of(CHAINS.ARBITRUM_DEVNET), PAYEE),
          payoutOf(SOLANA_DEVNET_USDC, solanaPayee),
          payoutOf(caip19Of(CHAINS.BASE_MAINNET), PAYEE),
          payoutOf(caip19Of(BASE_SEPOLIA), PAYEE),
          payoutOf(TEMPO_DEVNET_USDC, PAYEE),
          payoutOf(caip19Of(CHAINS.ETHEREUM_DEVNET), PAYEE),
        ]),
      {
        ...BASE_DEVNET_ENV,
        VITE_EVM_RPC_URL_ETHEREUM_DEVNET: 'https://sepolia.example',
        VITE_EVM_RPC_URL_BASE_MAINNET: 'https://base.example',
      },
      {
        rpcFor: (network) => (network === 'devnet' ? ({} as never) : undefined),
        tempoFor: (network) => (network === 'devnet' ? tempo : undefined),
      },
    );
    // Arbitrum Sepolia has no variable; Base mainnet has one but is another network.
    expect((view as OfferView).payouts.map((payout) => payout.target.caip19.id)).toEqual([
      SOLANA_DEVNET_USDC,
      caip19Of(BASE_SEPOLIA),
      TEMPO_DEVNET_USDC,
      caip19Of(CHAINS.ETHEREUM_DEVNET),
    ]);
    expect(view).toMatchObject({ payout: { target: { caip19: { id: SOLANA_DEVNET_USDC } } } });
  });

  it('wires every eip3009 chain to its own variable, and no other chain to one', () => {
    expect(EIP3009_CHAINS.map((chain) => chain.caip2).sort()).toEqual(
      EIP3009_USDC.map(({ chain }) => chain.caip2).sort(),
    );
    const env = Object.fromEntries(
      EIP3009_CHAINS.map((chain) => [eip3009RpcEnvName(chain), `https://${chain.caip2}.example`]),
    );
    const urls = eip3009RpcUrls({ ...env, VITE_SOLANA_RPC_URL_DEVNET: 'https://solana.example' });
    expect([...urls.entries()].sort()).toEqual(
      EIP3009_CHAINS.map((chain) => [chain.caip2, `https://${chain.caip2}.example`]).sort(),
    );
    expect(eip3009RpcEnvName(BASE_SEPOLIA)).toBe('VITE_EVM_RPC_URL_BASE_DEVNET');
  });
});

describe('a protocol fee above 0 (E7)', () => {
  it('hides these chains with the E7 line, offering the rest of the network', async () => {
    const solanaPayee = solanaAddress();
    const run = await setup({
      feeBps: 50,
      transform: (base) =>
        listing(base, [
          payoutOf(caip19Of(BASE_SEPOLIA), PAYEE),
          payoutOf(SOLANA_DEVNET_USDC, solanaPayee),
        ]),
      deps: { rpcFor: () => ({}) as never },
    });
    await run.session.start();
    expect(offerView(run)).toMatchObject({
      feeHidden: true,
      payout: { target: { caip19: { id: SOLANA_DEVNET_USDC } } },
      payouts: [{ target: { caip19: { id: SOLANA_DEVNET_USDC } } }],
    });
  });

  it('refuses a store whose only payouts it hides, with the E7 line', async () => {
    const run = await setup({ feeBps: 1 });
    await run.session.start();
    expect(run.last()).toMatchObject({ kind: 'refused', message: FEE_HIDES_EIP3009 });
  });

  it('shows no line at fee 0, and none for a chain it would not offer anyway', async () => {
    const run = await setup();
    await run.session.start();
    expect(offerView(run)).not.toHaveProperty('feeHidden');
    const unserved = await setup({ feeBps: 50, eip3009For: () => undefined });
    await unserved.session.start();
    expect(unserved.last()).toMatchObject({ kind: 'refused', message: NO_NETWORK });
  });

  it('refuses a press once the fee is above 0, ordering and signing nothing', async () => {
    const run = await setup();
    await run.session.start();
    run.fee.bps = 1;
    await run.session.pay('MetaMask');
    expect(await store.forProduct(run.offer.productAddress)).toEqual([]);
    expect(run.wallet.signed).toEqual([]);
    expect(run.last()).toMatchObject({ kind: 'refused', message: FEE_HIDES_EIP3009 });
  });
});

describe('paying from an EIP-6963 wallet', () => {
  it.each([BASE_SEPOLIA, CHAINS.ETHEREUM_DEVNET, CHAINS.ARBITRUM_DEVNET])(
    'on $chainName: signs, then sends; confirms with the credit wait; then waits for the store',
    async (chainConfig) => {
      const run = await setup({ chain: chainConfig });
      await run.session.start();
      expect(offerView(run).wallets).toEqual([{ name: 'MetaMask' }, { name: 'Rabby' }]);
      await run.session.pay('MetaMask');
      expect(waiting(run).paying).toMatchObject({ chain: chainConfig.slug, network: 'devnet' });
      const record = await recordOf(run);
      const marker = markerOf(record);
      const hash = marker.txHash ?? '';
      expect(run.wallet.signed).toHaveLength(1);
      expect(run.wallet.sent).toHaveLength(1);
      expect(run.wallet.sent[0]?.chainId).toBe(`0x${chainConfig.evmChainId.toString(16)}`);
      expect(waiting(run)).toMatchObject({
        signed: true,
        canRetry: false,
        explorer: chainConfig.explorerTx.replace('{tx}', hash),
        eip3009: {
          chain: chainConfig.chainName,
          creditSecs: chainConfig.waits.creditSecs,
          send: { kind: 'sent' },
          confirming: false,
          nonceUsed: false,
          // The same wallet may sign again at once; another wallet after the proof.
          retry: true,
          switchAt: Number(marker.validBefore) + chainConfig.waits.finalizedSecs,
        },
      });
      land(run.chain, {
        hash,
        authorizer: run.wallet.account,
        nonce: record.reference,
        payee: PAYEE,
        value: PRICE,
        block: 995,
      });
      await run.timers.tick();
      // Found below the credit tag: confirming, and no retry offered over it.
      expect(waiting(run).eip3009).toMatchObject({ confirming: true, retry: false });
      expect(waiting(run).wallets).toEqual([]);
      run.chain.safe = { number: 995, timestamp: NOW + 30 };
      await run.timers.tick();
      expect(run.last()).toMatchObject({ kind: 'waiting_store' });
      expect(await recordOf(run)).toMatchObject({ state: 'paid', paidTx: hash });
    },
  );

  it('a declined switch on a first attempt is rejected, not wrong_chain: the order stays open', async () => {
    const run = await setup();
    run.wallet.switchError = { code: 4001 };
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(offerView(run).problem).toEqual({ reason: 'rejected' });
    const record = await recordOf(run);
    expect(record.state).toBe('ordered');
    expect(record.marker).toBeUndefined();
    // Paid again at once with the same order.
    run.wallet.switchError = undefined;
    await run.session.pay('MetaMask');
    expect(run.wallet.sent).toHaveLength(1);
    expect((await recordOf(run)).orderId).toBe(record.orderId);
  });

  it('maps a busy or absent wallet at the switch, and an unreachable chain, through the connect texts', async () => {
    const cases = [
      [{ code: -32002 }, { reason: 'wallet_busy' }],
      [{ code: 4901 }, { reason: 'chain_unreachable', chain: 'Base Sepolia' }],
    ] as const;
    for (const [error, problem] of cases) {
      const run = await setup();
      run.wallet.switchError = error;
      await run.session.start();
      await run.session.pay('MetaMask');
      expect(offerView(run).problem).toEqual(problem);
    }
    const stays = await setup();
    stays.wallet.switchStays = true;
    stays.wallet.chainId = CHAINS.ETHEREUM_DEVNET.evmChainId;
    await stays.session.start();
    await stays.session.pay('MetaMask');
    expect(offerView(stays).problem).toEqual({
      reason: 'chain_unreachable',
      chain: 'Base Sepolia',
    });
  });

  it('a declined accounts request asks nothing more and places no order', async () => {
    const run = await setup();
    run.wallet.requestError = { code: 4001 };
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(offerView(run).problem).toEqual({ reason: 'rejected' });
    expect(await store.forProduct(run.offer.productAddress)).toEqual([]);
  });

  it('a refused typed-data prompt clears the attempt: the same order is paid again at once', async () => {
    const run = await setup();
    run.wallet.signError = { code: 4001 };
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(offerView(run).problem).toEqual({ reason: 'rejected' });
    expect((await recordOf(run)).marker).toBeUndefined();
    run.wallet.signError = { code: -32603 };
    await run.session.pay('MetaMask');
    expect(offerView(run).problem).toEqual({ reason: 'sign_failed' });
    expect((await recordOf(run)).state).toBe('ordered');
  });
});

describe('the eip3009 wallet icons', () => {
  const META = 'data:image/svg+xml,%3Csvg%2F%3E';
  const PHANTOM = 'data:image/png;base64,AAAA';
  it("borrow the Solana wallet's inline icon of the same name, on the offer and on a retry", async () => {
    const run = await setup({
      deps: {
        wallets: (network) =>
          network !== 'devnet'
            ? []
            : [
                {
                  name: 'Phantom',
                  icon: PHANTOM,
                  connect: () => Promise.reject(new Error('unused')),
                },
                {
                  name: 'MetaMask',
                  icon: 'data:image/png;base64,BBBB',
                  connect: () => Promise.reject(new Error('unused')),
                },
              ],
      },
    });
    const announced = run.deps.eip3009Wallets;
    if (announced === undefined) {
      throw new Error('no eip3009 wallets');
    }
    // MetaMask announces its own inline icon; "Phantom" (the second wallet) a URL.
    run.deps.eip3009Wallets = (chain) =>
      announced(chain).map((each, index) =>
        index === 0
          ? { ...each, icon: META }
          : { ...each, name: 'Phantom', icon: 'https://phantom.example/icon.png' },
      );
    await run.session.start();
    expect(offerView(run).wallets).toEqual([
      // Its own inline icon wins over the Solana one.
      { name: 'MetaMask', icon: META },
      { name: 'Phantom', icon: PHANTOM },
    ]);
    await signedNotSent(run);
    expect(waiting(run).wallets).toEqual([
      { name: 'MetaMask', icon: META },
      { name: 'Phantom', icon: PHANTOM },
    ]);
  });

  it('show no icon when neither the wallet nor a Solana wallet of its name has an inline one', async () => {
    const run = await setup({
      deps: {
        wallets: () => [
          {
            name: 'Rabby',
            icon: 'https://rabby.example/icon.png',
            connect: () => Promise.reject(new Error('unused')),
          },
        ],
      },
    });
    await run.session.start();
    expect(offerView(run).wallets).toEqual([{ name: 'MetaMask' }, { name: 'Rabby' }]);
  });
});

describe('the eip3009 timers', () => {
  it('offers the same wallet again at once after a declined send, with "send again"', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    expect(markerOf(record)).toMatchObject({ signed: true });
    expect(markerOf(record).txHash).toBeUndefined();
    expect(waiting(run)).toMatchObject({
      signed: true,
      canRetry: false,
      problem: { reason: 'send_declined' },
      wallets: [{ name: 'MetaMask' }, { name: 'Rabby' }],
      eip3009: { retry: true, resend: 'again', send: { kind: 'not_sent', earlier: false } },
    });
    // At once: no time passes before the retry signs again with the same wallet.
    await run.session.retry('MetaMask');
    expect(run.wallet.signed).toHaveLength(2);
    expect(run.wallet.sent).toHaveLength(1);
    expect(markerOf(await recordOf(run)).txHash).toBeDefined();
  });

  it('"send again" sends the signature held in memory, signing nothing new', async () => {
    const run = await setup();
    await signedNotSent(run);
    await run.session.resend();
    expect(run.wallet.signed).toHaveLength(1);
    expect(run.wallet.sent).toHaveLength(1);
    expect(waiting(run).eip3009).toMatchObject({ send: { kind: 'sent' } });
    expect(waiting(run).eip3009).not.toHaveProperty('resend');
  });

  it('a retry from another account is refused as a retry: connect the one you started with', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    await run.session.retry('Rabby');
    expect(waiting(run).problem).toEqual({
      reason: 'other_payer',
      payer: markerOf(record).authorizer,
    });
    expect(run.other.signed).toEqual([]);
  });

  it('offers another wallet, and the end, only at validBefore + the finalized wait, once the end proof passes', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    const validBefore = Number(markerOf(record).validBefore);
    const switchAt = validBefore + BASE_SEPOLIA.waits.finalizedSecs;
    expect(waiting(run).eip3009?.switchAt).toBe(switchAt);
    // Finalized past validBefore already, but the moment has not come: nothing is read.
    run.chain.finalized = { number: 1100, timestamp: validBefore + 1 };
    run.advance(switchAt - 1 - run.now());
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(false);
    expect(run.chain.pinnedReads).toEqual([]);
    // At the moment, the proof is read and holds: another wallet, and Start over.
    run.advance(1);
    await run.timers.tick();
    expect(waiting(run)).toMatchObject({
      canRetry: true,
      wallets: [{ name: 'MetaMask' }, { name: 'Rabby' }],
      eip3009: { retry: false },
    });
    // The signature held for "send again" can never land now: no longer offered.
    expect(waiting(run).eip3009).not.toHaveProperty('resend');
    expect(run.chain.pinnedReads).toContain(blockHashOf(1100));
    await run.session.retry('Rabby');
    const switched = markerOf(await recordOf(run));
    expect(switched).toMatchObject({
      authorizer: run.other.account,
      signed: true,
      switchProof: { blockHash: blockHashOf(1100) },
    });
    expect(run.other.sent).toHaveLength(1);
  });

  it('never offers another wallet while the old authorization reads used at the finalized block', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    pastSwitch(run, record);
    run.chain.used.add(`${run.wallet.account}:${record.reference}`);
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(false);
    await run.session.startOver();
    expect((await recordOf(run)).state).toBe('paying');
  });

  it('ends the order with the proof carried, once Start over is pressed past it', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    pastSwitch(run, record);
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(true);
    await run.session.startOver();
    const ended = await recordOf(run);
    expect(ended.state).toBe('ended-unpaid');
    expect(markerOf(ended).endProof).toMatchObject({ blockHash: blockHashOf(1100) });
    expect(run.last()).toMatchObject({ kind: 'offer' });
  });

  it('clears a marker that never held a signature and offers another wallet at once', async () => {
    const run = await setup();
    // The page died while the typed-data prompt was open: a marker, no signature.
    run.wallet.onSign = () => new Promise(() => undefined);
    await run.session.start();
    void run.session.pay('MetaMask');
    await settle();
    const unsigned = await recordOf(run);
    expect(markerOf(unsigned).signed).toBeUndefined();
    run.wallet.onSign = undefined;
    const session = await reload(run);
    // Cleared to `ordered` at load: nothing it asked for can land.
    const cleared = await recordOf(run);
    expect(cleared).toMatchObject({ state: 'ordered' });
    expect(cleared.marker).toBeUndefined();
    await session.pay('Rabby');
    expect(run.other.sent).toHaveLength(1);
    expect(markerOf(await recordOf(run)).authorizer).toBe(run.other.account);
  });

  it('says "taking long" before a send at validBefore + the finalized wait, never at setAt + 600', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    const marker = markerOf(record);
    const unsureAt = Number(marker.validBefore) + BASE_SEPOLIA.waits.finalizedSecs;
    expect(waiting(run).unsureAt).toBe(unsureAt);
    expect(waiting(run).unsureAt).not.toBe(marker.setAt + UNSURE_AFTER_SECS);
  });

  it('after a send late in the window says it at validBefore - SEND_MARGIN_SECS + credit wait + 120 s; on a reload, at the never-early moment', async () => {
    const run = await setup();
    await run.session.start();
    run.wallet.sendError = { code: 4001 };
    await run.session.pay('MetaMask');
    run.wallet.sendError = undefined;
    const marker = markerOf(await recordOf(run));
    const validBefore = Number(marker.validBefore);
    // The send comes late: the latest block is just outside the margin.
    run.chain.latest = { number: 1010, timestamp: validBefore - SEND_MARGIN_SECS };
    run.advance(EIP3009_VALID_SECS - SEND_MARGIN_SECS - 30);
    await run.session.resend();
    const sent = markerOf(await recordOf(run));
    expect(sent.txHash).toBeDefined();
    const expected =
      // The gate's numbers, not the constants: 120 s margin, Base Sepolia's 300 s credit wait, 120 s.
      validBefore - 120 + 300 + 120;
    expect(waiting(run).unsureAt).toBe(expected);
    expect(expected).not.toBe(sent.setAt + UNSURE_AFTER_SECS);
    // A reload of a page that follows this order shows the same moment, from stored terms only.
    const record = await recordOf(run);
    await reload(run, {
      followOnly: { reason: 'offer_refused', message: 'no', orderId: record.orderId },
    });
    // After a reload nothing says which attempt sent that hash: the later moment,
    // never early - here validBefore + Base Sepolia's 3000 s finalized wait.
    expect(waiting(run).unsureAt).toBe(validBefore + 3000);
    expect(waiting(run).eip3009).toMatchObject({
      send: { kind: 'unknown', linked: true, maybe: false },
    });
  });
});

describe('the gas check after the signature (step 5.1)', () => {
  /** What 5.1 needs on Base Sepolia: gas x (2 x base fee + priority) x 1.5, plus the L1 fee x 1.5. */
  const GAS_PART = (100_000n * (2n * 1_000_000_000n + 100_000_000n) * 15_000n + 9_999n) / 10_000n;
  const L1_PART = (1_000_000_000_000n * 15_000n + 9_999n) / 10_000n;

  it('says insufficient_native with the L1 fee counted, leaving the marker signed and nothing sent', async () => {
    const run = await setup();
    const needed = GAS_PART + L1_PART;
    run.chain.native.set(run.wallet.account, needed - 1n);
    await run.session.start();
    await run.session.pay('MetaMask');
    const marker = markerOf(await recordOf(run));
    expect(marker.signed).toBe(true);
    expect(marker.txHash).toBeUndefined();
    expect(run.wallet.sent).toEqual([]);
    expect(waiting(run)).toMatchObject({
      problem: {
        reason: 'insufficient_native',
        needed,
        available: needed - 1n,
        native: { symbol: 'ETH', decimals: 18 },
        chain: 'Base Sepolia',
      },
      eip3009: { resend: 'gas', retry: true },
    });
    expect(
      run.chain.calls.some((call) => selectorOf(call.method, call.params) === GET_L1_FEE),
    ).toBe(true);
  });

  it('a top-up then pays in place with the same wallet', async () => {
    const run = await setup();
    run.chain.native.set(run.wallet.account, 1n);
    await run.session.start();
    await run.session.pay('MetaMask');
    const before = await recordOf(run);
    run.chain.native.set(run.wallet.account, 10n ** 18n);
    await run.session.retry('MetaMask');
    const after = await recordOf(run);
    expect(after.orderId).toBe(before.orderId);
    expect(markerOf(after).txHash).toBeDefined();
    expect(run.wallet.sent).toHaveLength(1);
    expect(waiting(run).eip3009).toMatchObject({ send: { kind: 'sent' } });
  });

  it('"send anyway" sends the held signature despite the warning', async () => {
    const run = await setup();
    run.chain.native.set(run.wallet.account, 1n);
    await run.session.start();
    await run.session.pay('MetaMask');
    await run.session.resend();
    expect(run.wallet.signed).toHaveLength(1);
    expect(run.wallet.sent).toHaveLength(1);
  });

  it('watches, asking nothing, when the estimate reverts and the nonce reads used', async () => {
    const run = await setup();
    run.chain.estimate = () => {
      throw { code: 3, message: 'execution reverted' };
    };
    // An earlier transaction with this nonce lands while the wallet signs.
    run.wallet.onSign = async () => {
      const placed = await recordOf(run);
      run.chain.used.add(`${run.wallet.account}:${placed.reference}`);
    };
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(markerOf(await recordOf(run)).signed).toBe(true);
    expect(run.wallet.sent).toEqual([]);
    expect(waiting(run)).not.toHaveProperty('problem');
    expect(waiting(run).eip3009).not.toHaveProperty('resend');
  });

  it('says send_failed when the estimate reverts and the nonce is unused', async () => {
    const run = await setup();
    run.chain.estimate = () => {
      throw { code: 3, message: 'execution reverted' };
    };
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.wallet.sent).toEqual([]);
    expect(waiting(run)).toMatchObject({
      problem: { reason: 'send_failed' },
      eip3009: { retry: true },
    });
  });
});

describe('a retry of a signed attempt, step 1', () => {
  it('shows a declined switch like again_declined, keeping the attempt', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    run.wallet.switchError = { code: 4001 };
    await run.session.retry('MetaMask');
    expect(waiting(run).problem).toEqual({ reason: 'again_declined' });
    const kept = await recordOf(run);
    expect(kept.state).toBe('paying');
    expect(markerOf(kept)).toMatchObject({ attemptId: markerOf(record).attemptId, signed: true });
  });

  it('shows a declined typed-data prompt on a retry like again_declined, keeping the attempt', async () => {
    const run = await setup();
    await signedNotSent(run);
    run.wallet.signError = { code: 4001 };
    await run.session.retry('MetaMask');
    expect(waiting(run).problem).toEqual({ reason: 'again_declined' });
    expect(markerOf(await recordOf(run)).signed).toBe(true);
  });

  it('shows a declined accounts request like again_declined too', async () => {
    const run = await setup();
    await signedNotSent(run);
    run.wallet.requestError = { code: 4001 };
    await run.session.retry('MetaMask');
    expect(waiting(run).problem).toEqual({ reason: 'again_declined' });
    expect((await recordOf(run)).state).toBe('paying');
  });
});

describe('a first attempt whose nonce reads used (nonce_used)', () => {
  it('shows its text, with no timer, no other wallet and no end, ever', async () => {
    const run = await setup();
    await run.session.start();
    const realRequest = run.chain.client.request;
    run.chain.client.request = async (args) => {
      if (selectorOf(args.method, args.params ?? []) === AUTHORIZATION_STATE) {
        for (const record of await store.forProduct(run.offer.productAddress)) {
          run.chain.used.add(`${run.wallet.account}:${record.reference}`);
        }
      }
      return realRequest(args);
    };
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    expect(markerOf(record)).toMatchObject({ usedAtStart: true, signed: true, validBefore: '0' });
    expect(run.wallet.signed).toEqual([]);
    const shown = waiting(run);
    expect(shown).toMatchObject({
      canRetry: false,
      wallets: [],
      eip3009: { nonceUsed: true, retry: false },
    });
    expect(shown).not.toHaveProperty('unsureAt');
    expect(shown.eip3009).not.toHaveProperty('switchAt');
    // Days later: still no timer, no wallet; Start over and a retry end nothing.
    run.advance(5 * 24 * 60 * 60);
    run.chain.finalized = { number: 5000, timestamp: run.now() };
    await run.timers.tick();
    expect(waiting(run)).toMatchObject({ canRetry: false, wallets: [] });
    run.other.requestError = { code: 4001 };
    await run.session.retry('Rabby');
    expect(waiting(run)).not.toHaveProperty('problem');
    await run.session.startOver();
    expect(await recordOf(run)).toMatchObject({ state: 'paying' });
    expect(run.other.signed).toEqual([]);
  });
});

describe('the load-time reconciliation (reconcileEnded)', () => {
  it('ends a signed marker only with an end proof, carried to the store', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    // Before its validBefore is finalized: kept.
    await reload(run);
    expect(await recordOf(run)).toMatchObject({ state: 'paying' });
    // Used at the finalized block: kept (it is paid, never ended).
    pastSwitch(run, record);
    run.chain.used.add(`${run.wallet.account}:${record.reference}`);
    run.chain.usedPinned = new Set(run.chain.used);
    await reload(run);
    expect(await recordOf(run)).toMatchObject({ state: 'paying' });
    // Unused at a finalized block past validBefore: ended, with the proof stored.
    run.chain.used.clear();
    run.chain.usedPinned = undefined;
    await reload(run);
    const ended = await recordOf(run);
    expect(ended.state).toBe('ended-unpaid');
    expect(markerOf(ended).endProof).toEqual({
      blockHash: blockHashOf(1100),
      timestamp: Number(markerOf(record).validBefore) + 1,
    });
  });

  it('makes no RPC read and no end on a usedAtStart marker', async () => {
    const run = await setup();
    await run.session.start();
    const realRequest = run.chain.client.request;
    run.chain.client.request = async (args) => {
      if (selectorOf(args.method, args.params ?? []) === AUTHORIZATION_STATE) {
        for (const record of await store.forProduct(run.offer.productAddress)) {
          run.chain.used.add(`${run.wallet.account}:${record.reference}`);
        }
      }
      return realRequest(args);
    };
    await run.session.pay('MetaMask');
    run.session.dispose();
    pastSwitch(run, await recordOf(run));
    run.chain.calls.length = 0;
    const session = new CheckoutSession(run.offer, run.deps);
    await session.start();
    await settle();
    await run.timers.tick();
    expect(run.chain.calls).toEqual([]);
    expect(await recordOf(run)).toMatchObject({ state: 'paying', marker: { usedAtStart: true } });
  });

  it('records a payment found at load', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    land(run.chain, {
      hash: markerOf(record).txHash ?? '',
      authorizer: run.wallet.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 980,
    });
    await reload(run);
    expect(await recordOf(run)).toMatchObject({ state: 'paid' });
  });
});

describe('receipts and history', () => {
  it('names the sent transaction, with its explorer link, only once its block reached the credit tag', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    const hash = markerOf(record).txHash ?? '';
    run.chain.receipts.set(hash, {
      transactionHash: hash,
      status: '0x1',
      blockNumber: '0x3e3',
      blockHash: blockHashOf(995),
      logs: [],
    });
    // The store completes it by hand: no payment was seen by this checkout.
    await backend.transactProduct(record.productAddress, () => ({
      write: [
        {
          ...record,
          version: record.version + 1,
          state: 'completed',
          status: { status: 'completed', at: NOW + 60, delivery: 'https://shop.example/x' },
        },
      ],
      result: undefined,
    }));
    // Above the credit tag (safe is 990): no row.
    const purchase = await run.session.purchase(record.orderId);
    expect(purchase?.receipt).not.toHaveProperty('sent');
    run.chain.safe = { number: 995, timestamp: NOW + 30 };
    const later = new CheckoutSession(run.offer, run.deps);
    await later.start();
    const confirmed = await later.purchase(record.orderId);
    expect(confirmed?.receipt.sent).toEqual({
      tx: hash,
      explorer: `https://sepolia.basescan.org/tx/${hash}`,
    });
  });

  it('never reads an eip3009 transaction with the Tempo client', async () => {
    const tempoReads: string[] = [];
    const run = await setup({
      deps: {
        tempoFor: () => ({
          request: async ({ method }) => {
            tempoReads.push(method);
            throw new Error('not Tempo');
          },
        }),
      },
    });
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    await backend.transactProduct(record.productAddress, () => ({
      write: [
        {
          ...record,
          version: record.version + 1,
          state: 'completed',
          status: { status: 'completed', at: NOW + 60, delivery: 'https://shop.example/x' },
        },
      ],
      result: undefined,
    }));
    const unserved = new CheckoutSession(run.offer, { ...run.deps, eip3009For: () => undefined });
    await unserved.start();
    expect((await unserved.purchase(record.orderId))?.receipt).not.toHaveProperty('sent');
    expect(tempoReads).toEqual([]);
  });

  it('is the eip3009 rail for every registry chain that settles over it', () => {
    for (const { chain, caip19 } of EIP3009_USDC) {
      expect(recordRail({ payout: { caip19, address: PAYEE } } as OrderRecord)).toBe('eip3009');
      expect(chain.settlement).toBe('eip3009');
    }
    expect(
      recordRail({ payout: { caip19: TEMPO_DEVNET_USDC, address: PAYEE } } as OrderRecord),
    ).toBe('tempo');
  });
});

describe('the rest of the session on this rail', () => {
  it('opens on the eip3009 payout when the fee read at load never answers, after FEE_READ_TIMEOUT_MS', async () => {
    const run = await setup({ deps: { feeTerms: () => new Promise(() => undefined) } });
    let started = false;
    void run.session.start().then(() => {
      started = true;
    });
    await settle();
    expect(started).toBe(false);
    await run.timers.tick();
    expect(started).toBe(true);
    expect(offerView(run)).toMatchObject({
      payouts: [{ target: { caip19: { id: caip19Of(BASE_SEPOLIA) } } }],
    });
    expect(offerView(run)).not.toHaveProperty('feeHidden');
  });

  it('keeps an order whose nonce was used, but whose frozen marker could not be written, from any wallet and any end', async () => {
    const run = await setup();
    await run.session.start();
    const realRequest = run.chain.client.request;
    run.chain.client.request = async (args) => {
      if (selectorOf(args.method, args.params ?? []) === AUTHORIZATION_STATE) {
        for (const record of await store.forProduct(run.offer.productAddress)) {
          run.chain.used.add(`${run.wallet.account}:${record.reference}`);
        }
      }
      return realRequest(args);
    };
    // The finalized block cannot be read: the frozen marker is never written.
    run.chain.failIf = (method, params) =>
      method === 'eth_getBlockByNumber' && params[0] === 'finalized';
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    expect(record.state).toBe('ordered');
    expect(record.marker).toBeUndefined();
    expect(waiting(run)).toMatchObject({ eip3009: { nonceUsed: true }, wallets: [] });
    run.chain.failIf = undefined;
    // Not even the accounts are asked: a decline would show on the offer.
    run.other.requestError = { code: 4001 };
    await run.session.pay('Rabby');
    expect(waiting(run).eip3009).toMatchObject({ nonceUsed: true });
    await run.session.startOver();
    run.session.choosePayout(0);
    expect(run.other.signed).toEqual([]);
    expect(await recordOf(run)).toMatchObject({ state: 'ordered' });
    expect(waiting(run).eip3009).toMatchObject({ nonceUsed: true });
  });

  it('while the wallet has not answered: "taking long" from the chain waits, another wallet counted down once signed', async () => {
    const run = await setup();
    await run.session.start();
    run.wallet.onSign = () => new Promise(() => undefined);
    void run.session.pay('MetaMask');
    await settle();
    // The probe reads the marker on its next tick.
    await run.timers.tick();
    const unsigned = markerOf(await recordOf(run));
    expect(run.last()).toMatchObject({
      kind: 'working',
      step: 'signing',
      unsureAt: Number(unsigned.validBefore) + BASE_SEPOLIA.waits.finalizedSecs,
    });
    expect(run.last()).not.toHaveProperty('startOverIn');
    const signing = await setup();
    await signing.session.start();
    signing.wallet.onSend = () => new Promise(() => undefined);
    void signing.session.pay('MetaMask');
    await settle();
    await signing.timers.tick();
    const signed = markerOf(await recordOf(signing));
    expect(signed.signed).toBe(true);
    const switchAt = Number(signed.validBefore) + BASE_SEPOLIA.waits.finalizedSecs;
    expect(signing.last()).toMatchObject({
      kind: 'working',
      startOverIn: { seconds: switchAt - signing.now(), at: signing.now() },
    });
  });

  it.each(['reload', 'close', 'another tab'] as const)(
    'after a %s, a press brings the attempt back: the same wallet signs again at once',
    async (how) => {
      const run = await setup();
      const record = await signedNotSent(run);
      let session = run.session;
      if (how === 'reload') {
        session = await reload(run);
      } else if (how === 'close') {
        expect(run.session.resetOnClose()).toBe(true);
      } else {
        session = new CheckoutSession(run.offer, run.deps);
        await session.start();
      }
      // Before the wallet is asked anything: a declined accounts request would show.
      run.wallet.requestError = { code: 4001 };
      await session.pay('MetaMask');
      run.wallet.requestError = undefined;
      // No wait for the end proof: the attempt itself, with the same wallet offered now.
      expect(run.wallet.signed).toHaveLength(1);
      expect(waiting(run)).toMatchObject({
        canRetry: false,
        wallets: [{ name: 'MetaMask' }, { name: 'Rabby' }],
        // Nothing was sent: no "sent", whatever this session remembers.
        eip3009: {
          retry: true,
          send:
            how === 'close'
              ? { kind: 'not_sent', earlier: false }
              : { kind: 'unknown', linked: false, maybe: false },
        },
      });
      expect(run.last()).not.toMatchObject({ problem: { reason: 'earlier_payment' } });
      await session.retry('MetaMask');
      expect(run.wallet.signed).toHaveLength(2);
      expect(run.wallet.sent).toHaveLength(1);
      expect((await recordOf(run)).orderId).toBe(record.orderId);
    },
  );

  it("ends another account's signed attempt from its follower, only once the end proof holds", async () => {
    const run = await setup();
    const own = await signedNotSent(run);
    run.session.dispose();
    await backend.transactProduct(own.productAddress, () => ({
      write: [{ ...own, version: own.version + 1, customerRef: 'acct-b' }],
      result: undefined,
    }));
    const session = new CheckoutSession(run.offer, run.deps);
    await session.start();
    await settle();
    expect(await recordOf(run)).toMatchObject({ state: 'paying' });
    pastSwitch(run, own);
    await run.timers.tick();
    const ended = await recordOf(run);
    expect(ended.state).toBe('ended-unpaid');
    expect(markerOf(ended).endProof).toMatchObject({ blockHash: blockHashOf(1100) });
  });
});

describe('review of the mutation table', () => {
  it('reads no fee at load for a page with no eip3009 payout', async () => {
    let reads = 0;
    const run = await setup({
      transform: (base) => listing(base, [payoutOf(SOLANA_DEVNET_USDC, solanaAddress())]),
      deps: {
        rpcFor: () => ({}) as never,
        feeTerms: async () => {
          reads += 1;
          return { feeBps: 50, treasury: '' };
        },
      },
    });
    await run.session.start();
    expect(reads).toBe(0);
    expect(offerView(run)).not.toHaveProperty('feeHidden');
  });

  it('refuses a device clock far from the chain before ordering', async () => {
    const run = await setup();
    await run.session.start();
    run.advance(3600);
    // The offer was read an hour ago: verified again at the press, still the same.
    await run.session.pay('MetaMask');
    expect(offerView(run).problem).toEqual({ reason: 'clock_skew' });
    expect(await store.forProduct(run.offer.productAddress)).toEqual([]);
  });

  it('ends an open order once the fee turned above 0, and hides the chain (fee_not_zero)', async () => {
    const run = await setup();
    run.wallet.switchError = { code: 4001 };
    await run.session.start();
    await run.session.pay('MetaMask');
    expect((await recordOf(run)).state).toBe('ordered');
    run.wallet.switchError = undefined;
    run.fee.bps = 50;
    await run.session.pay('MetaMask');
    expect((await recordOf(run)).state).toBe('ended-unpaid');
    expect(run.wallet.signed).toEqual([]);
    expect(run.last()).toMatchObject({ kind: 'refused', message: FEE_HIDES_EIP3009 });
  });

  it('warns when the send came close to the signature end', async () => {
    const run = await setup();
    run.wallet.onSend = async () => {
      const marker = markerOf(await recordOf(run));
      run.chain.latest = { number: 1010, timestamp: Number(marker.validBefore) - 60 };
    };
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(waiting(run).problem).toEqual({ reason: 'near_expiry' });
  });

  /** A send whose hash could not be stored: another tab replaced the attempt during the prompt. */
  function replacedDuringSend(run: Run, close: boolean): void {
    run.wallet.onSend = async () => {
      const record = await recordOf(run);
      const marker = markerOf(record);
      await store.updateMarker(record.orderId, record.version, marker.attemptId, {
        ...marker,
        attemptId: 'another-tab',
      });
      if (close) {
        run.session.resetOnClose();
      }
    };
  }

  it('follows a hash it could not store, by the hash, while the nonce scan is down', async () => {
    const run = await setup();
    replacedDuringSend(run, false);
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    expect(markerOf(record).txHash).toBeUndefined();
    const hash = run.wallet.sent.length === 1 ? `0x${'7'.repeat(56)}00000001` : '';
    land(run.chain, {
      hash,
      authorizer: run.wallet.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 980,
    });
    run.chain.down.add('eth_getLogs');
    await run.timers.tick();
    expect(await recordOf(run)).toMatchObject({ state: 'paid', paidTx: hash });
  });

  it('follows such a hash in the background after a close during the send prompt', async () => {
    const run = await setup();
    replacedDuringSend(run, true);
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    const hash = `0x${'7'.repeat(56)}00000001`;
    land(run.chain, {
      hash,
      authorizer: run.wallet.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 980,
    });
    run.chain.down.add('eth_getLogs');
    await run.timers.tick();
    expect(await recordOf(run)).toMatchObject({ state: 'paid', paidTx: hash });
  });

  it("clears another tab's never-signed marker at a press, and pays at once", async () => {
    const run = await setup();
    const other = new CheckoutSession(run.offer, run.deps);
    await other.start();
    await run.session.start();
    run.wallet.onSign = () => new Promise(() => undefined);
    void run.session.pay('MetaMask');
    await settle();
    expect(markerOf(await recordOf(run)).signed).toBeUndefined();
    await other.pay('Rabby');
    expect(run.other.sent).toHaveLength(1);
  });

  it('keeps the earlier-payment countdown of a confirming payment at 0 from the moment another wallet may pay', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    land(run.chain, {
      hash: markerOf(record).txHash ?? '',
      authorizer: run.wallet.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 995,
    });
    const switchAt = Number(markerOf(record).validBefore) + BASE_SEPOLIA.waits.finalizedSecs;
    run.session.resetOnClose();
    run.advance(switchAt + 30 - run.now());
    await run.session.pay('Rabby');
    // Confirming: the line, never the attempt with a retry over a payment found.
    expect(offerView(run).problem).toMatchObject({
      reason: 'earlier_payment',
      phase: 'confirming',
      retryIn: { seconds: 0, at: switchAt },
    });
    expect(run.other.signed).toEqual([]);
  });
});

/** The store's cancel of `record`, as its listener would store it. */
async function storeCancels(record: OrderRecord): Promise<void> {
  await applyStatus(
    store,
    record.orderId,
    {
      type: 'status',
      buyerPubkey: record.buyerPubkey,
      orderId: record.orderId,
      status: 'cancelled',
    },
    NOW + 60,
  );
}

/** Another tab's signed attempt on `record` (an `ordered` one): its request, its marker, its signature. */
async function signedByAnotherTab(run: Run, record: OrderRecord): Promise<void> {
  const caip2 = record.payout.caip19.split('/')[0] ?? '';
  const requested = await store.update(record.orderId, record.version, {
    paymentRequest: JSON.stringify({
      rail: 'eip3009',
      caip2,
      caip19: record.payout.caip19,
      payee: PAYEE,
      amount: PRICE.toString(),
      nonce: record.reference,
    }),
  });
  if (!requested.ok) {
    throw new Error(requested.reason);
  }
  const marker = {
    rail: 'eip3009' as const,
    attemptId: 'another-tab',
    setAt: run.now(),
    authorizer: run.other.account,
    floorBlock: '950',
    validBefore: String(NOW + 30 + EIP3009_VALID_SECS),
  };
  const marked = await store.setMarker(record.orderId, requested.record.version, marker, run.now());
  if (!marked.ok) {
    throw new Error(marked.reason);
  }
  const signed = await store.updateMarker(record.orderId, marked.record.version, 'another-tab', {
    ...marker,
    signed: true,
    signature: `0x${'5'.repeat(130)}`,
  });
  if (!signed.ok) {
    throw new Error(signed.reason);
  }
}

describe('review round 1', () => {
  it('never hands an eip3009 hash for an order ended meanwhile to the Tempo late watch (finding 1)', async () => {
    const run = await setup();
    await run.session.start();
    // While the send prompt is open, another tab ends the order with an end proof.
    run.wallet.onSend = async () => {
      run.wallet.onSend = undefined;
      const record = await recordOf(run);
      const validBefore = Number(markerOf(record).validBefore);
      const latest = run.chain.latest;
      run.chain.finalized = { number: 990, timestamp: validBefore + 1 };
      const ended = await new CheckoutSession(run.offer, run.deps)['endOrder'](record);
      expect(ended.ended).toBe(true);
      run.chain.latest = latest;
    };
    await run.session.pay('MetaMask');
    expect((await recordOf(run)).state).toBe('ended-unpaid');
    expect(run.wallet.sent).toHaveLength(1);
    await run.timers.tick();
    // No late-approval hold: the next press asks the wallet again.
    run.chain.finalized = { number: 950, timestamp: NOW - 900 };
    await run.session.pay('MetaMask');
    expect(run.last()).not.toMatchObject({ problem: { reason: 'late_approval' } });
    expect(run.wallet.signed).toHaveLength(2);
  });

  it('follows the order when its end is refused after a refusal before the marker (finding 2)', async () => {
    const run = await setup();
    run.wallet.switchError = { code: 4001 };
    await run.session.start();
    await run.session.pay('MetaMask');
    run.wallet.switchError = undefined;
    const placed = await recordOf(run);
    run.fee.bps = 50;
    // Another tab signs this very order while this press reads the chain.
    const realRequest = run.chain.client.request;
    let once = true;
    run.chain.client.request = async (args) => {
      if (once && selectorOf(args.method, args.params ?? []) === AUTHORIZATION_STATE) {
        once = false;
        await signedByAnotherTab(run, placed);
      }
      return realRequest(args);
    };
    await run.session.pay('MetaMask');
    expect((await recordOf(run)).state).toBe('paying');
    expect(run.last()).toMatchObject({ kind: 'waiting_payment' });
    expect(run.wallet.signed).toEqual([]);
  });

  it('asks no wallet for a retry of an order the store cancelled during the press (finding 3)', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    const views = run.views.length;
    run.advance(200);
    run.deps.reloadOffer = async () => {
      await storeCancels(record);
      return run.offer;
    };
    const session = run.session as unknown as { deps: SessionDeps };
    session.deps.reloadOffer = run.deps.reloadOffer;
    await run.session.retry('MetaMask');
    expect(run.wallet.signed).toHaveLength(1);
    expect(
      run.views.slice(views).some((view) => view.kind === 'working' && view.step === 'signing'),
    ).toBe(false);
    expect((await recordOf(run)).status?.status).toBe('cancelled');
  });

  it("clears another account's never-signed marker its follower meets, and frees the offer at once (findings 4, 11)", async () => {
    const run = await setup();
    await run.session.start();
    const tab = new CheckoutSession(run.offer, run.deps);
    await tab.start();
    run.wallet.onSign = () => new Promise(() => undefined);
    void tab.pay('MetaMask');
    await settle();
    const held = await recordOf(run);
    expect(markerOf(held).signed).toBeUndefined();
    // That order belongs to another account of this browser.
    await backend.transactProduct(held.productAddress, () => ({
      write: [{ ...held, version: held.version + 1, customerRef: 'acct-b' }],
      result: undefined,
    }));
    run.wallet.onSign = undefined;
    await run.session.pay('Rabby');
    await settle();
    const records = await store.forProduct(run.offer.productAddress);
    expect(records.find((record) => record.orderId === held.orderId)).toMatchObject({
      state: 'ordered',
    });
    expect(offerView(run)).not.toHaveProperty('problem');
  });

  it('keeps another wallet and Start over when a switch is refused before it wrote anything (finding 5)', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    pastSwitch(run, record);
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(true);
    run.chain.tokens.set(run.other.account, 1n);
    await run.session.retry('Rabby');
    expect(waiting(run)).toMatchObject({
      canRetry: true,
      problem: { reason: 'insufficient_token', needed: PRICE, available: 1n },
      wallets: [{ name: 'MetaMask' }, { name: 'Rabby' }],
    });
    expect(markerOf(await recordOf(run)).attemptId).toBe(markerOf(record).attemptId);
  });

  it('a live attempt after a switch that signed but was not sent is no longer over (finding 5)', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    pastSwitch(run, record);
    await run.timers.tick();
    run.other.sendError = { code: 4001 };
    await run.session.retry('Rabby');
    expect(waiting(run)).toMatchObject({
      canRetry: false,
      problem: { reason: 'send_declined' },
      eip3009: { retry: true, resend: 'again' },
    });
  });

  it('a wallet that moves off the chain after signing: its text, then "send again" switches it back (finding 6)', async () => {
    const run = await setup();
    run.wallet.onSign = async () => {
      run.wallet.chainId = CHAINS.ETHEREUM_DEVNET.evmChainId;
    };
    await run.session.start();
    await run.session.pay('MetaMask');
    run.wallet.onSign = undefined;
    expect(run.wallet.sent).toEqual([]);
    expect(waiting(run)).toMatchObject({
      problem: { reason: 'wrong_chain_after_sign', chain: 'Base Sepolia' },
      eip3009: { resend: 'chain' },
    });
    await run.session.resend();
    expect(run.wallet.chainId).toBe(BASE_SEPOLIA.evmChainId);
    expect(run.wallet.sent).toHaveLength(1);
    expect(run.wallet.signed).toHaveLength(1);
  });

  it('drops "send again" once another tab replaced the attempt (finding 7)', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    expect(waiting(run).eip3009?.resend).toBe('again');
    const marker = markerOf(record);
    await store.updateMarker(record.orderId, record.version, marker.attemptId, {
      ...marker,
      attemptId: 'another-tab',
    });
    await run.timers.tick();
    expect(waiting(run).eip3009).not.toHaveProperty('resend');
    await run.session.resend();
    expect(run.wallet.sent).toEqual([]);
  });

  it('hides nothing when the fee read at load fails (finding 8)', async () => {
    const run = await setup({ deps: { feeTerms: () => Promise.reject(new Error('down')) } });
    await run.session.start();
    expect(offerView(run)).toMatchObject({
      payouts: [{ target: { caip19: { id: caip19Of(BASE_SEPOLIA) } } }],
    });
    expect(offerView(run)).not.toHaveProperty('feeHidden');
  });

  it('reads no fee on a follow-only page, and sends nothing from it (finding 9)', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    let reads = 0;
    await reload(run, {
      feeTerms: async () => {
        reads += 1;
        return { feeBps: 0, treasury: '' };
      },
      followOnly: { reason: 'offer_refused', message: 'no', orderId: record.orderId },
    });
    expect(reads).toBe(0);
    // A follow-only session never resends, even holding a signature.
    const held = await setup();
    await signedNotSent(held);
    (held.session as unknown as { followOnly: unknown }).followOnly = {
      reason: 'offer_refused',
      message: 'no',
    };
    await held.session.resend();
    expect(held.wallet.sent).toEqual([]);
  });

  it('names no sent transaction for a receipt status other than 0 or 1, nor for a malformed hash (finding 10)', async () => {
    for (const [status, tx] of [
      ['0x2', `0x${'ab'.repeat(32)}`],
      ['0x1', `0x${'AB'.repeat(32)}`],
    ] as const) {
      const run = await setup();
      await run.session.start();
      await run.session.pay('MetaMask');
      const record = await recordOf(run);
      run.chain.safe = { number: 1000, timestamp: NOW + 30 };
      run.chain.receipts.set(tx, {
        transactionHash: tx,
        status,
        blockNumber: '0x3e3',
        blockHash: blockHashOf(995),
        logs: [],
      });
      await backend.transactProduct(record.productAddress, () => ({
        write: [
          {
            ...record,
            version: record.version + 1,
            state: 'completed',
            marker: { ...markerOf(record), txHash: tx },
            status: { status: 'completed', at: NOW + 60, delivery: 'https://shop.example/x' },
          },
        ],
        result: undefined,
      }));
      run.chain.calls.length = 0;
      const later = new CheckoutSession(run.offer, run.deps);
      await later.start();
      expect((await later.purchase(record.orderId))?.receipt).not.toHaveProperty('sent');
      const read = run.chain.calls.some((call) => call.method === 'eth_getTransactionReceipt');
      // A malformed hash is never even looked up.
      expect(read).toBe(status === '0x2');
    }
  });

  it('offers no retry for an attempt the store cancelled, nor for a chain the build stopped serving (finding 11)', async () => {
    const cancelled = await setup();
    const record = await signedNotSent(cancelled);
    await storeCancels(record);
    await cancelled.timers.tick();
    expect(waiting(cancelled)).toMatchObject({ wallets: [], eip3009: { retry: false } });
    const unserved = await setup();
    await signedNotSent(unserved);
    unserved.served.on = false;
    unserved.session.refresh();
    expect(waiting(unserved)).toMatchObject({
      unserved: true,
      wallets: [],
      eip3009: { retry: false },
    });
  });

  it('is no longer confirming once the payment found below the credit tag is gone (finding 11)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    const hash = markerOf(record).txHash ?? '';
    land(run.chain, {
      hash,
      authorizer: run.wallet.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 995,
    });
    await run.timers.tick();
    expect(waiting(run).eip3009).toMatchObject({ confirming: true, retry: false });
    // A reorg drops it.
    run.chain.logs.length = 0;
    run.chain.receipts.delete(hash);
    run.chain.used.clear();
    await run.timers.tick();
    expect(waiting(run).eip3009).toMatchObject({ confirming: false, retry: true });
  });

  it('a payment confirming for an older attempt never hides the retry of the one on screen (finding 11)', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    const session = run.session as unknown as {
      eip3009Confirming: { orderId: string; attemptId: string } | undefined;
    };
    session.eip3009Confirming = { orderId: record.orderId, attemptId: 'an-older-attempt' };
    run.session.refresh();
    expect(waiting(run).eip3009).toMatchObject({ confirming: false, retry: true });
  });
});

/** A session's private state, as the guards below need it. */
interface SessionInternals {
  setRecord(record: OrderRecord | undefined): void;
  record: OrderRecord | undefined;
}

function inside(session: CheckoutSession): SessionInternals {
  return session as unknown as SessionInternals;
}

describe('review round 1: every guard has a test', () => {
  it('asks the wallet again only once a final receipt said so: an unknown status is asked again', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    const hash = markerOf(record).txHash ?? '';
    run.chain.safe = { number: 1000, timestamp: NOW + 30 };
    run.chain.receipts.set(hash, {
      transactionHash: hash,
      status: '0x2',
      blockNumber: '0x3e3',
      blockHash: blockHashOf(995),
      logs: [],
    });
    await backend.transactProduct(record.productAddress, () => ({
      write: [
        {
          ...record,
          version: record.version + 2,
          state: 'completed',
          status: { status: 'completed', at: NOW + 60, delivery: 'https://shop.example/x' },
        },
      ],
      result: undefined,
    }));
    const receiptReads = () =>
      run.chain.calls.filter((call) => call.method === 'eth_getTransactionReceipt').length;
    await reload(run, {
      followOnly: { reason: 'offer_refused', message: 'no', orderId: record.orderId },
    });
    await settle();
    const first = receiptReads();
    expect(first).toBeGreaterThan(0);
    await run.timers.tick();
    // Unknown, never final: one more look-up by its own timer.
    expect(receiptReads()).toBeGreaterThan(first);
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    expect(run.last()).not.toHaveProperty('receipt.sent');
  });

  it('never pays an order whose nonce was used with another wallet, even when it is not the one on screen', async () => {
    const run = await setup();
    await run.session.start();
    const realRequest = run.chain.client.request;
    run.chain.client.request = async (args) => {
      if (selectorOf(args.method, args.params ?? []) === AUTHORIZATION_STATE) {
        for (const record of await store.forProduct(run.offer.productAddress)) {
          run.chain.used.add(`${run.wallet.account}:${record.reference}`);
        }
      }
      return realRequest(args);
    };
    run.chain.failIf = (method, params) =>
      method === 'eth_getBlockByNumber' && params[0] === 'finalized';
    await run.session.pay('MetaMask');
    run.chain.failIf = undefined;
    expect((await recordOf(run)).marker).toBeUndefined();
    // Something else took the screen; the frozen order is still open in the store.
    inside(run.session).setRecord(undefined);
    await run.session.pay('Rabby');
    expect(run.other.signed).toEqual([]);
    expect(waiting(run).eip3009).toMatchObject({ nonceUsed: true });
  });

  it('refuses a device clock far from the chain on an open order too, before any prompt', async () => {
    const run = await setup();
    run.wallet.switchError = { code: 4001 };
    await run.session.start();
    await run.session.pay('MetaMask');
    run.wallet.switchError = undefined;
    expect((await recordOf(run)).state).toBe('ordered');
    run.advance(3600);
    await run.session.pay('MetaMask');
    expect(offerView(run).problem).toEqual({ reason: 'clock_skew' });
    expect(run.wallet.signed).toEqual([]);
  });

  it('never tries to clear a marker that holds a signature', async () => {
    const run = await setup();
    await signedNotSent(run);
    const clears = vi.spyOn(store, 'clearMarker');
    await run.timers.tick();
    await reload(run);
    expect(clears).not.toHaveBeenCalled();
    clears.mockRestore();
  });

  it('starts no send for a held signature of an attempt another tab replaced', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    const marker = markerOf(record);
    await store.updateMarker(record.orderId, record.version, marker.attemptId, {
      ...marker,
      attemptId: 'another-tab',
    });
    // The view on screen still names the old attempt: the press is judged on the stored one.
    inside(run.session).record = await recordOf(run);
    const views = run.views.length;
    await run.session.resend();
    expect(run.views.slice(views).some((view) => view.kind === 'working')).toBe(false);
  });

  it('offers no retry for a marker that never held a signature', async () => {
    const run = await setup();
    const tab = new CheckoutSession(run.offer, run.deps);
    await tab.start();
    await run.session.start();
    run.wallet.onSign = () => new Promise(() => undefined);
    void tab.pay('MetaMask');
    await settle();
    const unsigned = await recordOf(run);
    expect(markerOf(unsigned).signed).toBeUndefined();
    inside(run.session).record = unsigned;
    run.session.refresh();
    expect(waiting(run)).toMatchObject({ wallets: [], eip3009: { retry: false } });
  });
});

describe('review round 2', () => {
  it('after a retry that was not sent, says so beside the earlier sent payment, which may still land (finding 2)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const first = markerOf(await recordOf(run));
    const earlier = first.txHash ?? '';
    run.wallet.sendError = { code: 4001 };
    await run.session.retry('MetaMask');
    run.wallet.sendError = undefined;
    const current = markerOf(await recordOf(run));
    expect(current.attemptId).not.toBe(first.attemptId);
    expect(current.txHash).toBe(earlier);
    expect(waiting(run)).toMatchObject({
      problem: { reason: 'send_declined' },
      explorer: `https://sepolia.basescan.org/tx/${earlier}`,
      // Not sent: "taking long" waits for the proof moment of the new signature.
      unsureAt: Number(current.validBefore) + 3000,
      eip3009: { send: { kind: 'not_sent', earlier: true }, resend: 'again' },
    });
    await run.session.resend();
    expect(run.wallet.sent).toHaveLength(2);
    const sent = markerOf(await recordOf(run));
    expect(waiting(run)).toMatchObject({
      unsureAt: Number(sent.validBefore) - 120 + 300 + 120,
      eip3009: { send: { kind: 'sent' } },
    });
  });

  it('says a refused retry of a live attempt honestly: the earlier payment may still arrive (finding 3)', async () => {
    const run = await setup();
    await signedNotSent(run);
    run.wallet.switchStays = true;
    run.wallet.chainId = CHAINS.ETHEREUM_DEVNET.evmChainId;
    await run.session.retry('MetaMask');
    // The wallet answered ok to the switch and stayed on its chain.
    expect(run.wallet.signed).toHaveLength(1);
    expect(waiting(run).problem).toEqual({
      reason: 'retry_blocked',
      cause: 'chain_unreachable',
      chain: 'Base Sepolia',
    });
  });

  /** The same offer, one subunit dearer: the store repriced it. */
  function dearer(offer: Ready): Ready {
    return {
      ...offer,
      payouts: offer.payouts.map((payout) => ({ ...payout, amount: payout.amount + 1n })),
    };
  }

  it.each([
    [
      'token_blocked',
      async (run: Run) => {
        run.chain.blacklisted.add(PAYEE);
      },
    ],
    [
      'too_late',
      async (run: Run, record: OrderRecord) => {
        run.chain.latest = { number: 1010, timestamp: record.createdAt + 3 * 24 * 3600 };
      },
    ],
    [
      'payer_unsupported',
      async (run: Run) => {
        run.chain.code.set(run.wallet.account, '0x6080');
      },
    ],
    [
      'fee_config_unavailable',
      async (run: Run) => {
        run.deps.feeTerms = () => Promise.reject(new Error('down'));
      },
    ],
    [
      'fee_config_invalid',
      async (run: Run) => {
        run.deps.feeTerms = () => Promise.reject(new FeeConfigError('bad_config', 'bad'));
      },
    ],
    [
      'offer_changed',
      async (run: Run) => {
        // A page loaded after the store repriced it: the order keeps its own price.
        const repriced = new CheckoutSession(dearer(run.offer), run.deps);
        await repriced.start();
        await repriced.pay('MetaMask');
        return repriced;
      },
    ],
  ] as const)('maps %s on a retry of a live attempt to its retry text', async (cause, prepare) => {
    const run = await setup();
    const record = await signedNotSent(run);
    const session = (await prepare(run, record)) ?? run.session;
    await session.retry('MetaMask');
    expect(run.wallet.signed).toHaveLength(1);
    expect(waiting(run).problem).toMatchObject({ reason: 'retry_blocked', cause });
  });

  it('keeps the plain texts on a switch refused after the proof: nothing can land any more (finding 3)', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    pastSwitch(run, record);
    await run.timers.tick();
    run.chain.blacklisted.add(run.other.account);
    await run.session.retry('Rabby');
    expect(waiting(run)).toMatchObject({ canRetry: true, problem: { reason: 'token_blocked' } });
  });

  it('bounds the fee read at load by 4 seconds (TG2)', async () => {
    const delays: number[] = [];
    const run = await setup({
      deps: {
        feeTerms: () => new Promise(() => undefined),
      },
    });
    const set = run.deps.setTimeout;
    const session = new CheckoutSession(run.offer, {
      ...run.deps,
      setTimeout: (handler, ms) => {
        delays.push(ms);
        return set(handler, ms);
      },
    });
    void session.start();
    await settle();
    expect(delays).toContain(4000);
  });

  it('places no order and asks no signature when the fee read fails at the press (TG3)', async () => {
    const run = await setup();
    await run.session.start();
    run.deps.feeTerms = () => Promise.reject(new Error('down'));
    (run.session as unknown as { deps: SessionDeps }).deps.feeTerms = run.deps.feeTerms;
    await run.session.pay('MetaMask');
    expect(offerView(run).problem).toEqual({ reason: 'fee_config_unavailable' });
    expect(await store.forProduct(run.offer.productAddress)).toEqual([]);
    expect(run.wallet.signed).toEqual([]);
  });

  it('a busy or missing wallet on a retry of a live attempt is that, never "you declined" (TG4)', async () => {
    for (const [error, reason] of [
      [{ code: -32002 }, 'wallet_busy'],
      [new Error('gone'), 'no_wallet'],
    ] as const) {
      const run = await setup();
      await signedNotSent(run);
      run.wallet.requestError = error;
      await run.session.retry('MetaMask');
      expect(waiting(run).problem).toEqual({ reason });
      run.wallet.requestError = undefined;
      run.wallet.switchError = error;
      await run.session.retry('MetaMask');
      expect(waiting(run).problem).toEqual({
        reason: reason === 'no_wallet' ? 'retry_blocked' : reason,
        ...(reason === 'no_wallet' ? { cause: 'chain_unreachable', chain: 'Base Sepolia' } : {}),
      });
    }
  });

  it('names a sent transaction only once its block is at the credit tag, not one block above (TG5)', async () => {
    for (const [safe, named] of [
      [994, false],
      [995, true],
    ] as const) {
      const run = await setup();
      await run.session.start();
      await run.session.pay('MetaMask');
      const record = await recordOf(run);
      const hash = markerOf(record).txHash ?? '';
      run.chain.receipts.set(hash, {
        transactionHash: hash,
        status: '0x1',
        blockNumber: '0x3e3',
        blockHash: blockHashOf(995),
        logs: [],
      });
      run.chain.safe = { number: safe, timestamp: NOW + 30 };
      await backend.transactProduct(record.productAddress, () => ({
        write: [
          {
            ...record,
            version: record.version + 2,
            state: 'completed',
            status: { status: 'completed', at: NOW + 60, delivery: 'https://shop.example/x' },
          },
        ],
        result: undefined,
      }));
      const later = new CheckoutSession(run.offer, run.deps);
      await later.start();
      const receipt = (await later.purchase(record.orderId))?.receipt;
      expect(receipt?.sent !== undefined).toBe(named);
    }
  });

  it('reads the end proof, and ends at load, while the nonce scan is unreadable (TG6)', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    pastSwitch(run, record);
    run.chain.down.add('eth_getLogs');
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(true);
    await reload(run);
    expect((await recordOf(run)).state).toBe('ended-unpaid');
  });

  it('shows a payment found at load as a banner on a page that only follows another order (TG7)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    land(run.chain, {
      hash: markerOf(record).txHash ?? '',
      authorizer: run.wallet.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 980,
    });
    await reload(run, {
      followOnly: { reason: 'offer_refused', message: 'no', orderId: 'f'.repeat(64) },
    });
    expect(run.banners).toContainEqual({ orderId: record.orderId, state: 'paid' });
  });

  it('offers no retry once the store refused this page during the order (TG8)', async () => {
    const run = await setup();
    await signedNotSent(run);
    run.advance(200);
    const refused: LoadedOffer = {
      ok: false,
      refusal: 'no_payable_payout',
      message: 'no longer here',
    };
    (run.session as unknown as { deps: SessionDeps }).deps.reloadOffer = async () => refused;
    await run.session.retry('MetaMask');
    expect(run.wallet.signed).toHaveLength(1);
    expect(waiting(run)).toMatchObject({ wallets: [], eip3009: { retry: false } });
  });

  it("while a retry's send prompt is open, 'taking long' waits for the new signature's proof moment (TG9)", async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    run.wallet.onSend = () => new Promise(() => undefined);
    void run.session.retry('MetaMask');
    await settle();
    await run.timers.tick();
    const current = markerOf(await recordOf(run));
    expect(current.txHash).toBeDefined();
    expect(run.last()).toMatchObject({
      kind: 'working',
      unsureAt: Number(current.validBefore) + 3000,
    });
  });

  it('shows an unsaved hash as sent, with its link, and lets it go once stored (TG10)', async () => {
    const run = await setup();
    run.wallet.onSend = async () => {
      const record = await recordOf(run);
      const marker = markerOf(record);
      await store.updateMarker(record.orderId, record.version, marker.attemptId, {
        ...marker,
        attemptId: 'another-tab',
      });
    };
    await run.session.start();
    await run.session.pay('MetaMask');
    const hash = `0x${'7'.repeat(56)}00000001`;
    expect(markerOf(await recordOf(run)).txHash).toBeUndefined();
    expect(waiting(run)).toMatchObject({
      explorer: `https://sepolia.basescan.org/tx/${hash}`,
      eip3009: { send: { kind: 'unknown', linked: true, maybe: false } },
    });
    await run.timers.tick();
    expect(markerOf(await recordOf(run)).txHash).toBe(hash);
    expect((run.session as unknown as { pendingHash: unknown }).pendingHash).toBeUndefined();
  });

  it('passes the chain id with the send (TG13)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.wallet.sent[0]).toMatchObject({ chainId: '0x14a34' });
  });
});

describe('review round 2: which earlier attempt comes back on a press', () => {
  /** A press after a close, for a holder prepared by `hold`: the attempt, or the earlier-payment line. */
  async function pressAfterClose(hold: (run: Run, record: OrderRecord) => Promise<void>) {
    const run = await setup();
    const record = await signedNotSent(run);
    await hold(run, record);
    run.session.resetOnClose();
    await run.session.pay('MetaMask');
    return run;
  }

  it('brings back neither an order the store cancelled nor one on a chain this build stopped serving', async () => {
    const cancelled = await pressAfterClose(async (_run, record) => storeCancels(record));
    expect(offerView(cancelled).problem).toMatchObject({ reason: 'earlier_payment' });
    const unserved = await pressAfterClose(async (run) => {
      run.served.on = false;
    });
    expect(offerView(unserved).problem).toMatchObject({ reason: 'earlier_payment' });
    expect(unserved.wallet.signed).toHaveLength(1);
  });

  it('brings back no frozen order whose nonce was used outside the checkout', async () => {
    const run = await setup();
    await run.session.start();
    const realRequest = run.chain.client.request;
    run.chain.client.request = async (args) => {
      if (selectorOf(args.method, args.params ?? []) === AUTHORIZATION_STATE) {
        for (const record of await store.forProduct(run.offer.productAddress)) {
          run.chain.used.add(`${run.wallet.account}:${record.reference}`);
        }
      }
      return realRequest(args);
    };
    await run.session.pay('MetaMask');
    expect(markerOf(await recordOf(run)).usedAtStart).toBe(true);
    run.session.resetOnClose();
    await run.session.pay('MetaMask');
    expect(offerView(run).problem).toMatchObject({
      reason: 'earlier_payment',
      phase: 'confirming',
    });
  });

  it('keeps a sent attempt "sent" when a retry of it is refused before signing', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    run.chain.tokens.set(run.wallet.account, 1n);
    await run.session.retry('MetaMask');
    expect(waiting(run)).toMatchObject({
      problem: { reason: 'insufficient_token' },
      eip3009: { send: { kind: 'sent' } },
    });
  });
});

describe('review round 2: what this session knows of a send', () => {
  it('after a reload, keeps a sent attempt "sent" when a retry of it is refused before signing', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const session = await reload(run);
    await session.pay('MetaMask');
    run.chain.tokens.set(run.wallet.account, 1n);
    await session.retry('MetaMask');
    // No memory of which attempt sent: neither "sent" nor "earlier", only that one was.
    expect(waiting(run)).toMatchObject({
      problem: { reason: 'insufficient_token' },
      eip3009: { send: { kind: 'unknown', linked: true, maybe: false } },
    });
  });

  it('brings back no attempt whose typed-data prompt this session still has open: the line, never a second prompt', async () => {
    const run = await setup();
    await run.session.start();
    run.wallet.onSign = () => new Promise(() => undefined);
    void run.session.pay('MetaMask');
    await settle();
    expect(markerOf(await recordOf(run)).signed).toBeUndefined();
    run.session.resetOnClose();
    await run.session.pay('Rabby');
    expect(offerView(run).problem).toMatchObject({ reason: 'earlier_payment' });
    expect(run.other.signed).toEqual([]);
  });
});

/** The store's completion of `record`, published to its inbox and heard by the widget. */
async function storeCompletes(run: Run, record: OrderRecord): Promise<void> {
  const status = {
    type: 'status',
    buyerPubkey: record.buyerPubkey,
    orderId: record.orderId,
    status: 'completed',
  } as OrderMessage;
  await run.relays.publish(
    INBOX,
    wrapOrderMessage(
      buildOrderMessage(status, NOW + 100),
      run.shop.store.secretKey,
      record.buyerPubkey,
    ).recipientWrap,
  );
  await settle();
}

describe('review round 3', () => {
  it('after a retry not sent and a reload: a payment was sent, not which, and "taking long" never early (finding 1)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const earlier = markerOf(await recordOf(run)).txHash ?? '';
    run.wallet.sendError = { code: 4001 };
    await run.session.retry('MetaMask');
    run.wallet.sendError = undefined;
    const session = await reload(run);
    await session.pay('MetaMask');
    const current = markerOf(await recordOf(run));
    expect(waiting(run)).toMatchObject({
      explorer: `https://sepolia.basescan.org/tx/${earlier}`,
      // validBefore + 3000 s (Base Sepolia's finalized wait), later than + 300 s (its credit wait).
      unsureAt: Number(current.validBefore) + 3000,
      eip3009: { send: { kind: 'unknown', linked: true, maybe: false } },
    });
  });

  it('a paid order comes back as the line "waiting for the store", never as an attempt to retry (R5)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    land(run.chain, {
      hash: markerOf(record).txHash ?? '',
      authorizer: run.wallet.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 980,
    });
    run.session.resetOnClose();
    await run.session.pay('MetaMask');
    expect(offerView(run).problem).toMatchObject({
      reason: 'earlier_payment',
      phase: 'waiting_store',
    });
  });

  it('a resumed attempt is the foreground one: its background follower stops (R9) and its answers show (R8)', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    run.session.resetOnClose();
    await run.session.pay('MetaMask');
    expect(waiting(run).eip3009?.retry).toBe(true);
    pastSwitch(run, record);
    await run.timers.tick();
    // Only the foreground follows it: the proof offers another wallet; nothing ends it unasked.
    expect(waiting(run).canRetry).toBe(true);
    expect((await recordOf(run)).state).toBe('paying');
    await run.session.startOver();
    expect((await recordOf(run)).state).toBe('ended-unpaid');
    await storeCompletes(run, record);
    expect(run.last()).toMatchObject({ kind: 'delivered' });
  });

  it('offers no retry on a page that only follows the order (finding 5)', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    await reload(run, {
      followOnly: { reason: 'offer_refused', message: 'no', orderId: record.orderId },
    });
    expect(waiting(run)).toMatchObject({ wallets: [], eip3009: { retry: false } });
  });

  it('a retry press on an order no longer paying asks nothing (finding 5)', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    inside(run.session).record = { ...record, state: 'paid', paidTx: `0x${'1'.repeat(64)}` };
    const views = run.views.length;
    run.wallet.requestError = { code: 4001 };
    await run.session.retry('MetaMask');
    expect(run.views.length).toBe(views);
    expect(run.wallet.signed).toHaveLength(1);
  });
});

describe('the registry waits the never-early rule rests on', () => {
  it.each(EIP3009_CHAINS)(
    'on $chainName the finalized wait is longer than the credit wait',
    (chain) => {
      const waits = chain.waits;
      expect(waits).toBeDefined();
      expect((waits?.finalizedSecs ?? 0) > (waits?.creditSecs ?? 0)).toBe(true);
    },
  );
});

/** The last transaction a fake wallet sent. */
function sentCall(wallet: Run['wallet']): { from: string; data: string } {
  const sent = wallet.sent.at(-1);
  if (sent === undefined) {
    throw new Error('nothing sent');
  }
  return sent;
}

/** How the build RPC answers `eth_getTransactionByHash` (`answerSenders`). */
interface SenderReads {
  how: 'answer' | 'throw' | 'null';
  /** While set, every read waits for it before answering. */
  gate?: Promise<void>;
  readonly sent: Map<string, { from: string; data: string }>;
}

/** How the build RPC answers `eth_getTransactionByHash` in `run`. */
function answerSenders(run: Run): SenderReads {
  return run.reads;
}

/**
 * Answers `eth_getTransactionByHash` from the transactions the fake wallets
 * sent (as a node does: the call each one sent under its hash).
 */
function readsOf(chain: FakeChain, wallets: readonly Eip3009Wallet[]): SenderReads {
  const reads: SenderReads = { how: 'answer', sent: new Map() };
  for (const wallet of wallets) {
    const realSend = wallet.sendTransaction;
    wallet.sendTransaction = async (call) => {
      const hash = await realSend(call);
      reads.sent.set(hash, { from: call.from, data: call.data });
      return hash;
    };
  }
  const realRequest = chain.client.request;
  chain.client.request = async (args) => {
    if (args.method !== 'eth_getTransactionByHash') {
      return realRequest(args);
    }
    chain.calls.push({ method: args.method, params: args.params ?? [] });
    await reads.gate;
    if (reads.how === 'throw') {
      throw new Error('rpc down');
    }
    const sent = reads.how === 'null' ? undefined : reads.sent.get(String((args.params ?? [])[0]));
    // Nodes answer hex in any case: compared case-insensitively.
    return sent === undefined
      ? null
      : {
          hash: (args.params ?? [])[0],
          from: sent.from,
          input: `0x${sent.data.slice(2).toUpperCase()}`,
        };
  };
  return reads;
}

/**
 * Wallet A sent, its authorization was proven over, then wallet B was
 * switched to: the marker still carries A's hash. `sendB`: B sent too;
 * `unsavedB`: and its hash could not be stored.
 */
async function switched(
  sendB: boolean,
  unsavedB = false,
): Promise<{ run: Run; hashOfA: string; reads: SenderReads }> {
  const run = await setup();
  await run.session.start();
  await run.session.pay('MetaMask');
  const first = await recordOf(run);
  const hashOfA = markerOf(first).txHash ?? '';
  const reads = answerSenders(run);
  reads.sent.set(hashOfA, sentCall(run.wallet));
  pastSwitch(run, first);
  await run.timers.tick();
  expect(waiting(run).canRetry).toBe(true);
  if (!sendB) {
    run.other.sendError = { code: 4001 };
  }
  if (unsavedB) {
    hashWriteFailsOnce(run.other);
  }
  run.other.nextHash = () => `0x${'8'.repeat(64)}`;
  await run.session.retry('Rabby');
  run.other.sendError = undefined;
  const marker = markerOf(await recordOf(run));
  expect(marker.switchProof).toBeDefined();
  if (sendB) {
    reads.sent.set(`0x${'8'.repeat(64)}`, sentCall(run.other));
  }
  if (!sendB || unsavedB) {
    expect(marker.txHash).toBe(hashOfA);
  }
  return { run, hashOfA, reads };
}

/** The store refuses the write of the hash this wallet's next send returns (not a conflict). */
function hashWriteFailsOnce(wallet: Run['wallet']): void {
  wallet.onSend = async () => {
    wallet.onSend = undefined;
    vi.spyOn(store, 'updateMarker').mockResolvedValueOnce({ ok: false, reason: 'not_ready' });
  };
}

describe('review round 4', () => {
  it.each([
    ['throws other than a decline', (run: Run) => (run.wallet.sendError = { code: -32603 })],
    ['answers no hash', (run: Run) => (run.wallet.nextHash = () => 'not a hash')],
  ] as const)(
    'a wallet that %s while sending: maybe sent, never "not sent" (finding 1)',
    async (_how, prepare) => {
      const run = await setup();
      prepare(run);
      await run.session.start();
      await run.session.pay('MetaMask');
      expect(markerOf(await recordOf(run)).txHash).toBeUndefined();
      expect(waiting(run)).toMatchObject({
        problem: { reason: 'send_uncertain' },
        eip3009: { send: { kind: 'unknown', linked: false, maybe: true }, retry: true },
      });
      expect(waiting(run)).not.toHaveProperty('eip3009.resend');
    },
  );

  it("never says the switched-from wallet's payment may still arrive, in session or after a reload (finding 2)", async () => {
    const { run } = await switched(false);
    await run.timers.tick();
    expect(waiting(run)).not.toHaveProperty('explorer');
    expect(waiting(run).eip3009).toMatchObject({
      send: { kind: 'not_sent', earlier: false },
    });
    const session = await reload(run);
    await session.pay('Rabby');
    await run.timers.tick();
    expect(waiting(run)).not.toHaveProperty('explorer');
    expect(waiting(run).eip3009).toMatchObject({
      send: { kind: 'unknown', linked: false, maybe: false },
    });
  });

  it('names a payment the switched-to wallet sent, after a reload too (finding 2)', async () => {
    const { run, hashOfA } = await switched(true);
    const hashOfB = markerOf(await recordOf(run)).txHash ?? '';
    expect(hashOfB).not.toBe(hashOfA);
    expect(waiting(run)).toMatchObject({
      explorer: `https://sepolia.basescan.org/tx/${hashOfB}`,
      eip3009: { send: { kind: 'sent' } },
    });
    const session = await reload(run);
    await session.pay('Rabby');
    await run.timers.tick();
    await run.timers.tick();
    expect(waiting(run)).toMatchObject({
      explorer: `https://sepolia.basescan.org/tx/${hashOfB}`,
      eip3009: { send: { kind: 'unknown', linked: true, maybe: false } },
    });
    // The sender is read once per hash, not on every pass.
    const reads = run.chain.calls.filter((call) => call.method === 'eth_getTransactionByHash');
    expect(reads.filter((call) => call.params[0] === hashOfB)).toHaveLength(1);
  });

  it('reads the signer of a hash it sent never, and of a stored one once after a reload', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    await run.timers.tick();
    const count = () =>
      run.chain.calls.filter((call) => call.method === 'eth_getTransactionByHash').length;
    expect(count()).toBe(0);
    const session = await reload(run);
    await session.pay('MetaMask');
    await run.timers.tick();
    await run.timers.tick();
    expect(waiting(run).explorer).toBeDefined();
    expect(count()).toBe(1);
  });

  it('reads no fee at load for an eip3009 payout the build has no RPC for (M19)', async () => {
    let reads = 0;
    const run = await setup({
      eip3009For: () => undefined,
      deps: {
        feeTerms: async () => {
          reads += 1;
          return { feeBps: 50, treasury: '' };
        },
      },
    });
    await run.session.start();
    expect(reads).toBe(0);
    expect(run.last()).toMatchObject({ kind: 'refused', message: NO_NETWORK });
  });

  it('remembers what a detached press sent, and what it did not (M76)', async () => {
    const sent = await setup();
    await sent.session.start();
    sent.wallet.onSend = async () => {
      sent.session.resetOnClose();
    };
    await sent.session.pay('MetaMask');
    sent.wallet.onSend = undefined;
    await sent.session.pay('MetaMask');
    expect(waiting(sent).eip3009).toMatchObject({ send: { kind: 'sent' } });

    const unsent = await setup();
    await unsent.session.start();
    await unsent.session.pay('MetaMask');
    unsent.wallet.onSend = async () => {
      unsent.wallet.sendError = { code: 4001 };
      unsent.session.resetOnClose();
    };
    await unsent.session.retry('MetaMask');
    unsent.wallet.onSend = undefined;
    unsent.wallet.sendError = undefined;
    await unsent.session.pay('MetaMask');
    expect(waiting(unsent).eip3009).toMatchObject({ send: { kind: 'not_sent', earlier: true } });
  });

  it('names a returned hash it could not store in the receipt of an order completed meanwhile (M139)', async () => {
    const run = await setup();
    replacedDuringSendOnce(run);
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    expect(markerOf(record).txHash).toBeUndefined();
    const hash = `0x${'7'.repeat(56)}00000001`;
    run.chain.receipts.set(hash, {
      transactionHash: hash,
      status: '0x1',
      blockNumber: '0x3d4',
      blockHash: blockHashOf(980),
      logs: [],
    });
    await backend.transactProduct(record.productAddress, () => ({
      write: [
        {
          ...record,
          version: record.version + 1,
          state: 'completed',
          status: { status: 'completed', at: NOW + 60, delivery: 'https://shop.example/x' },
        },
      ],
      result: undefined,
    }));
    expect((await run.session.purchase(record.orderId))?.receipt.sent).toEqual({
      tx: hash,
      explorer: `https://sepolia.basescan.org/tx/${hash}`,
    });
  });

  it('refuses cleanly a retry naming a wallet no longer listed (M150)', async () => {
    const run = await setup();
    await signedNotSent(run);
    const views = run.views.length;
    await run.session.retry('A wallet that left');
    expect(waiting(run).problem).toEqual({ reason: 'no_wallet' });
    // Refused before anything starts: no connecting screen in between.
    expect(run.views.slice(views).some((view) => view.kind === 'working')).toBe(false);
  });
});

/** Another tab replaces the attempt while the send prompt is open: the hash cannot be stored. */
function replacedDuringSendOnce(run: Run): void {
  run.wallet.onSend = async () => {
    run.wallet.onSend = undefined;
    const record = await recordOf(run);
    const marker = markerOf(record);
    await store.updateMarker(record.orderId, record.version, marker.attemptId, {
      ...marker,
      attemptId: 'another-tab',
    });
  };
}

describe('review round 5: the send state is facts only', () => {
  /** Every wait drawn since `from`: none may claim a send or a non-send, nor name a hash. */
  function neutralSince(run: Run, from: number, drawn = true): void {
    const views = run.views.slice(from);
    expect(views.some((view) => 'explorer' in view)).toBe(false);
    const waits = views.filter((view): view is WaitingView => view.kind === 'waiting_payment');
    expect(waits.length > 0).toBe(drawn);
    for (const wait of waits) {
      expect(wait).not.toHaveProperty('explorer');
      expect(wait.eip3009?.send).toEqual({ kind: 'unknown', linked: false, maybe: false });
    }
  }

  it('a retry of a sent attempt whose typed-data prompt is declined claims no new signature and no "not sent": the earlier payment may land (case 1)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const first = markerOf(await recordOf(run));
    run.wallet.signError = { code: 4001 };
    await run.session.retry('MetaMask');
    run.wallet.signError = undefined;
    expect(run.wallet.signed).toHaveLength(1);
    // The retry wrote its own attempt before the prompt: nothing is known of it.
    expect(markerOf(await recordOf(run)).attemptId).not.toBe(first.attemptId);
    const wait = waiting(run);
    expect(wait.problem).toEqual({ reason: 'again_declined' });
    expect(wait.explorer).toBe(`https://sepolia.basescan.org/tx/${first.txHash}`);
    expect(wait.eip3009?.send).toEqual({ kind: 'unknown', linked: true, maybe: false });
    expect(wait.eip3009).not.toHaveProperty('resend');
  });

  it.each(['throw', 'null'] as const)(
    'after a switch and a reload, a sender read that does %s claims nothing and names no hash, from the first draw (case 2)',
    async (how) => {
      const { run, reads } = await switched(true);
      reads.how = how;
      const from = run.views.length;
      const session = await reload(run);
      await session.pay('Rabby');
      await run.timers.tick();
      await run.timers.tick();
      neutralSince(run, from);
      // Once the read answers, the hash is named, never claimed sent by this page
      // (a null answer is asked again only after a minute).
      reads.how = 'answer';
      run.advance(61);
      await run.timers.tick();
      await run.timers.tick();
      expect(waiting(run)).toMatchObject({
        explorer: `https://sepolia.basescan.org/tx/0x${'8'.repeat(64)}`,
        eip3009: { send: { kind: 'unknown', linked: true, maybe: false } },
      });
    },
  );

  it('after a reload, every draw before the sender read answers names no hash (case 2)', async () => {
    const { run, reads } = await switched(true);
    let release = (): void => undefined;
    reads.gate = new Promise((resolve) => {
      release = resolve;
    });
    const from = run.views.length;
    const session = await reload(run);
    const paid = session.pay('Rabby');
    await settle();
    // The wait is drawn only once the read answered: nothing before it names the hash.
    neutralSince(run, from, false);
    release();
    await paid;
    await run.timers.tick();
    expect(waiting(run)).toMatchObject({
      explorer: `https://sepolia.basescan.org/tx/0x${'8'.repeat(64)}`,
      eip3009: { send: { kind: 'unknown', linked: true, maybe: false } },
    });
  });

  it('a plain retry whose new hash could not be stored names that hash, as sent, never the stored older one (case 3)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const older = markerOf(await recordOf(run)).txHash ?? '';
    hashWriteFailsOnce(run.wallet);
    run.wallet.nextHash = () => `0x${'9'.repeat(64)}`;
    await run.session.retry('MetaMask');
    expect(markerOf(await recordOf(run)).txHash).toBe(older);
    expect(waiting(run)).toMatchObject({
      explorer: `https://sepolia.basescan.org/tx/0x${'9'.repeat(64)}`,
      eip3009: { send: { kind: 'sent' } },
    });
  });

  it("after a switch, an unsaved hash of the new wallet is named as sent, never the switched-from wallet's (case 3)", async () => {
    const { run, hashOfA } = await switched(true, true);
    for (const view of run.views.slice(-3)) {
      expect(view).not.toHaveProperty('explorer', `https://sepolia.basescan.org/tx/${hashOfA}`);
    }
    expect(waiting(run)).toMatchObject({
      explorer: `https://sepolia.basescan.org/tx/0x${'8'.repeat(64)}`,
      eip3009: { send: { kind: 'sent' } },
    });
  });

  it('once another tab replaced that attempt, still names the unsaved hash of the same wallet, not the dead one, and claims nothing (case 3)', async () => {
    const { run, hashOfA } = await switched(true, true);
    const record = await recordOf(run);
    const marker = markerOf(record);
    await store.updateMarker(record.orderId, record.version, marker.attemptId, {
      ...marker,
      attemptId: 'another-tab',
    });
    await run.timers.tick();
    await run.timers.tick();
    const wait = waiting(run);
    expect(wait.explorer).not.toBe(`https://sepolia.basescan.org/tx/${hashOfA}`);
    expect(wait).toMatchObject({
      explorer: `https://sepolia.basescan.org/tx/0x${'8'.repeat(64)}`,
      eip3009: { send: { kind: 'unknown', linked: true, maybe: false } },
    });
  });

  it('never names a hash of the current wallet signed before the switch proof: switched back to it, its old payment is over', async () => {
    const { run, hashOfA } = await switched(false);
    const toB = await recordOf(run);
    pastSwitch(run, toB);
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(true);
    run.wallet.sendError = { code: 4001 };
    await run.session.retry('MetaMask');
    run.wallet.sendError = undefined;
    const back = markerOf(await recordOf(run));
    expect(back.authorizer).toBe(run.wallet.account.toLowerCase());
    expect(back.txHash).toBe(hashOfA);
    await run.timers.tick();
    expect(waiting(run)).not.toHaveProperty('explorer');
    expect(waiting(run).eip3009?.send).toEqual({ kind: 'not_sent', earlier: false });
    const session = await reload(run);
    await session.pay('MetaMask');
    await run.timers.tick();
    await run.timers.tick();
    expect(waiting(run)).not.toHaveProperty('explorer');
    expect(waiting(run).eip3009?.send).toEqual({ kind: 'unknown', linked: false, maybe: false });
  });

  it('a signed attempt whose send failed, or that must be signed again, is "not sent" (send_failed, resign_needed)', async () => {
    const failed = await setup();
    failed.chain.estimate = () => {
      throw { code: 3, message: 'execution reverted' };
    };
    await failed.session.start();
    await failed.session.pay('MetaMask');
    expect(waiting(failed)).toMatchObject({
      problem: { reason: 'send_failed' },
      eip3009: { send: { kind: 'not_sent', earlier: false } },
    });
    const late = await setup();
    late.wallet.onSign = async () => {
      const marker = markerOf(await recordOf(late));
      late.chain.latest = { number: 1010, timestamp: Number(marker.validBefore) - 60 };
    };
    await late.session.start();
    await late.session.pay('MetaMask');
    expect(late.wallet.sent).toEqual([]);
    expect(waiting(late)).toMatchObject({
      problem: { reason: 'resign_needed' },
      eip3009: { send: { kind: 'not_sent', earlier: false } },
    });
  });

  it('a first signature whose write the store refused leaves an unsigned marker: no claim either way', async () => {
    const run = await setup();
    run.wallet.onSign = async () => {
      run.wallet.onSign = undefined;
      vi.spyOn(store, 'updateMarker').mockResolvedValueOnce({ ok: false, reason: 'not_ready' });
    };
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.wallet.sent).toEqual([]);
    expect(markerOf(await recordOf(run)).signed).not.toBe(true);
    expect(waiting(run).eip3009?.send).toEqual({ kind: 'unknown', linked: false, maybe: false });
  });

  it.each([
    ['not sent', signedNotSent],
    [
      'maybe sent',
      async (run: Run) => {
        run.wallet.sendError = { code: -32603 };
        await run.session.start();
        await run.session.pay('MetaMask');
        run.wallet.sendError = undefined;
        return await recordOf(run);
      },
    ],
  ] as const)(
    'a fact about an attempt (%s) says nothing of the one another tab put in its place',
    async (_fact, prepare) => {
      const run = await setup();
      const record = await prepare(run);
      const marker = markerOf(record);
      await store.updateMarker(record.orderId, record.version, marker.attemptId, {
        ...marker,
        attemptId: 'another-tab',
      });
      await run.timers.tick();
      expect(waiting(run).eip3009?.send).toEqual({ kind: 'unknown', linked: false, maybe: false });
    },
  );

  it.each([false, true])(
    'names a hash "send again" sent after a switch (unsaved: %s), once another tab replaced it, while the chain cannot say who sent it',
    async (unsaved) => {
      const { run, reads, hashOfA } = await switched(false);
      reads.how = 'throw';
      run.other.nextHash = () => `0x${'6'.repeat(64)}`;
      if (unsaved) {
        hashWriteFailsOnce(run.other);
      }
      await run.session.resend();
      expect(waiting(run).eip3009?.send).toEqual({ kind: 'sent' });
      const record = await recordOf(run);
      const marker = markerOf(record);
      expect(marker.txHash).toBe(unsaved ? hashOfA : `0x${'6'.repeat(64)}`);
      await store.updateMarker(record.orderId, record.version, marker.attemptId, {
        ...marker,
        attemptId: 'another-tab',
      });
      await run.timers.tick();
      expect(waiting(run)).toMatchObject({
        explorer: `https://sepolia.basescan.org/tx/0x${'6'.repeat(64)}`,
        eip3009: { send: { kind: 'unknown', linked: true, maybe: false } },
      });
    },
  );

  it('names no hash the chain says is not a transferWithAuthorization', async () => {
    const { run, reads } = await switched(true);
    const hashOfB = `0x${'8'.repeat(64)}`;
    const real = reads.sent.get(hashOfB);
    if (real === undefined) {
      throw new Error('no send of B');
    }
    // Same head words, another selector (an ERC-20 transfer).
    reads.sent.set(hashOfB, { from: real.from, data: `0xa9059cbb${real.data.slice(10)}` });
    const session = await reload(run);
    await session.pay('Rabby');
    await run.timers.tick();
    await run.timers.tick();
    expect(waiting(run)).not.toHaveProperty('explorer');
    expect(waiting(run).eip3009?.send).toEqual({ kind: 'unknown', linked: false, maybe: false });
  });
});

describe('review round 6', () => {
  it.each([
    [
      'too_early',
      (run: Run, record: OrderRecord) => {
        // The finalized block is not past validBefore yet.
        run.chain.finalized = { number: 1100, timestamp: Number(markerOf(record).validBefore) };
      },
    ],
    [
      'unreadable',
      (run: Run) => {
        run.chain.failIf = (method, params) =>
          method === 'eth_call' &&
          typeof params[1] === 'object' &&
          params[1] !== null &&
          'blockHash' in params[1];
      },
    ],
  ] as const)(
    'keeps the attempt live at switchAt while the end proof says %s (S54)',
    async (_state, prepare) => {
      const run = await setup();
      const record = await signedNotSent(run);
      pastSwitch(run, record);
      prepare(run, record);
      await run.timers.tick();
      await run.timers.tick();
      const wait = waiting(run);
      // Another wallet, Start over and the "expired unused" text all hang on canRetry.
      expect(wait.canRetry).toBe(false);
      // The first attempt's own refusal, never "expired unused, nothing was paid".
      expect(wait.problem).toEqual({ reason: 'send_declined' });
      expect(wait.eip3009).toMatchObject({ retry: true, send: { kind: 'not_sent' } });
      await run.session.startOver();
      expect((await recordOf(run)).state).toBe('paying');
    },
  );

  it('a retry whose signature the store refused to write was signed and not sent (S13)', async () => {
    const run = await setup();
    const first = markerOf(await signedNotSent(run));
    const sends = run.wallet.sent.length;
    // A later chain time: the retry signs a new validBefore, so a new signature.
    run.chain.latest = { ...run.chain.latest, timestamp: run.chain.latest.timestamp + 10 };
    run.advance(10);
    run.wallet.onSign = async () => {
      run.wallet.onSign = undefined;
      vi.spyOn(store, 'updateMarker').mockResolvedValueOnce({ ok: false, reason: 'not_ready' });
    };
    await run.session.retry('MetaMask');
    expect(run.wallet.signed).toHaveLength(2);
    expect(run.wallet.sent).toHaveLength(sends);
    const current = markerOf(await recordOf(run));
    // The retry's own attempt, copied signed from the first, is the one on screen.
    expect(current.attemptId).not.toBe(first.attemptId);
    expect(current.signed).toBe(true);
    expect(waiting(run).eip3009?.send).toEqual({ kind: 'not_sent', earlier: false });
  });

  it("never names another order's unsaved hash (S65)", async () => {
    const run = await setup();
    await signedNotSent(run);
    const session = await reload(run);
    (session as unknown as { pendingHash: unknown }).pendingHash = {
      orderId: 'another-order',
      hash: `0x${'5'.repeat(64)}`,
    };
    await session.pay('MetaMask');
    await run.timers.tick();
    expect(waiting(run)).not.toHaveProperty('explorer');
    expect(waiting(run).eip3009?.send).toEqual({ kind: 'unknown', linked: false, maybe: false });
  });

  it.each([
    [
      'answers null',
      (reads: SenderReads): void => {
        reads.how = 'null';
      },
    ],
    [
      'names no authorization',
      (reads: SenderReads): void => {
        for (const [hash, sent] of reads.sent) {
          reads.sent.set(hash, { from: sent.from, data: `0xa9059cbb${sent.data.slice(10)}` });
        }
      },
    ],
    [
      'is cut off inside validBefore (M45)',
      (reads: SenderReads): void => {
        for (const [hash, sent] of reads.sent) {
          reads.sent.set(hash, { from: sent.from, data: sent.data.slice(0, 10 + 4 * 64 + 10) });
        }
      },
    ],
  ] as const)(
    'asks again about a switched hash whose read %s only after a minute',
    async (_how, prepare) => {
      const { run, reads } = await switched(true);
      prepare(reads);
      const session = await reload(run);
      await session.pay('Rabby');
      const hashOfB = `0x${'8'.repeat(64)}`;
      const readCount = () =>
        run.chain.calls.filter(
          (call) => call.method === 'eth_getTransactionByHash' && call.params[0] === hashOfB,
        ).length;
      const before = readCount();
      expect(waiting(run)).not.toHaveProperty('explorer');
      await run.timers.tick();
      await run.timers.tick();
      await run.timers.tick();
      expect(readCount()).toBe(before);
      run.advance(59);
      await run.timers.tick();
      expect(readCount()).toBe(before);
      // Asked again at the very second the minute is up.
      run.advance(1);
      await run.timers.tick();
      expect(readCount()).toBe(before + 1);
    },
  );

  it('asks again on the next pass after a read that failed', async () => {
    const { run, reads } = await switched(true);
    reads.how = 'throw';
    const session = await reload(run);
    await session.pay('Rabby');
    const count = () =>
      run.chain.calls.filter((call) => call.method === 'eth_getTransactionByHash').length;
    const before = count();
    await run.timers.tick();
    expect(count()).toBeGreaterThan(before);
  });
});

describe('review round 7: an earlier attempt proven over is never named', () => {
  /** No claim of a send, of a payment confirming, nor a link: the wallet step is the current one. */
  function nothingSent(run: Run, dead: string): void {
    const wait = waiting(run);
    expect(wait.explorer ?? '').not.toContain(dead);
    expect(wait).not.toHaveProperty('explorer');
    const send = wait.eip3009?.send;
    if (send === undefined) {
      throw new Error('no send state');
    }
    const words = eip3009SendWords(send);
    expect(words.walletDone).toBe(false);
    expect([
      EIP3009_WAIT.sent,
      EIP3009_WAIT.sentUnknown,
      EIP3009_WAIT.maybeSent,
      EIP3009_WAIT.signedEarlierSent,
    ]).not.toContain(words.lead);
    expect(words.confirming).toBe(false);
    expect(words.heading).not.toBe('Confirming payment');
    expect(wait.eip3009?.confirming).toBe(false);
  }

  it('the same wallet picked again once its attempt was proven over, in session and after a reload', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const first = await recordOf(run);
    const dead = markerOf(first).txHash ?? '';
    pastSwitch(run, first);
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(true);
    run.wallet.sendError = { code: 4001 };
    await run.session.retry('MetaMask');
    run.wallet.sendError = undefined;
    const marker = markerOf(await recordOf(run));
    expect(marker.switchProof).toBeUndefined();
    expect(marker.txHash).toBe(dead);
    nothingSent(run, dead);
    expect(waiting(run).eip3009?.send).toEqual({ kind: 'not_sent', earlier: false });
    await run.timers.tick();
    nothingSent(run, dead);
    const session = await reload(run);
    await session.pay('MetaMask');
    await run.timers.tick();
    nothingSent(run, dead);
    expect(waiting(run).eip3009?.send).toEqual({ kind: 'unknown', linked: false, maybe: false });
  });

  it('a switched-to wallet picked again once its own attempt was proven over, in session and after a reload', async () => {
    const { run } = await switched(true);
    const dead = `0x${'8'.repeat(64)}`;
    const toB = await recordOf(run);
    expect(markerOf(toB).txHash).toBe(dead);
    pastSwitch(run, toB);
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(true);
    run.other.sendError = { code: 4001 };
    await run.session.retry('Rabby');
    run.other.sendError = undefined;
    expect(markerOf(await recordOf(run)).txHash).toBe(dead);
    nothingSent(run, dead);
    expect(waiting(run).eip3009?.send).toEqual({ kind: 'not_sent', earlier: false });
    const session = await reload(run);
    await session.pay('Rabby');
    await run.timers.tick();
    nothingSent(run, dead);
    expect(waiting(run).eip3009?.send).toEqual({ kind: 'unknown', linked: false, maybe: false });
  });

  it('names an earlier hash after a reload while its proof is not due, and once due only when over is not proven', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    const hash = markerOf(record).txHash ?? '';
    const session = await reload(run);
    await session.pay('MetaMask');
    await run.timers.tick();
    expect(waiting(run).explorer).toBe(`https://sepolia.basescan.org/tx/${hash}`);
    // Due, but the finalized block is not past validBefore yet: it may still land.
    const validBefore = Number(markerOf(record).validBefore);
    run.chain.finalized = { number: 1100, timestamp: validBefore };
    run.advance(validBefore + BASE_SEPOLIA.waits.finalizedSecs - run.now());
    await run.timers.tick();
    expect(waiting(run).explorer).toBe(`https://sepolia.basescan.org/tx/${hash}`);
    // Its nonce read used: the payment is followed, the hash never called dead.
    run.chain.finalized = { number: 1100, timestamp: validBefore + 1 };
    run.chain.used.add(`${run.wallet.account}:${record.reference}`);
    run.chain.usedPinned = new Set(run.chain.used);
    await run.timers.tick();
    expect(
      (session as unknown as { eip3009HashProof: Map<string, string> }).eip3009HashProof.get(hash),
    ).toBe('used');
  });

  /** Reads of the finalized block, the first step of every end proof. */
  function finalizedReads(run: Run): number {
    return run.chain.calls.filter(
      (call) => call.method === 'eth_getBlockByNumber' && call.params[0] === 'finalized',
    ).length;
  }

  it("asks an earlier hash's end proof only once due, and never again once it held", async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    const validBefore = Number(markerOf(record).validBefore);
    const session = await reload(run);
    await session.pay('MetaMask');
    const before = finalizedReads(run);
    await run.timers.tick();
    // Past validBefore, not yet past the finalized wait: no proof is asked.
    run.advance(validBefore + 1 - run.now());
    await run.timers.tick();
    expect(finalizedReads(run)).toBe(before);
    // Due: asked, and over; the same wallet picks a new attempt (its own proof
    // not due yet): no pass asks that hash's proof again.
    pastSwitch(run, record);
    run.chain.calls.length = 0;
    await run.timers.tick();
    expect(finalizedReads(run)).toBeGreaterThan(0);
    expect(waiting(run).canRetry).toBe(true);
    run.wallet.sendError = { code: 4001 };
    await session.retry('MetaMask');
    run.wallet.sendError = undefined;
    run.chain.calls.length = 0;
    await run.timers.tick();
    await run.timers.tick();
    expect(finalizedReads(run)).toBe(0);
    expect(waiting(run)).not.toHaveProperty('explorer');
  });

  it('asks again after an unreadable end proof, and stops naming the hash once it holds', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    const hash = markerOf(record).txHash ?? '';
    const validBefore = Number(markerOf(record).validBefore);
    const session = await reload(run);
    await session.pay('MetaMask');
    await run.timers.tick();
    run.chain.finalized = { number: 1100, timestamp: validBefore + 1 };
    run.advance(validBefore + BASE_SEPOLIA.waits.finalizedSecs - run.now());
    run.chain.failIf = (method, params) =>
      method === 'eth_call' &&
      typeof params[1] === 'object' &&
      params[1] !== null &&
      'blockHash' in params[1];
    await run.timers.tick();
    // Not proven over: it may still land, and stays named.
    expect(waiting(run).explorer).toBe(`https://sepolia.basescan.org/tx/${hash}`);
    run.chain.failIf = undefined;
    await run.timers.tick();
    await run.timers.tick();
    expect(waiting(run)).not.toHaveProperty('explorer');
  });

  it("never names the switched-from wallet's hash after a reload, even while no end proof can be read", async () => {
    const { run, hashOfA } = await switched(false);
    run.chain.failIf = (method, params) =>
      method === 'eth_call' &&
      typeof params[1] === 'object' &&
      params[1] !== null &&
      'blockHash' in params[1];
    const session = await reload(run);
    await session.pay('Rabby');
    await run.timers.tick();
    expect(markerOf(await recordOf(run)).txHash).toBe(hashOfA);
    expect(waiting(run)).not.toHaveProperty('explorer');
  });

  /** End-proof reads: the finalized block, and calls pinned to it. */
  function proofReads(run: Run): number {
    return run.chain.calls.filter(
      (call) =>
        (call.method === 'eth_getBlockByNumber' && call.params[0] === 'finalized') ||
        (call.method === 'eth_call' &&
          typeof call.params[1] === 'object' &&
          call.params[1] !== null &&
          'blockHash' in call.params[1]),
    ).length;
  }

  /**
   * h1 sent and stored; a same-wallet retry at a later chain time (a later
   * validBefore) declined or sent: the marker still carries h1, the retry's
   * own proof is not due when h1's is.
   */
  async function retriedLater(run: Run, sendRetry: 'decline' | 'unsaved'): Promise<OrderRecord> {
    await run.session.start();
    await run.session.pay('MetaMask');
    const first = await recordOf(run);
    run.chain.latest = { ...run.chain.latest, timestamp: run.chain.latest.timestamp + 60 };
    run.advance(60);
    if (sendRetry === 'decline') {
      run.wallet.sendError = { code: 4001 };
    } else {
      hashWriteFailsOnce(run.wallet);
      run.wallet.nextHash = () => `0x${'9'.repeat(64)}`;
    }
    await run.session.retry('MetaMask');
    run.wallet.sendError = undefined;
    expect(markerOf(await recordOf(run)).txHash).toBe(markerOf(first).txHash);
    expect(Number(markerOf(await recordOf(run)).validBefore)).toBeGreaterThan(
      Number(markerOf(first).validBefore),
    );
    return first;
  }

  it("never asks an earlier hash's end proof again once its nonce read used (M5)", async () => {
    const run = await setup();
    const first = await retriedLater(run, 'decline');
    const hash = markerOf(first).txHash ?? '';
    const session = await reload(run);
    await session.pay('MetaMask');
    await run.timers.tick();
    const validBefore = Number(markerOf(first).validBefore);
    run.chain.finalized = { number: 1100, timestamp: validBefore + 1 };
    run.chain.used.add(`${run.wallet.account}:${first.reference}`);
    run.chain.usedPinned = new Set(run.chain.used);
    run.advance(validBefore + BASE_SEPOLIA.waits.finalizedSecs - run.now());
    await run.timers.tick();
    expect(
      (session as unknown as { eip3009HashProof: Map<string, string> }).eip3009HashProof.get(hash),
    ).toBe('used');
    // The current attempt's own proof is not due: no pass reads a proof any more.
    run.chain.calls.length = 0;
    await run.timers.tick();
    await run.timers.tick();
    await run.timers.tick();
    expect(proofReads(run)).toBe(0);
  });

  it('judges the stored hash first: an unsaved later one is named, the earlier one proven over never (M15)', async () => {
    const run = await setup();
    const first = await retriedLater(run, 'unsaved');
    const h1 = markerOf(first).txHash ?? '';
    const h2 = `0x${'9'.repeat(64)}`;
    expect((run.session as unknown as { pendingHash?: { hash: string } }).pendingHash?.hash).toBe(
      h2,
    );
    const record = await recordOf(run);
    const marker = markerOf(record);
    await store.updateMarker(record.orderId, record.version, marker.attemptId, {
      ...marker,
      attemptId: 'another-tab',
    });
    // Past h1's validBefore plus the finalized wait, its nonce unused there; h2 may still land.
    const v1 = Number(markerOf(first).validBefore);
    run.chain.finalized = { number: 1100, timestamp: v1 + 1 };
    run.advance(v1 + BASE_SEPOLIA.waits.finalizedSecs - run.now());
    const from = run.views.length;
    await run.timers.tick();
    await run.timers.tick();
    const wait = waiting(run);
    expect(wait.eip3009?.send.kind).toBe('unknown');
    expect(wait.explorer).toBe(`https://sepolia.basescan.org/tx/${h2}`);
    for (const view of run.views.slice(from)) {
      expect(view).not.toHaveProperty('explorer', `https://sepolia.basescan.org/tx/${h1}`);
    }
  });
});

describe('review round 9', () => {
  it('a page that only follows an eip3009 order: Start over alone, never a wallet, before and after the proof (D19)', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    const session = await reload(run, {
      followOnly: { reason: 'offer_refused', message: 'no', orderId: record.orderId },
    });
    expect(waiting(run)).toMatchObject({
      followOnly: true,
      canRetry: false,
      wallets: [],
      eip3009: { retry: false },
    });
    expect(waiting(run).eip3009?.switchAt).toBeDefined();
    pastSwitch(run, record);
    await run.timers.tick();
    // Proven over: anywhere else another wallet is offered; here Start over only.
    expect(waiting(run)).toMatchObject({ followOnly: true, canRetry: true, wallets: [] });
    await session.startOver();
    expect((await recordOf(run)).state).toBe('ended-unpaid');
  });

  it('drops the order on screen when the fee rises at a press after the stored orders were wiped: its listener stops (D15)', async () => {
    const run = await setup();
    await run.session.start();
    run.wallet.signError = { code: 4001 };
    await run.session.pay('MetaMask');
    run.wallet.signError = undefined;
    const record = await recordOf(run);
    const internals = run.session as unknown as SessionInternals & { listening: unknown };
    expect(internals.record?.orderId).toBe(record.orderId);
    expect(internals.listening).toBeDefined();
    // The browser's site data cleared meanwhile (another tab): no stored order is left.
    vi.spyOn(store, 'get').mockResolvedValue(undefined);
    vi.spyOn(store, 'forProduct').mockResolvedValue([]);
    run.fee.bps = 1;
    await run.session.pay('MetaMask');
    expect(run.wallet.signed).toEqual([]);
    expect(run.last()).toMatchObject({ kind: 'refused', message: FEE_HIDES_EIP3009 });
    expect(internals.record).toBeUndefined();
    expect(internals.listening).toBeUndefined();
    const views = run.views.length;
    run.advance(3600);
    await run.timers.tick();
    await settle();
    expect(run.views.length).toBe(views);
  });
});

describe('review round 10', () => {
  it('a payment found confirming counts down to no other wallet', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    expect(waiting(run).eip3009?.switchAt).toBeDefined();
    land(run.chain, {
      hash: markerOf(record).txHash ?? '',
      authorizer: run.wallet.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 995,
    });
    await run.timers.tick();
    expect(waiting(run).eip3009).toMatchObject({ confirming: true });
    expect(waiting(run).eip3009).not.toHaveProperty('switchAt');
  });

  it('names no transaction once the attempt is proven over, its own sent one included', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    expect(waiting(run)).toMatchObject({ eip3009: { send: { kind: 'sent' } } });
    pastSwitch(run, record);
    await run.timers.tick();
    expect(waiting(run)).toMatchObject({
      canRetry: true,
      eip3009: { send: { kind: 'unknown', linked: false, maybe: false } },
    });
    expect(waiting(run)).not.toHaveProperty('explorer');
    // Over: nothing is "taking long" any more (M19).
    expect(waiting(run)).not.toHaveProperty('unsureAt');
  });

  it('after a reload: names the stored hash while it may land, nothing once the attempt is proven over', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await recordOf(run);
    const session = await reload(run);
    await session.pay('MetaMask');
    await run.timers.tick();
    expect(waiting(run).explorer).toBeDefined();
    pastSwitch(run, record);
    await run.timers.tick();
    expect(waiting(run)).toMatchObject({
      canRetry: true,
      eip3009: { send: { kind: 'unknown', linked: false, maybe: false } },
    });
    expect(waiting(run)).not.toHaveProperty('explorer');
    // A page loaded once it is over ends the order at load: no wait is drawn for it at all.
    await reload(run);
    expect((await recordOf(run)).state).toBe('ended-unpaid');
    expect(run.views.at(-1)).not.toHaveProperty('explorer');
  });

  it('"send again" draws the send-only step, a first payment the signing one', async () => {
    const run = await setup();
    const steps: unknown[] = [];
    run.wallet.onSign = async () => {
      steps.push(run.last());
    };
    run.wallet.onSend = async () => {
      steps.push(run.last());
    };
    await signedNotSent(run);
    expect(steps[0]).toMatchObject({ kind: 'working', step: 'signing' });
    expect(steps[0]).not.toHaveProperty('sendOnly');
    steps.length = 0;
    const from = run.views.length;
    await run.session.resend();
    // The first line drawn, and the probe's redraw the send prompt is open under.
    expect(run.views[from]).toMatchObject({ kind: 'working', step: 'signing', sendOnly: true });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'working', step: 'signing', sendOnly: true });
  });
});

/** A status of `record` from the store, published to its inbox and heard by the widget. */
async function storeSays(
  run: Run,
  record: OrderRecord,
  status: 'pending' | 'confirmed',
): Promise<void> {
  const message = {
    type: 'status',
    buyerPubkey: record.buyerPubkey,
    orderId: record.orderId,
    status,
  } as OrderMessage;
  await run.relays.publish(
    INBOX,
    wrapOrderMessage(
      buildOrderMessage(message, NOW + 100),
      run.shop.store.secretKey,
      record.buyerPubkey,
    ).recipientWrap,
  );
  await settle();
}

describe('review round 11', () => {
  it('offers no "send again" while a payment of the order confirms, and sends nothing on a press', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const first = await recordOf(run);
    const hash = markerOf(first).txHash ?? '';
    run.wallet.sendError = { code: 4001 };
    await run.session.retry('MetaMask');
    run.wallet.sendError = undefined;
    expect(waiting(run)).toMatchObject({
      problem: { reason: 'send_declined' },
      eip3009: { resend: 'again' },
    });
    land(run.chain, {
      hash,
      authorizer: run.wallet.account,
      nonce: first.reference,
      payee: PAYEE,
      value: PRICE,
      block: 995,
    });
    await run.timers.tick();
    const wait = waiting(run);
    expect(wait.eip3009).toMatchObject({ confirming: true, retry: false });
    expect(wait.eip3009).not.toHaveProperty('resend');
    expect(wait).not.toHaveProperty('problem');
    const sends = run.wallet.sent.length;
    const views = run.views.length;
    await run.session.resend();
    expect(run.wallet.sent).toHaveLength(sends);
    expect(run.views.slice(views).some((view) => view.kind === 'working')).toBe(false);
  });

  it('a resend probe draws no countdown to another wallet once a payment confirms', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    const drawn: View[] = [];
    run.wallet.onSend = async () => {
      run.wallet.onSend = undefined;
      // Another tab's earlier send of the same order lands meanwhile.
      land(run.chain, {
        hash: `0x${'4'.repeat(64)}`,
        authorizer: run.wallet.account,
        nonce: record.reference,
        payee: PAYEE,
        value: PRICE,
        block: 995,
      });
      await run.timers.tick();
      await run.timers.tick();
      const last = run.last();
      if (last !== undefined) {
        drawn.push(last);
      }
    };
    expect(run.last()).toMatchObject({ eip3009: { switchAt: expect.any(Number) } });
    await run.session.resend();
    expect(drawn[0]).toMatchObject({ kind: 'working', sendOnly: true });
    expect(drawn[0]).not.toHaveProperty('startOverIn');
  });

  it('a newer attempt another tab made after this one was judged over is live again on this page', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const first = await recordOf(run);
    pastSwitch(run, first);
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(true);
    // Another tab of the same browser switches wallets and pays: attempt C, stored.
    const stored = await recordOf(run);
    const over = markerOf(stored);
    const written = await store.updateMarker(stored.orderId, stored.version, over.attemptId, {
      ...over,
      attemptId: 'tab-2-attempt',
      authorizer: run.other.account.toLowerCase(),
      validBefore: String(Number(over.validBefore) + 3600),
      switchProof: { blockHash: `0x${'b'.repeat(64)}`, timestamp: Number(over.validBefore) + 1 },
      txHash: `0x${'c'.repeat(64)}`,
    });
    if (!written.ok) {
      throw new Error(`the switch write was refused: ${written.reason}`);
    }
    const current = written.record;
    // A status of the order reaches this page: it adopts the stored record.
    await storeSays(run, current, 'confirmed');
    const wait = waiting(run);
    expect(wait.canRetry).toBe(false);
    expect(wait.eip3009?.retry).toBe(true);
    // And it is watched again: the payment of the new attempt is found.
    land(run.chain, {
      hash: markerOf(current).txHash ?? '',
      authorizer: run.other.account,
      nonce: current.reference,
      payee: PAYEE,
      value: PRICE,
      block: 980,
    });
    await run.timers.tick();
    await run.timers.tick();
    expect((await recordOf(run)).state).toBe('paid');
  });

  it('an order on screen after another one judged over starts from nothing judged (M10)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const first = await recordOf(run);
    pastSwitch(run, first);
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(true);
    // Another tab (its load ends that order) pays a new one, the chain's clock caught up.
    run.chain.latest = { number: 1300, timestamp: run.now() };
    const other = new CheckoutSession(run.offer, { ...run.deps, onView: () => undefined });
    await other.start();
    await settle();
    await other.pay('MetaMask');
    other.dispose();
    const records = await store.forProduct(run.offer.productAddress);
    const second = records.find((each) => each.orderId !== first.orderId);
    if (second === undefined) {
      throw new Error('no second order');
    }
    const internals = run.session as unknown as SessionInternals & { render(): void };
    internals.setRecord(second);
    internals.render();
    const wait = waiting(run);
    expect(wait.canRetry).toBe(false);
    // Its own attempt: the same wallet may pay again, and no hash is named before its
    // signer is read (nothing of the order judged over carries over).
    expect(wait.eip3009).toMatchObject({
      retry: true,
      send: { kind: 'unknown', linked: false, maybe: false },
    });
    expect(markerOf(second).txHash).toBeDefined();
    expect(wait).not.toHaveProperty('explorer');
  });

  it('presses nothing on "send again" once the attempt was proven over', async () => {
    const run = await setup();
    const record = await signedNotSent(run);
    pastSwitch(run, record);
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(true);
    const views = run.views.length;
    await run.session.resend();
    expect(run.views.slice(views).some((view) => view.kind === 'working')).toBe(false);
    expect(run.wallet.sent).toHaveLength(0);
  });

  it('a wallet answering after a probe judged its attempt over, while another tab made a newer one: that one is live', async () => {
    const run = await setup();
    await run.session.start();
    run.wallet.onSend = async () => {
      run.wallet.onSend = undefined;
      const stored = await recordOf(run);
      // The prompt stays open past the end proof: the probe judges the attempt over.
      pastSwitch(run, stored);
      await run.timers.tick();
      await run.timers.tick();
      // Meanwhile another tab switched wallets: a newer attempt, stored.
      const current = await recordOf(run);
      const marker = markerOf(current);
      const written = await store.updateMarker(current.orderId, current.version, marker.attemptId, {
        ...marker,
        attemptId: 'tab-2-attempt',
        authorizer: run.other.account.toLowerCase(),
        validBefore: String(Number(marker.validBefore) + 3600),
        switchProof: {
          blockHash: `0x${'b'.repeat(64)}`,
          timestamp: Number(marker.validBefore) + 1,
        },
      });
      if (!written.ok) {
        throw new Error(`the switch write was refused: ${written.reason}`);
      }
    };
    await run.session.pay('MetaMask');
    await settle();
    const current = await recordOf(run);
    expect(markerOf(current).attemptId).toBe('tab-2-attempt');
    const wait = waiting(run);
    expect(wait.canRetry).toBe(false);
    // And watched: the newer attempt's payment is credited.
    expect((run.session as unknown as { watchTimer: unknown }).watchTimer).toBeDefined();
    land(run.chain, {
      hash: `0x${'d'.repeat(64)}`,
      authorizer: run.other.account,
      nonce: current.reference,
      payee: PAYEE,
      value: PRICE,
      block: 980,
    });
    await run.timers.tick();
    await run.timers.tick();
    expect((await recordOf(run)).state).toBe('paid');
  });
});

/** The pinned (finalized) `eth_call` of every end proof fails. */
function proofUnreadable(run: Run): void {
  run.chain.failIf = (method, params) =>
    method === 'eth_call' &&
    typeof params[1] === 'object' &&
    params[1] !== null &&
    'blockHash' in params[1];
}

/** Another tab's newer attempt of `record`'s order, by another wallet, stored. */
async function otherTabSwitches(run: Run): Promise<OrderRecord> {
  const stored = await recordOf(run);
  const marker = markerOf(stored);
  const written = await store.updateMarker(stored.orderId, stored.version, marker.attemptId, {
    ...marker,
    attemptId: `tab-2-${marker.attemptId}`,
    authorizer: run.other.account.toLowerCase(),
    validBefore: String(Math.max(Number(marker.validBefore), run.now()) + 3600),
    switchProof: { blockHash: `0x${'b'.repeat(64)}`, timestamp: Number(marker.validBefore) + 1 },
  });
  if (!written.ok) {
    throw new Error(`the switch write was refused: ${written.reason}`);
  }
  return written.record;
}

describe('review round 12: over is one-way, and one adopt watches what may land', () => {
  it.each([false, true])(
    'an attempt proven over never comes back live through a failed proof read (after a refused switch: %s)',
    async (refusedSwitch) => {
      const run = await setup();
      const record = await signedNotSent(run);
      pastSwitch(run, record);
      await run.timers.tick();
      expect(waiting(run).canRetry).toBe(true);
      if (refusedSwitch) {
        run.chain.blacklisted.add(run.other.account);
        await run.session.retry('Rabby');
        expect(waiting(run)).toMatchObject({
          canRetry: true,
          problem: { reason: 'token_blocked' },
        });
      }
      proofUnreadable(run);
      for (let pass = 0; pass < 3; pass += 1) {
        await run.timers.tick();
        expect(waiting(run)).toMatchObject({ canRetry: true, eip3009: { retry: false } });
      }
      expect(waiting(run).wallets.map((wallet) => wallet.name)).toContain('Rabby');
    },
  );

  it('a newer attempt met by a watch pass (another tab replaced it) is watched to its payment', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const current = await otherTabSwitches(run);
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(false);
    expect((run.session as unknown as { watchTimer: unknown }).watchTimer).toBeDefined();
    land(run.chain, {
      hash: `0x${'e'.repeat(64)}`,
      authorizer: run.other.account,
      nonce: current.reference,
      payee: PAYEE,
      value: PRICE,
      block: 980,
    });
    await run.timers.tick();
    await run.timers.tick();
    expect((await recordOf(run)).state).toBe('paid');
  });

  it("a newer attempt heard through the store's status, after this one was judged over, is watched", async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    pastSwitch(run, await recordOf(run));
    await run.timers.tick();
    expect(waiting(run).canRetry).toBe(true);
    expect((run.session as unknown as { watchTimer: unknown }).watchTimer).toBeUndefined();
    // A status of the same attempt, proven over: nothing is watched, nothing read again.
    const reads = run.chain.calls.length;
    await storeSays(run, await recordOf(run), 'confirmed');
    expect(run.chain.calls.length).toBe(reads);
    expect(waiting(run).canRetry).toBe(true);
    expect((run.session as unknown as { watchTimer: unknown }).watchTimer).toBeUndefined();
    const current = await otherTabSwitches(run);
    await storeSays(run, current, 'confirmed');
    expect(waiting(run).canRetry).toBe(false);
    expect((run.session as unknown as { watchTimer: unknown }).watchTimer).toBeDefined();
  });

  it("never names the switched-back wallet's pre-switch hash after a reload while no end proof can be read (M59)", async () => {
    const { run, hashOfA } = await switched(false);
    const toB = await recordOf(run);
    pastSwitch(run, toB);
    await run.timers.tick();
    run.wallet.sendError = { code: 4001 };
    await run.session.retry('MetaMask');
    run.wallet.sendError = undefined;
    expect(markerOf(await recordOf(run)).txHash).toBe(hashOfA);
    proofUnreadable(run);
    const session = await reload(run);
    await session.pay('MetaMask');
    await run.timers.tick();
    await run.timers.tick();
    // The signer read answered (A, the current wallet); only the switch's proof hides it.
    expect(run.chain.calls.some((call) => call.method === 'eth_getTransactionByHash')).toBe(true);
    expect(waiting(run)).not.toHaveProperty('explorer');
  });

  it('starts no watch under an open press when a status is heard: the press draws its own end', async () => {
    const run = await setup();
    await run.session.start();
    let watchedUnderPress: unknown = 'unset';
    run.wallet.onSend = async () => {
      run.wallet.onSend = undefined;
      await storeSays(run, await recordOf(run), 'confirmed');
      watchedUnderPress = (run.session as unknown as { watchTimer: unknown }).watchTimer;
    };
    await run.session.pay('MetaMask');
    expect(watchedUnderPress).toBeUndefined();
    expect((run.session as unknown as { watchTimer: unknown }).watchTimer).toBeDefined();
  });
});

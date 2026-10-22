/**
 * Paying an order with USDC over EIP-3009 against a fake chain and a wallet
 * that signs with a real key: the payment order, the store's part, the retry,
 * the switch and the end proof.
 */
import { readFileSync } from 'node:fs';
import {
  CHAINS,
  type ChainConfig,
  FeeConfigError,
  USDC_BASE_DEVNET,
  assetsFor,
} from '@elisym/pay-core';
import { hexToBytes } from '@noble/hashes/utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EIP3009_PAY_CUTOFF_SECS,
  EIP3009_VALID_SECS,
  MERCHANT_CATCH_UP_SECS,
  PAY_CUTOFF_SECS,
  SEND_MARGIN_SECS,
} from '../../src/buyer/constants';
import {
  type Eip3009PayDeps,
  type Eip3009PayRefusal,
  type Eip3009PayResult,
  type Eip3009Wallet,
  eip3009EndProof,
  endEip3009Order,
  payWithEip3009,
  readEip3009ChainTime,
  resendWithEip3009,
  retryWithEip3009,
  storedEip3009Request,
  switchWalletWithEip3009,
  watchEip3009Payment,
} from '../../src/buyer/eip3009-pay';
import { type LoadedOffer, loadOffer } from '../../src/buyer/offer';
import { placeOrder } from '../../src/buyer/order-flow';
import type { OrderRecord, PaymentMarker } from '../../src/buyer/order-record';
import { MemoryOrderBackend, OrderStore } from '../../src/buyer/order-store';
import { endOrder } from '../../src/buyer/purchase';
import {
  type FakeChain,
  type WalletState,
  addressOf,
  blockHashOf,
  cancel,
  fakeChain,
  fakeWallet,
  land,
  selectorOf,
  tagOf,
  usedKey,
} from './eip3009-chain';
import { MemoryRelays, NO_FEE_TERMS, NOW, inboxList, makeShop } from './fixtures';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';
const PAYEE = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const PRICE = 49_000_000n;
const SECRET = hexToBytes('11'.repeat(32));
const OTHER_SECRET = hexToBytes('22'.repeat(32));
const DELEGATOR = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
const BASE_SEPOLIA = CHAINS.BASE_DEVNET;
const SEPOLIA = CHAINS.ETHEREUM_DEVNET;

type Ready = Extract<LoadedOffer, { ok: true }>;
type Eip3009Marker = Extract<PaymentMarker, { rail: 'eip3009' }>;

let store: OrderStore;

beforeEach(() => {
  store = new OrderStore(new MemoryOrderBackend());
});

// The fake chain answers on microtasks only, so without this the worker never
// reaches its event loop for the whole file and a slow CI runner times out
// vitest's own RPC to the main process.
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

interface World {
  record: OrderRecord;
  fresh: Ready;
  relays: MemoryRelays;
  chain: FakeChain;
  wallet: Eip3009Wallet;
  walletState: WalletState;
  deps: Eip3009PayDeps;
}

/** The same payouts, each one subunit dearer. */
function repriced(fresh: Ready): Ready {
  return {
    ...fresh,
    payouts: fresh.payouts.map((payout) => ({ ...payout, amount: payout.amount + 1n })),
  };
}

function caip19Of(chain: ChainConfig): string {
  const [coin] = assetsFor(chain.slug, chain.network);
  return `${chain.caip2}/erc20:${coin?.mint ?? ''}`;
}

async function world(
  options: { chain?: ChainConfig; memoMarker?: boolean; secret?: Uint8Array } = {},
): Promise<World> {
  const chainConfig = options.chain ?? BASE_SEPOLIA;
  const shop = makeShop({
    caip19: caip19Of(chainConfig),
    payout: PAYEE,
    ...(options.memoMarker === undefined ? {} : { memoMarker: options.memoMarker }),
  });
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const fresh = await loadOffer(shop.naddr, {
    client: relays,
    pageOrigin: PAGE,
    families: ['evm'],
    now: NOW,
  });
  if (!fresh.ok) {
    throw new Error(fresh.message);
  }
  const payout = fresh.payouts[0];
  if (payout === undefined) {
    throw new Error('no payout');
  }
  const placed = await placeOrder(
    { offer: fresh, payout, chainTime: NOW, deviceTime: NOW },
    { store, readClient: relays, clientFor: () => relays },
  );
  if (!placed.ok) {
    throw new Error(placed.reason);
  }
  const [asset] = assetsFor(chainConfig.slug, chainConfig.network);
  if (asset === undefined) {
    throw new Error('no asset');
  }
  const chain = fakeChain(chainConfig, asset, NOW);
  const { state: walletState, wallet } = fakeWallet(
    options.secret ?? SECRET,
    chainConfig.evmChainId ?? 0,
  );
  chain.tokens.set(walletState.account, PRICE * 2n);
  chain.native.set(walletState.account, 10n ** 18n);
  const deps: Eip3009PayDeps = {
    store,
    readClient: relays,
    clientFor: () => relays,
    client: chain.client,
    now: () => NOW + 30,
    feeTerms: NO_FEE_TERMS,
  };
  return { record: placed.record, fresh, relays, chain, wallet, walletState, deps };
}

async function stored(run: World): Promise<OrderRecord> {
  const record = await store.get(run.record.orderId);
  if (record === undefined) {
    throw new Error('missing');
  }
  return record;
}

function markerOf(record: OrderRecord | undefined): Eip3009Marker {
  const marker = record?.marker;
  if (marker?.rail !== 'eip3009') {
    throw new Error('no eip3009 marker');
  }
  return marker;
}

function failed(result: Eip3009PayResult): Extract<Eip3009PayResult, { ok: false }> {
  if (result.ok) {
    throw new Error('paid');
  }
  return result;
}

/** A first attempt whose send prompt was declined: `paying`, signed, no hash. */
async function signedNotSent(run: World): Promise<OrderRecord> {
  run.walletState.sendError = { code: 4001 };
  const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
  expect(result.reason).toBe('send_declined');
  run.walletState.sendError = undefined;
  return await stored(run);
}

/** A first attempt that was sent: `paying`, signed, with its hash and receipt. */
async function sent(run: World): Promise<{ record: OrderRecord; hash: string }> {
  const result = await payWithEip3009(run.record, run.wallet, run.fresh, run.deps);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return { record: await stored(run), hash: result.hash };
}

describe('payWithEip3009', () => {
  it('connects, checks, writes the request and the marker, signs, stores the signature, checks gas, then sends', async () => {
    const run = await world();
    const order: string[] = [];
    run.walletState.onSign = async () => {
      order.push('sign');
      expect((await stored(run)).marker).toMatchObject({ rail: 'eip3009' });
    };
    run.walletState.onSend = async () => {
      order.push('send');
      // The signature and `signed` are stored BEFORE the send.
      const marker = markerOf(await stored(run));
      expect(marker.signed).toBe(true);
      expect(marker.signature).toMatch(/^0x[0-9a-f]{130}$/);
      // 5.1 ran after the signature was stored and before the send.
      const methods = run.chain.calls.map((call) => call.method);
      expect(methods.lastIndexOf('eth_estimateGas')).toBeGreaterThan(-1);
    };
    const result = await payWithEip3009(run.record, run.wallet, run.fresh, run.deps);
    expect(result).toMatchObject({ ok: true });
    expect(order).toEqual(['sign', 'send']);
    const record = await stored(run);
    const marker = markerOf(record);
    expect(record.state).toBe('paying');
    expect(marker).toMatchObject({
      authorizer: run.walletState.account,
      floorBlock: '950',
      validBefore: String(NOW + 30 + EIP3009_VALID_SECS),
      signed: true,
    });
    expect(marker.txHash).toBe(result.ok ? result.hash : '');
    // The typed data carries exactly the marker's validBefore and the order's nonce.
    expect(run.walletState.signed[0]?.message).toMatchObject({
      from: run.walletState.account,
      to: PAYEE,
      value: PRICE.toString(),
      validAfter: '0',
      validBefore: marker.validBefore,
      nonce: record.reference,
    });
    expect(run.walletState.sent[0]).toMatchObject({
      from: run.walletState.account,
      to: USDC_BASE_DEVNET.mint,
      chainId: '0x14a34',
    });
    expect(run.walletState.sent[0]?.data.slice(0, 10)).toBe('0xcf092995');
    expect(storedEip3009Request(record)).toEqual({
      rail: 'eip3009',
      caip2: 'eip155:84532',
      caip19: record.payout.caip19,
      payee: PAYEE,
      amount: PRICE.toString(),
      nonce: record.reference,
    });
    // The receipt names the hash and is noted on the marker.
    expect(record.receiptWrap).toBeDefined();
    expect(marker.receiptTx).toBe(marker.txHash);
  });

  it('estimates the signed call with no fee fields, the L1 fee only with an l1FeeOracle', async () => {
    for (const chainConfig of [BASE_SEPOLIA, SEPOLIA]) {
      const run = await world({ chain: chainConfig });
      await sent(run);
      const estimate = run.chain.calls.find((call) => call.method === 'eth_estimateGas');
      const params = estimate?.params[0] as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual(['data', 'from', 'to']);
      expect(params.from).toBe(run.walletState.account);
      expect(params.from).not.toBe(PAYEE);
      const l1Reads = run.chain.calls.filter(
        (call) =>
          call.method === 'eth_call' &&
          String((call.params[0] as { data: string }).data).startsWith('0x49948e0e'),
      );
      expect(l1Reads.length).toBe(chainConfig.l1FeeOracle === undefined ? 0 : 1);
    }
  });

  it('counts the L1 fee x 1.5 in the native coin needed on Base', async () => {
    const run = await world();
    // gas x cap x 1.5, cap = 2 x base + priority; plus L1 x 1.5.
    const gas = 100_000n * (2n * 1_000_000_000n + 100_000_000n);
    const needed =
      (gas * 15_000n + 9_999n) / 10_000n + (1_000_000_000_000n * 15_000n + 9_999n) / 10_000n;
    run.chain.native.set(run.walletState.account, needed - 1n);
    const short = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(short).toMatchObject({
      reason: 'insufficient_native',
      needed,
      available: needed - 1n,
      afterMarker: true,
    });
  });

  describe('step 1', () => {
    it.each([
      [{ code: 4001 }, 'rejected'],
      [{ code: -32002 }, 'busy'],
      [new Error('no provider'), 'failed'],
    ] as const)(
      'reports a connect answering %o raw (%s), with nothing composed',
      async (error, kind) => {
        const run = await world();
        run.walletState.requestError = error;
        const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
        expect(result).toMatchObject({ reason: 'connect_failed', walletError: kind });
        expect(result.afterMarker).toBeUndefined();
        const record = await stored(run);
        expect(record.state).toBe('ordered');
        expect(record.paymentRequest).toBeUndefined();
        expect(run.chain.calls).toEqual([]);
      },
    );

    it('reports a declined switch on a first attempt raw, not as wrong_chain', async () => {
      const run = await world();
      run.walletState.switchError = { code: 4001 };
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason: 'connect_failed',
        walletError: 'rejected',
      });
    });

    it.each([[{ code: 4901 }], [new Error('unsupported chain')]])(
      'gives wrong_chain for a switch failing with %o',
      async (error) => {
        const run = await world();
        run.walletState.switchError = error;
        expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
          ok: false,
          reason: 'wrong_chain',
        });
        expect(run.chain.calls).toEqual([]);
      },
    );

    it('gives wrong_chain when the switch answers ok and the wallet stays on another chain', async () => {
      const run = await world();
      run.walletState.chainId = 11_155_111;
      run.walletState.switchStays = true;
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason: 'wrong_chain',
      });
      expect((await stored(run)).paymentRequest).toBeUndefined();
      expect(run.chain.calls).toEqual([]);
    });
  });

  describe('step 2, before the marker', () => {
    async function refusedBeforeMarker(
      run: World,
      reason: string,
      extra: Record<string, unknown> = {},
    ): Promise<void> {
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason,
        ...extra,
      });
      const record = await stored(run);
      expect(record.state).toBe('ordered');
      expect(record.marker).toBeUndefined();
      expect(run.walletState.signed).toEqual([]);
    }

    it('refuses a blacklisted payer or payee, a paused coin and a domain mismatch', async () => {
      const cases: ((run: World) => void)[] = [
        (run) => run.chain.blacklisted.add(run.walletState.account),
        (run) => run.chain.blacklisted.add(PAYEE),
        (run) => {
          run.chain.paused = true;
        },
      ];
      for (const setUp of cases) {
        const run = await world();
        setUp(run);
        await refusedBeforeMarker(run, 'token_blocked');
      }
      const run = await world();
      run.chain.domain = `0x${'12'.repeat(32)}`;
      await refusedBeforeMarker(run, 'unpayable');
    });

    it('refuses a mismatched implementation slot as unpayable', async () => {
      const run = await world();
      run.chain.implementation = `0x${'99'.repeat(20)}`;
      await refusedBeforeMarker(run, 'unpayable');
    });

    it('passes a payer with no code or a 7702 delegation to a known delegate, refuses any other', async () => {
      const passes = await world();
      passes.chain.code.set(passes.walletState.account, `0xef0100${DELEGATOR.slice(2)}`);
      expect(
        await payWithEip3009(passes.record, passes.wallet, passes.fresh, passes.deps),
      ).toMatchObject({
        ok: true,
      });
      for (const code of [`0xef0100${'44'.repeat(20)}`, '0x6080604052']) {
        const run = await world();
        run.chain.code.set(run.walletState.account, code);
        await refusedBeforeMarker(run, 'payer_unsupported');
      }
    });

    it('refuses short USDC with the amounts, and no native coin with none', async () => {
      const run = await world();
      run.chain.tokens.set(run.walletState.account, PRICE - 1n);
      await refusedBeforeMarker(run, 'insufficient_token', {
        needed: PRICE,
        available: PRICE - 1n,
      });
      const dry = await world();
      dry.chain.native.set(dry.walletState.account, 0n);
      const result = failed(await payWithEip3009(dry.record, dry.wallet, dry.fresh, dry.deps));
      expect(result.reason).toBe('no_native');
      expect(result.needed).toBeUndefined();
    });

    it('refuses a widget RPC on another chain, a fee above 0, a stale offer and a self payment', async () => {
      const wrong = await world();
      wrong.chain.chainId = 1;
      await refusedBeforeMarker(wrong, 'wrong_chain');
      const fee = await world();
      fee.deps.feeTerms = async () => ({ feeBps: 50, treasury: 'Treasury' });
      await refusedBeforeMarker(fee, 'fee_not_zero');
      const stale = await world();
      stale.deps.now = () => NOW + 600;
      await refusedBeforeMarker(stale, 'stale_offer');
      const self = await world();
      self.walletState.account = PAYEE;
      self.chain.tokens.set(PAYEE, PRICE * 2n);
      await refusedBeforeMarker(self, 'self_payment');
    });

    it('refuses too_late at EIP3009_PAY_CUTOFF_SECS (6 h) before the catch-up end, on chain time', async () => {
      expect(EIP3009_PAY_CUTOFF_SECS).toBe(6 * 60 * 60);
      // Solana and Tempo keep their 1 h.
      expect(PAY_CUTOFF_SECS).toBe(60 * 60);
      const edge = NOW + MERCHANT_CATCH_UP_SECS - EIP3009_PAY_CUTOFF_SECS;
      const run = await world();
      run.chain.latest.timestamp = edge + 1;
      await refusedBeforeMarker(run, 'too_late');
      const atEdge = await world();
      atEdge.chain.latest.timestamp = edge;
      expect(
        await payWithEip3009(atEdge.record, atEdge.wallet, atEdge.fresh, atEdge.deps),
      ).toMatchObject({
        ok: true,
      });
    });
  });

  describe('a first attempt whose nonce reads used', () => {
    const setUps: [string, (run: World) => void][] = [
      ['nothing else', () => undefined],
      ['insufficient USDC', (run) => run.chain.tokens.set(run.walletState.account, 0n)],
      [
        'a stale offer',
        (run) => {
          run.deps.now = () => NOW + 600;
        },
      ],
      [
        'too_late',
        (run) => {
          run.chain.latest.timestamp = NOW + MERCHANT_CATCH_UP_SECS;
        },
      ],
      ['no native coin', (run) => run.chain.native.set(run.walletState.account, 0n)],
      ['a blacklisted payer', (run) => run.chain.blacklisted.add(run.walletState.account)],
      [
        'another product address',
        (run) => {
          run.fresh = { ...run.fresh, productAddress: `${run.fresh.productAddress}-moved` };
        },
      ],
      [
        'the same payout at another price',
        (run) => {
          run.fresh = repriced(run.fresh);
        },
      ],
      [
        'the payout gone',
        (run) => {
          run.fresh = { ...run.fresh, payouts: [] };
        },
      ],
    ];

    it.each(setUps)('freezes the order as nonce_used, whatever else: %s', async (_label, setUp) => {
      const run = await world();
      run.chain.used.add(usedKey(run.walletState.account, run.record.reference));
      setUp(run);
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason: 'nonce_used',
      });
      const record = await stored(run);
      expect(record.state).toBe('paying');
      expect(storedEip3009Request(record)).toBeDefined();
      expect(markerOf(record)).toMatchObject({
        usedAtStart: true,
        signed: true,
        validBefore: '0',
        authorizer: run.walletState.account,
        floorBlock: '950',
      });
      expect(run.walletState.signed).toEqual([]);
    });

    it('retries the frozen marker write on a conflict', async () => {
      const run = await world();
      run.chain.used.add(usedKey(run.walletState.account, run.record.reference));
      // Another tab bumps the version once, right after the request is read.
      let bumped = false;
      const real = run.deps.store;
      const original = real.setMarker.bind(real);
      real.setMarker = async (...args) => {
        if (!bumped) {
          bumped = true;
          const current = await real.get(run.record.orderId);
          await real.update(run.record.orderId, current?.version ?? 0, {
            acknowledgedRelays: [...(current?.acknowledgedRelays ?? []), 'wss://more.example.com'],
          });
        }
        return original(...args);
      };
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        reason: 'nonce_used',
      });
      expect(markerOf(await stored(run)).usedAtStart).toBe(true);
    });

    it('still says nonce_used, with no marker, when another order holds the product', async () => {
      const run = await world();
      run.chain.used.add(usedKey(run.walletState.account, run.record.reference));
      const original = run.deps.store.setMarker.bind(run.deps.store);
      run.deps.store.setMarker = async () => ({ ok: false, reason: 'exclusion', holder: 'other' });
      const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
      run.deps.store.setMarker = original;
      expect(result).toMatchObject({ reason: 'nonce_used', holder: 'other' });
      expect((await stored(run)).marker).toBeUndefined();
    });

    it('is followed and never ended, with no RPC read', async () => {
      const run = await world();
      run.chain.used.add(usedKey(run.walletState.account, run.record.reference));
      await payWithEip3009(run.record, run.wallet, run.fresh, run.deps);
      const record = await stored(run);
      const calls = run.chain.calls.length;
      expect(await endEip3009Order(record, run.deps)).toEqual({
        ended: false,
        record,
        proof: 'never',
      });
      expect(await watchEip3009Payment(record, run.deps)).toEqual({ state: 'waiting', record });
      expect(run.chain.calls.length).toBe(calls);
      expect(await retryWithEip3009(record, run.wallet, run.fresh, run.deps)).toMatchObject({
        reason: 'nonce_used',
      });
      expect(await switchWalletWithEip3009(record, run.wallet, run.fresh, run.deps)).toMatchObject({
        reason: 'nonce_used',
      });
    });
  });

  describe('the typed-data prompt', () => {
    it.each([
      [{ code: 4001 }, 'rejected'],
      [new Error('wallet crashed'), 'sign_failed'],
    ] as const)('clears a never-signed marker to ordered on %o (%s)', async (error, reason) => {
      const run = await world();
      run.walletState.signError = error;
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason,
        record: { state: 'ordered' },
      });
      expect((await stored(run)).marker).toBeUndefined();
    });

    it('clears it on a signature that does not recover to the payer (sign_failed)', async () => {
      const run = await world();
      run.walletState.signWithOther = OTHER_SECRET;
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason: 'sign_failed',
        record: { state: 'ordered' },
      });
      expect(run.walletState.sent).toEqual([]);
    });

    it('stores the signature and sends after a record version bump during the prompt', async () => {
      const run = await world();
      run.walletState.onSign = async () => {
        const current = await stored(run);
        await store.update(current.orderId, current.version, {
          acknowledgedRelays: [...current.acknowledgedRelays, 'wss://more.example.com'],
        });
      };
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        ok: true,
      });
      expect(markerOf(await stored(run)).signed).toBe(true);
    });

    it('neither writes nor sends a signature approved after another tab cleared the marker', async () => {
      const run = await world();
      run.walletState.onSign = async () => {
        const current = await stored(run);
        await store.clearMarker(
          current.orderId,
          current.version,
          markerOf(current).attemptId,
          'ordered',
        );
      };
      const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
      // Nothing signed is stored: the record (cleared to ordered) holds no live attempt.
      expect(result.reason).toBe('conflict');
      expect(result.afterMarker).toBeUndefined();
      expect(result.attemptId).toBeUndefined();
      expect(result.record?.state).toBe('ordered');
      expect(run.walletState.sent).toEqual([]);
      expect((await stored(run)).marker).toBeUndefined();
    });
  });

  describe('step 5.1, the gas warning', () => {
    it('leaves the marker signed with no hash, and "send anyway" reaches step 6 with its checks', async () => {
      const run = await world();
      run.chain.native.set(run.walletState.account, 1n);
      const short = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
      expect(short).toMatchObject({ reason: 'insufficient_native', afterMarker: true });
      const record = await stored(run);
      expect(record.state).toBe('paying');
      expect(markerOf(record).signed).toBe(true);
      expect(markerOf(record).txHash).toBeUndefined();
      expect(run.walletState.sent).toEqual([]);
      const resend = short.resend;
      if (resend === undefined) {
        throw new Error('no resend');
      }
      // The margin still holds a too-late send back.
      run.chain.latest.timestamp = Number(markerOf(record).validBefore) - SEND_MARGIN_SECS + 1;
      expect(await resendWithEip3009(resend, run.wallet, run.deps)).toMatchObject({
        reason: 'resign_needed',
      });
      run.chain.latest.timestamp = NOW + 30;
      // The chain re-read still holds a wallet that stays elsewhere back.
      run.walletState.chainId = 1;
      run.walletState.switchStays = true;
      expect(await resendWithEip3009(resend, run.wallet, run.deps)).toMatchObject({
        reason: 'wrong_chain_after_sign',
      });
      expect(run.walletState.sent).toEqual([]);
      run.walletState.switchStays = false;
      const paid = await resendWithEip3009(resend, run.wallet, run.deps);
      expect(paid).toMatchObject({ ok: true });
      expect(run.walletState.sent.length).toBe(1);
      // The estimate is not asked again ("send anyway").
      expect(run.chain.calls.filter((call) => call.method === 'eth_estimateGas').length).toBe(1);
    });

    it('watches when the estimate fails and the nonce reads used, gives send_failed when unused', async () => {
      const run = await world();
      run.chain.estimate = () => {
        throw Object.assign(new Error('execution reverted'), { code: 3 });
      };
      run.walletState.onSign = async () => {
        run.chain.used.add(usedKey(run.walletState.account, run.record.reference));
      };
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        reason: 'still_waiting',
        afterMarker: true,
      });
      const unused = await world();
      unused.chain.estimate = run.chain.estimate;
      expect(
        await payWithEip3009(unused.record, unused.wallet, unused.fresh, unused.deps),
      ).toMatchObject({ reason: 'send_failed', afterMarker: true, record: { state: 'paying' } });
      expect(markerOf(await stored(unused)).txHash).toBeUndefined();
      expect(unused.walletState.sent).toEqual([]);
    });

    it('gives rpc_error on a transport failure of the estimate or the L1 fee', async () => {
      const run = await world();
      run.chain.down.add('eth_estimateGas');
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        reason: 'rpc_error',
        afterMarker: true,
      });
      expect(run.walletState.sent).toEqual([]);
    });
  });

  describe('step 6, the send', () => {
    it('re-reads the wallet chain: a wrong one sends nothing; a switch-back that stays wrong sends nothing', async () => {
      const run = await world();
      run.walletState.onSign = async () => {
        run.walletState.chainId = 11_155_111;
      };
      const wrong = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
      expect(wrong).toMatchObject({ reason: 'wrong_chain_after_sign', afterMarker: true });
      expect(run.walletState.sent).toEqual([]);
      const record = await stored(run);
      expect(record.state).toBe('paying');
      expect(markerOf(record).signed).toBe(true);
      run.walletState.switchStays = true;
      const resend = wrong.resend;
      if (resend === undefined) {
        throw new Error('no resend');
      }
      expect(await resendWithEip3009(resend, run.wallet, run.deps)).toMatchObject({
        reason: 'wrong_chain_after_sign',
      });
      expect(run.walletState.sent).toEqual([]);
      run.walletState.switchStays = false;
      expect(await resendWithEip3009(resend, run.wallet, run.deps)).toMatchObject({ ok: true });
    });

    it('asks to sign again, sending nothing, inside SEND_MARGIN_SECS of validBefore', async () => {
      const run = await world();
      run.walletState.onSign = async () => {
        run.chain.latest.timestamp = NOW + 30 + EIP3009_VALID_SECS - SEND_MARGIN_SECS + 1;
      };
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        reason: 'resign_needed',
        afterMarker: true,
      });
      expect(run.walletState.sent).toEqual([]);
    });

    it('keeps the attempt on a declined send or no hash, the marker signed and its hash unchanged', async () => {
      const run = await world();
      const declined = await signedNotSent(run);
      expect(markerOf(declined).signed).toBe(true);
      expect(markerOf(declined).txHash).toBeUndefined();
      const empty = await world();
      empty.walletState.nextHash = () => 'not a hash';
      expect(
        await payWithEip3009(empty.record, empty.wallet, empty.fresh, empty.deps),
      ).toMatchObject({ reason: 'wallet_failed', afterMarker: true });
      expect(markerOf(await stored(empty)).txHash).toBeUndefined();
    });

    it('stores the hash and sends the receipt after a record version bump during the send prompt', async () => {
      const run = await world();
      run.walletState.onSend = async () => {
        const current = await stored(run);
        await store.update(current.orderId, current.version, {
          acknowledgedRelays: [...current.acknowledgedRelays, 'wss://more.example.com'],
        });
      };
      const result = await payWithEip3009(run.record, run.wallet, run.fresh, run.deps);
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && result.hashUnsaved).toBeFalsy();
      const record = await stored(run);
      expect(markerOf(record).txHash).toBe(result.ok ? result.hash : '');
      expect(record.receiptWrap).toBeDefined();
    });
  });
});

describe('retryWithEip3009', () => {
  it('pays in place with a new validBefore = max(latest + 900, stored), signed as written', async () => {
    const run = await world();
    const before = await signedNotSent(run);
    const old = markerOf(before);
    // A lagging backend: latest is older than the stored window.
    run.chain.latest.timestamp = NOW;
    const retried = await retryWithEip3009(before, run.wallet, run.fresh, run.deps);
    expect(retried).toMatchObject({ ok: true });
    const marker = markerOf(await stored(run));
    expect(marker.attemptId).not.toBe(old.attemptId);
    expect(marker.validBefore).toBe(old.validBefore);
    expect(run.walletState.signed[1]?.message.validBefore).toBe(old.validBefore);
    expect(marker.floorBlock).toBe(old.floorBlock);
    // A fresh latest raises it.
    const later = await world();
    const record = await signedNotSent(later);
    later.chain.latest.timestamp = NOW + 500;
    await retryWithEip3009(record, later.wallet, later.fresh, later.deps);
    expect(markerOf(await stored(later)).validBefore).toBe(String(NOW + 500 + EIP3009_VALID_SECS));
    expect(later.walletState.signed[1]?.message.validBefore).toBe(
      String(NOW + 500 + EIP3009_VALID_SECS),
    );
  });

  it('sends a new receipt for the retry hash', async () => {
    const run = await world();
    const first = await sent(run);
    const firstWrap = first.record.receiptWrap;
    const retried = await retryWithEip3009(first.record, run.wallet, run.fresh, run.deps);
    if (!retried.ok) {
      throw new Error(retried.reason);
    }
    const record = await stored(run);
    expect(retried.hash).not.toBe(first.hash);
    expect(markerOf(record)).toMatchObject({ txHash: retried.hash, receiptTx: retried.hash });
    expect(record.receiptWrap).not.toEqual(firstWrap);
  });

  it('keeps the previous hash when the retry is refused after signing', async () => {
    const run = await world();
    const first = await sent(run);
    run.chain.native.set(run.walletState.account, 1n);
    const result = failed(await retryWithEip3009(first.record, run.wallet, run.fresh, run.deps));
    expect(result).toMatchObject({ reason: 'insufficient_native', afterMarker: true });
    expect(markerOf(await stored(run)).txHash).toBe(first.hash);
  });

  it('re-runs step 2: a changed offer on a signed marker returns afterMarker, the order still paying', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    const changed: Ready = { ...run.fresh, payouts: [] };
    expect(await retryWithEip3009(record, run.wallet, changed, run.deps)).toMatchObject({
      ok: false,
      reason: 'offer_changed',
      afterMarker: true,
    });
    expect((await stored(run)).state).toBe('paying');
  });

  it('refuses too_late at the 6 h cutoff on a retry too', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    run.chain.latest.timestamp = NOW + MERCHANT_CATCH_UP_SECS - EIP3009_PAY_CUTOFF_SECS + 1;
    expect(await retryWithEip3009(record, run.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'too_late',
      afterMarker: true,
    });
  });

  it('is still_waiting when the nonce reads used, with afterMarker', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    run.chain.used.add(usedKey(run.walletState.account, record.reference));
    expect(await retryWithEip3009(record, run.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'still_waiting',
      afterMarker: true,
    });
    expect(run.walletState.signed.length).toBe(1);
  });

  it('refuses another account as a retry (other_payer): it must take the switch path', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    const other = fakeWallet(OTHER_SECRET, BASE_SEPOLIA.evmChainId ?? 0);
    expect(await retryWithEip3009(record, other.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'other_payer',
      afterMarker: true,
    });
    expect(other.state.signed).toEqual([]);
  });

  it.each([
    [{ requestError: { code: 4001 } }, 'connect_failed'],
    [{ requestError: { code: -32002 } }, 'connect_failed'],
    [{ requestError: new Error('gone') }, 'connect_failed'],
    [{ switchError: { code: 4901 } }, 'wrong_chain'],
  ] as const)('keeps the attempt live on a step 1 failure %o', async (failure, reason) => {
    const run = await world();
    const record = await signedNotSent(run);
    Object.assign(run.walletState, failure);
    expect(await retryWithEip3009(record, run.wallet, run.fresh, run.deps)).toMatchObject({
      reason,
      afterMarker: true,
    });
    expect((await stored(run)).state).toBe('paying');
  });

  it('gives sign_declined on a refused prompt or a non-recovering signature, never clearing', async () => {
    for (const failure of [{ signError: { code: 4001 } }, { signWithOther: OTHER_SECRET }]) {
      const run = await world();
      const record = await signedNotSent(run);
      Object.assign(run.walletState, failure);
      expect(await retryWithEip3009(record, run.wallet, run.fresh, run.deps)).toMatchObject({
        reason: 'sign_declined',
        afterMarker: true,
      });
      const after = await stored(run);
      expect(after.state).toBe('paying');
      expect(markerOf(after).signed).toBe(true);
    }
  });

  it('clears an unsigned marker and pays afresh, reading the nonce first', async () => {
    const run = await world();
    // A marker set, the page died before the signature: unsigned.
    run.walletState.signError = { code: 4001 };
    await payWithEip3009(run.record, run.wallet, run.fresh, run.deps);
    run.walletState.signError = undefined;
    const ordered = await stored(run);
    const set = await store.setMarker(ordered.orderId, ordered.version, {
      rail: 'eip3009',
      attemptId: 'dead-page',
      setAt: NOW,
      authorizer: run.walletState.account,
      floorBlock: '950',
      validBefore: String(NOW + 930),
    });
    if (!set.ok) {
      throw new Error(set.reason);
    }
    const record = await stored(run);
    expect(record.state).toBe('paying');
    expect(markerOf(record).signed).toBeUndefined();
    run.chain.used.add(usedKey(run.walletState.account, record.reference));
    expect(await retryWithEip3009(record, run.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'nonce_used',
    });
    expect(markerOf(await stored(run)).usedAtStart).toBe(true);
  });
});

describe('switchWalletWithEip3009', () => {
  async function switchable(): Promise<{
    run: World;
    record: OrderRecord;
    other: ReturnType<typeof fakeWallet>;
  }> {
    const run = await world();
    const record = await signedNotSent(run);
    const other = fakeWallet(OTHER_SECRET, BASE_SEPOLIA.evmChainId ?? 0);
    run.chain.tokens.set(other.state.account, PRICE * 2n);
    run.chain.native.set(other.state.account, 10n ** 18n);
    return { run, record, other };
  }

  it('waits for the end proof: nothing before validBefore is finalized', async () => {
    const { run, record, other } = await switchable();
    expect(await switchWalletWithEip3009(record, other.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'still_waiting',
      afterMarker: true,
    });
    expect(other.state.signed).toEqual([]);
  });

  it('switches with the proof carried as switchProof, keeping signed and the floor', async () => {
    const { run, record, other } = await switchable();
    run.chain.finalized = { number: 1100, timestamp: Number(markerOf(record).validBefore) + 1 };
    run.chain.latest = { number: 1200, timestamp: Number(markerOf(record).validBefore) + 60 };
    expect(await switchWalletWithEip3009(record, other.wallet, run.fresh, run.deps)).toMatchObject({
      ok: true,
    });
    const marker = markerOf(await stored(run));
    expect(marker).toMatchObject({
      authorizer: other.state.account,
      signed: true,
      floorBlock: '950',
      switchProof: { timestamp: Number(markerOf(record).validBefore) + 1 },
    });
    // The proof read the authorization state pinned at F, the block the proof names.
    expect(marker.switchProof?.blockHash).toBe(blockHashOf(1100));
    expect(run.chain.pinnedReads).toEqual([blockHashOf(1100)]);
  });

  it('never switches while the old authorization was used', async () => {
    const { run, record, other } = await switchable();
    run.chain.finalized = { number: 1100, timestamp: Number(markerOf(record).validBefore) + 1 };
    run.chain.used.add(usedKey(run.walletState.account, record.reference));
    expect(await switchWalletWithEip3009(record, other.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'still_waiting',
    });
  });

  it('switches past a cancel of the old authorization found from the floor', async () => {
    const { run, record, other } = await switchable();
    run.chain.finalized = { number: 1100, timestamp: Number(markerOf(record).validBefore) + 1 };
    run.chain.latest = { number: 1200, timestamp: Number(markerOf(record).validBefore) + 60 };
    cancel(run.chain, run.walletState.account, record.reference, 950);
    expect(await switchWalletWithEip3009(record, other.wallet, run.fresh, run.deps)).toMatchObject({
      ok: true,
    });
  });
});

describe('endEip3009Order', () => {
  it('ends a signed attempt only through the end proof, stored with the end', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    expect(await endEip3009Order(record, run.deps)).toMatchObject({ ended: false });
    // A finalized block AT validBefore may still hold the authorization.
    run.chain.finalized = { number: 1100, timestamp: Number(markerOf(record).validBefore) };
    expect(await endEip3009Order(record, run.deps)).toMatchObject({ ended: false });
    run.chain.finalized = { number: 1100, timestamp: Number(markerOf(record).validBefore) + 1 };
    const ended = await endEip3009Order(record, run.deps);
    expect(ended).toMatchObject({ ended: true, record: { state: 'ended-unpaid' } });
    expect(markerOf(ended.record).endProof).toMatchObject({
      timestamp: Number(markerOf(record).validBefore) + 1,
    });
    expect(markerOf(ended.record).endProof?.blockHash).toBe(blockHashOf(1100));
    expect(run.chain.pinnedReads.at(-1)).toBe(blockHashOf(1100));
    expect(ended.record.endedBy).toBeUndefined();
  });

  it('never ends one whose authorization was used, nor on an unreadable proof', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    run.chain.finalized = { number: 1100, timestamp: Number(markerOf(record).validBefore) + 1 };
    run.chain.used.add(usedKey(run.walletState.account, record.reference));
    expect(await endEip3009Order(record, run.deps)).toMatchObject({ ended: false });
    run.chain.used.clear();
    run.chain.down.add('eth_call');
    expect(await endEip3009Order(record, run.deps)).toMatchObject({ ended: false });
  });

  it('ends through endOrder only with the eip3009 client', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    run.chain.finalized = { number: 1100, timestamp: Number(markerOf(record).validBefore) + 1 };
    const base = { store, readClient: run.relays, clientFor: () => run.relays, rpc: undefined };
    expect(await endOrder(record, base)).toMatchObject({ ended: false });
    expect(await endOrder(record, { ...base, eip3009: run.chain.client })).toMatchObject({
      ended: true,
      record: { state: 'ended-unpaid' },
    });
  });

  it('ends an ordered order with no marker through endOrder, with no endedBy', async () => {
    const run = await world();
    const base = { store, readClient: run.relays, clientFor: () => run.relays, rpc: undefined };
    const ended = await endOrder(run.record, { ...base, eip3009: run.chain.client });
    expect(ended).toMatchObject({ ended: true, record: { state: 'ended-unpaid' } });
    expect(ended.record.endedBy).toBeUndefined();
    expect(run.chain.calls).toEqual([]);
  });
});

describe('watchEip3009Payment', () => {
  it('records a payment found at the credit tag, confirming above it', async () => {
    const run = await world();
    const { record, hash } = await sent(run);
    land(run.chain, {
      hash,
      authorizer: run.walletState.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 995,
    });
    expect(await watchEip3009Payment(record, run.deps)).toMatchObject({
      state: 'confirming',
      hash,
    });
    run.chain.safe = { number: 995, timestamp: NOW };
    expect(await watchEip3009Payment(record, run.deps)).toMatchObject({
      state: 'paid',
      record: { state: 'paid', paidTx: hash },
    });
  });

  it('finds a payment by the nonce scan, with a receipt naming that transaction', async () => {
    const run = await world();
    const { record } = await sent(run);
    const other = `0x${'9'.repeat(64)}`;
    land(run.chain, {
      hash: other,
      authorizer: run.walletState.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 960,
    });
    const before = run.relays.published.length;
    const watched = await watchEip3009Payment(record, run.deps);
    expect(watched).toMatchObject({ state: 'paid', record: { paidTx: other } });
    expect(run.relays.published.length).toBe(before + 1);
  });

  it('sends a receipt while paying when the stored one names another transaction', async () => {
    const run = await world();
    const { record, hash } = await sent(run);
    // A retry hash stored, its receipt lost (the tab closed): the note is stale.
    const marker = markerOf(record);
    const newer = `0x${'8'.repeat(64)}`;
    await store.updateMarker(record.orderId, record.version, marker.attemptId, {
      ...marker,
      txHash: newer,
    });
    const before = run.relays.published.length;
    const watched = await watchEip3009Payment(await stored(run), run.deps);
    expect(run.relays.published.length).toBe(before + 1);
    expect(markerOf(watched.record).receiptTx).toBe(newer);
    expect(hash).not.toBe(newer);
  });

  it('says unsure, never waiting, when the scan cannot be read in full', async () => {
    const run = await world();
    const { record } = await sent(run);
    run.chain.down.add('eth_getLogs');
    expect(await watchEip3009Payment(record, run.deps)).toMatchObject({ state: 'unsure' });
  });
});

describe('storedEip3009Request', () => {
  it('refuses a stored request differing from the payout, the amount or the reference', async () => {
    const run = await world();
    await sent(run);
    const record = await stored(run);
    const request = JSON.parse(record.paymentRequest ?? '{}') as Record<string, string>;
    for (const change of [
      { payee: `0x${'12'.repeat(20)}` },
      { amount: '1' },
      { nonce: `0xfab22e7e${'00'.repeat(28)}` },
      { caip2: 'eip155:1' },
      { extra: 'x' },
    ]) {
      const changed = { ...record, paymentRequest: JSON.stringify({ ...request, ...change }) };
      expect(storedEip3009Request(changed)).toBeUndefined();
    }
    expect(storedEip3009Request(record)).toBeDefined();
  });

  it('refuses to pay a record whose reference is not the derived eip3009 nonce', async () => {
    const run = await world();
    const forged = { ...run.record, reference: `0x${'00'.repeat(32)}` };
    expect(await payWithEip3009(forged, run.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'not_payable',
    });
  });
});

describe('readEip3009ChainTime', () => {
  it('dates an order with the LATEST block', async () => {
    const run = await world();
    expect(await readEip3009ChainTime(run.chain.client)).toBe(NOW + 30);
  });
});

describe('the money rules at their boundaries (review round 1)', () => {
  it('refuses the same payout at another price as offer_changed, first attempt and retry', async () => {
    const first = await world();
    expect(
      await payWithEip3009(first.record, first.wallet, repriced(first.fresh), first.deps),
    ).toMatchObject({ ok: false, reason: 'offer_changed' });
    expect((await stored(first)).marker).toBeUndefined();
    expect(first.walletState.signed).toEqual([]);
    const retry = await world();
    const record = await signedNotSent(retry);
    expect(
      await retryWithEip3009(record, retry.wallet, repriced(retry.fresh), retry.deps),
    ).toMatchObject({ ok: false, reason: 'offer_changed', afterMarker: true });
    expect(retry.walletState.signed.length).toBe(1);
  });

  it('pays a buyer holding exactly the price in USDC', async () => {
    const run = await world();
    run.chain.tokens.set(run.walletState.account, PRICE);
    expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
      ok: true,
    });
  });

  it('sends when the native coin is exactly what 5.1 needs', async () => {
    const run = await world();
    const gas = 100_000n * (2n * 1_000_000_000n + 100_000_000n);
    const needed =
      (gas * 15_000n + 9_999n) / 10_000n + (1_000_000_000_000n * 15_000n + 9_999n) / 10_000n;
    run.chain.native.set(run.walletState.account, needed);
    expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
      ok: true,
    });
  });

  it('sends with exactly SEND_MARGIN_SECS left before validBefore', async () => {
    const run = await world();
    run.walletState.onSign = async () => {
      run.chain.latest.timestamp = NOW + 30 + EIP3009_VALID_SECS - SEND_MARGIN_SECS;
    };
    const result = await payWithEip3009(run.record, run.wallet, run.fresh, run.deps);
    expect(result).toMatchObject({ ok: true });
    expect(run.walletState.sent.length).toBe(1);
  });

  it('warns nearExpiry when the latest block after the send is inside the margin, not at it', async () => {
    const validBefore = NOW + 30 + EIP3009_VALID_SECS;
    const close = await world();
    close.walletState.onSend = async () => {
      close.chain.latest.timestamp = validBefore - SEND_MARGIN_SECS + 1;
    };
    expect(await payWithEip3009(close.record, close.wallet, close.fresh, close.deps)).toMatchObject(
      { ok: true, nearExpiry: true },
    );
    const atMargin = await world();
    atMargin.walletState.onSend = async () => {
      atMargin.chain.latest.timestamp = validBefore - SEND_MARGIN_SECS;
    };
    const quiet = await payWithEip3009(
      atMargin.record,
      atMargin.wallet,
      atMargin.fresh,
      atMargin.deps,
    );
    expect(quiet).toMatchObject({ ok: true });
    expect(quiet.ok && quiet.nearExpiry).toBeFalsy();
  });

  it('refuses an old resend handle once another retry started a new attempt, sending nothing', async () => {
    const run = await world();
    run.walletState.sendError = { code: 4001 };
    const declined = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    const resend = declined.resend;
    if (resend === undefined) {
      throw new Error('no resend');
    }
    run.walletState.sendError = undefined;
    // A retry on a lagging latest keeps signature and validBefore, but is a new attempt.
    run.chain.latest.timestamp = NOW;
    run.walletState.signError = { code: 4001 };
    const retried = failed(
      await retryWithEip3009(await stored(run), run.wallet, run.fresh, run.deps),
    );
    expect(retried.reason).toBe('sign_declined');
    run.walletState.signError = undefined;
    expect(markerOf(await stored(run)).attemptId).not.toBe(markerOf(declined.record).attemptId);
    expect(await resendWithEip3009(resend, run.wallet, run.deps)).toMatchObject({
      ok: false,
      reason: 'not_payable',
    });
    expect(run.walletState.sent).toEqual([]);
  });

  it('switches and ends only on the authorization state pinned at F, not at latest', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    const validBefore = Number(markerOf(record).validBefore);
    run.chain.finalized = { number: 1100, timestamp: validBefore + 1 };
    run.chain.latest = { number: 1200, timestamp: validBefore + 60 };
    // Pinned at F the authorization was used; latest (a lagging backend) says unused.
    run.chain.usedPinned = new Set([usedKey(run.walletState.account, record.reference)]);
    const other = fakeWallet(OTHER_SECRET, BASE_SEPOLIA.evmChainId ?? 0);
    run.chain.tokens.set(other.state.account, PRICE * 2n);
    run.chain.native.set(other.state.account, 10n ** 18n);
    expect(await switchWalletWithEip3009(record, other.wallet, run.fresh, run.deps)).toMatchObject({
      ok: false,
      reason: 'still_waiting',
    });
    expect(other.state.signed).toEqual([]);
    expect(await endEip3009Order(await stored(run), run.deps)).toMatchObject({ ended: false });
    expect((await stored(run)).state).toBe('paying');
  });

  it('ends a marker that never held a signature with no proof and no proof read', async () => {
    const run = await world();
    // A marker set, the page died before the signature: unsigned.
    run.walletState.signError = { code: 4001 };
    await payWithEip3009(run.record, run.wallet, run.fresh, run.deps);
    run.walletState.signError = undefined;
    const ordered = await stored(run);
    const set = await store.setMarker(ordered.orderId, ordered.version, {
      rail: 'eip3009',
      attemptId: 'dead-page',
      setAt: NOW,
      authorizer: run.walletState.account,
      floorBlock: '950',
      validBefore: String(NOW + 930),
    });
    if (!set.ok) {
      throw new Error(set.reason);
    }
    run.chain.calls.length = 0;
    const ended = await endEip3009Order(set.record, run.deps);
    expect(ended).toMatchObject({ ended: true, record: { state: 'ended-unpaid' } });
    expect(run.chain.calls).toEqual([]);
  });
});

type Fail = (method: string, params: readonly unknown[]) => boolean;

const AUTHORIZATION_STATE = '0xe94a0102';
const GET_L1_FEE = '0x49948e0e';

function isPinned(params: readonly unknown[]): boolean {
  return typeof params[1] === 'object' && params[1] !== null;
}

function calling(selector: string): Fail {
  return (method, params) => selectorOf(method, params) === selector;
}

/** Fails only the `nth` request matching `fail` once the wallet signed (1-based). */
function afterSigning(run: World, fail: Fail, nth = 1): Fail {
  let seen = 0;
  return (method, params) => {
    if (run.walletState.signed.length === 0 || !fail(method, params)) {
      return false;
    }
    seen += 1;
    return seen === nth;
  };
}

/** A signed attempt whose authorization is past `validBefore` at a finalized block. */
async function pastValidBefore(): Promise<{
  run: World;
  record: OrderRecord;
  other: ReturnType<typeof fakeWallet>;
}> {
  const run = await world();
  const record = await signedNotSent(run);
  const validBefore = Number(markerOf(record).validBefore);
  run.chain.finalized = { number: 1100, timestamp: validBefore + 1 };
  run.chain.latest = { number: 1200, timestamp: validBefore + 60 };
  const other = fakeWallet(OTHER_SECRET, BASE_SEPOLIA.evmChainId ?? 0);
  run.chain.tokens.set(other.state.account, PRICE * 2n);
  run.chain.native.set(other.state.account, 10n ** 18n);
  return { run, record, other };
}

describe('every chain read that fails (review round 2)', () => {
  // Step 2, in order: the widget RPC's chain, the nonce, the latest block, then
  // each read of the USDC and payer state.
  const STEP_2_READS: [string, Fail][] = [
    ['the widget RPC chain id', (method) => method === 'eth_chainId'],
    ['authorizationState at latest', calling(AUTHORIZATION_STATE)],
    ['the latest block', (method, params) => tagOf(method, params) === 'latest'],
    ['paused', calling('0x5c975abb')],
    ['a blacklist', calling('0xfe575a87')],
    ['the USDC balance', calling('0x70a08231')],
    ['the domain separator', calling('0x3644e515')],
    ['the native balance', (method) => method === 'eth_getBalance'],
    ['the payer code', (method) => method === 'eth_getCode'],
    ['the implementation slot', (method) => method === 'eth_getStorageAt'],
  ];

  it.each(STEP_2_READS)(
    'refuses a first attempt with rpc_error when %s fails: no marker, nothing signed',
    async (_label, fail) => {
      const run = await world();
      run.chain.failIf = fail;
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason: 'rpc_error',
      });
      const record = await stored(run);
      expect(record.state).toBe('ordered');
      expect(record.marker).toBeUndefined();
      expect(run.walletState.signed).toEqual([]);
      expect(run.walletState.sent).toEqual([]);
    },
  );

  it('refuses with rpc_error when only the first chain id read fails, before anything else', async () => {
    const run = await world();
    let chainIdReads = 0;
    run.chain.failIf = (method) => {
      if (method !== 'eth_chainId') {
        return false;
      }
      chainIdReads += 1;
      return chainIdReads === 1;
    };
    expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'rpc_error',
    });
    expect((await stored(run)).marker).toBeUndefined();
    expect(run.walletState.signed).toEqual([]);
  });

  it('refuses a first attempt with rpc_error when the floor block fails: no marker', async () => {
    const run = await world();
    run.chain.failIf = (method, params) => tagOf(method, params) === 'finalized';
    expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'rpc_error',
    });
    expect((await stored(run)).marker).toBeUndefined();
    expect(run.walletState.signed).toEqual([]);
  });

  it.each(STEP_2_READS)(
    'keeps a retry live with rpc_error when %s fails: the attempt unchanged, nothing signed',
    async (_label, fail) => {
      const run = await world();
      const before = await signedNotSent(run);
      const old = markerOf(before);
      run.chain.failIf = fail;
      expect(await retryWithEip3009(before, run.wallet, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason: 'rpc_error',
        afterMarker: true,
        attemptId: old.attemptId,
      });
      const marker = markerOf(await stored(run));
      expect(marker.attemptId).toBe(old.attemptId);
      expect(marker.validBefore).toBe(old.validBefore);
      expect(run.walletState.signed.length).toBe(1);
      expect(run.walletState.sent).toEqual([]);
    },
  );

  // Step 5.1 and step 6, after the signature is stored.
  const AFTER_SIGNATURE: [string, (run: World) => Fail][] = [
    ['the L1 fee', (run) => afterSigning(run, calling(GET_L1_FEE))],
    ['the native balance', (run) => afterSigning(run, (method) => method === 'eth_getBalance')],
    [
      "the estimate's fee-cap block",
      (run) => afterSigning(run, (method, params) => tagOf(method, params) === 'latest'),
    ],
    [
      'the priority fee',
      (run) => afterSigning(run, (method) => method === 'eth_maxPriorityFeePerGas'),
    ],
  ];

  it.each(AFTER_SIGNATURE)(
    'sends nothing and keeps the signed attempt when %s fails at step 5.1',
    async (_label, failFor) => {
      const run = await world();
      run.chain.failIf = failFor(run);
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason: 'rpc_error',
        afterMarker: true,
      });
      expect(run.walletState.sent).toEqual([]);
      const marker = markerOf(await stored(run));
      expect(marker.signed).toBe(true);
      expect(marker.txHash).toBeUndefined();
    },
  );

  it('gives rpc_error, never send_failed, when the nonce re-read after a reverted estimate fails', async () => {
    const run = await world();
    run.chain.estimate = () => {
      throw Object.assign(new Error('execution reverted'), { code: 3 });
    };
    run.chain.failIf = afterSigning(run, calling(AUTHORIZATION_STATE));
    expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'rpc_error',
      afterMarker: true,
    });
    expect(run.walletState.sent).toEqual([]);
  });

  it('sends nothing when the latest block at step 6 fails, and hands back a resend that works', async () => {
    const run = await world();
    // The first latest read after signing is the estimate's, the second the send's.
    run.chain.failIf = afterSigning(run, (method, params) => tagOf(method, params) === 'latest', 2);
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(result).toMatchObject({ reason: 'rpc_error', afterMarker: true });
    expect(run.walletState.sent).toEqual([]);
    const resend = result.resend;
    if (resend === undefined) {
      throw new Error('no resend');
    }
    run.chain.failIf = undefined;
    expect(await resendWithEip3009(resend, run.wallet, run.deps)).toMatchObject({ ok: true });
    expect(run.walletState.sent.length).toBe(1);
  });

  // The end proof: the finalized block, the state pinned at it, the chain
  // re-bind before a false answer counts, and the cancel scan of a used one.
  const PROOF_READS: [string, Fail, boolean][] = [
    ['the finalized block', (method, params) => tagOf(method, params) === 'finalized', false],
    [
      'authorizationState pinned at F',
      (method, params) => calling(AUTHORIZATION_STATE)(method, params) && isPinned(params),
      false,
    ],
    ['the chain id re-bind', (method) => method === 'eth_chainId', false],
    ['the cancel scan', (method) => method === 'eth_getLogs', true],
  ];

  it.each(PROOF_READS)(
    'never switches nor ends when %s fails: rpc_error, unreadable',
    async (_label, fail, used) => {
      const { run, record, other } = await pastValidBefore();
      if (used) {
        run.chain.used.add(usedKey(run.walletState.account, record.reference));
      }
      run.chain.failIf = fail;
      expect(
        await switchWalletWithEip3009(record, other.wallet, run.fresh, run.deps),
      ).toMatchObject({ ok: false, reason: 'rpc_error', afterMarker: true });
      expect(other.state.signed).toEqual([]);
      expect(await eip3009EndProof(record, run.deps)).toBe('unreadable');
      expect(await endEip3009Order(record, run.deps)).toMatchObject({
        ended: false,
        proof: 'unreadable',
      });
      expect((await stored(run)).state).toBe('paying');
    },
  );

  const WATCH_READS: [string, Fail, boolean][] = [
    ['the receipt', (method) => method === 'eth_getTransactionReceipt', true],
    ['the credit tag', (method, params) => tagOf(method, params) === 'safe', true],
    ['the scan head', (method, params) => tagOf(method, params) === 'latest', false],
  ];

  it.each(WATCH_READS)(
    'says unsure, never paid or waiting, when %s fails',
    async (_label, fail, landed) => {
      const run = await world();
      const { record, hash } = await sent(run);
      if (landed) {
        land(run.chain, {
          hash,
          authorizer: run.walletState.account,
          nonce: record.reference,
          payee: PAYEE,
          value: PRICE,
          block: 980,
        });
      }
      run.chain.failIf = fail;
      expect(await watchEip3009Payment(record, run.deps)).toMatchObject({ state: 'unsure' });
      expect((await stored(run)).state).toBe('paying');
    },
  );
});

describe('the end proof, read-only (review round 2)', () => {
  it('answers too_early, over, used and unreadable for a signed attempt, with no write', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    expect(await eip3009EndProof(record, run.deps)).toBe('too_early');
    const validBefore = Number(markerOf(record).validBefore);
    run.chain.finalized = { number: 1100, timestamp: validBefore + 1 };
    expect(await eip3009EndProof(record, run.deps)).toBe('over');
    run.chain.used.add(usedKey(run.walletState.account, record.reference));
    expect(await eip3009EndProof(record, run.deps)).toBe('used');
    run.chain.down.add('eth_call');
    expect(await eip3009EndProof(record, run.deps)).toBe('unreadable');
    expect(await stored(run)).toEqual(record);
  });

  it('answers not_needed with no read for an order with nothing signed, never for a frozen one', async () => {
    const run = await world();
    expect(await eip3009EndProof(run.record, run.deps)).toBe('not_needed');
    expect(run.chain.calls).toEqual([]);
    const frozen = await world();
    frozen.chain.used.add(usedKey(frozen.walletState.account, frozen.record.reference));
    await payWithEip3009(frozen.record, frozen.wallet, frozen.fresh, frozen.deps);
    const record = await stored(frozen);
    expect(markerOf(record).usedAtStart).toBe(true);
    frozen.chain.calls.length = 0;
    expect(await eip3009EndProof(record, frozen.deps)).toBe('never');
    expect(await endEip3009Order(record, frozen.deps)).toMatchObject({
      ended: false,
      proof: 'never',
    });
    expect(frozen.chain.calls).toEqual([]);
  });

  it('says why an end or a switch waits: too_early, then used', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    expect(await endEip3009Order(record, run.deps)).toMatchObject({
      ended: false,
      proof: 'too_early',
    });
    const other = fakeWallet(OTHER_SECRET, BASE_SEPOLIA.evmChainId ?? 0);
    expect(await switchWalletWithEip3009(record, other.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'still_waiting',
      proof: 'too_early',
    });
    run.chain.finalized = { number: 1100, timestamp: Number(markerOf(record).validBefore) + 1 };
    run.chain.used.add(usedKey(run.walletState.account, record.reference));
    expect(await endEip3009Order(record, run.deps)).toMatchObject({ ended: false, proof: 'used' });
    expect(await switchWalletWithEip3009(record, other.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'still_waiting',
      proof: 'used',
    });
    run.chain.used.clear();
    expect(await endEip3009Order(record, run.deps)).toMatchObject({
      ended: true,
      proof: 'over',
    });
  });

  it('counts a cancel inside block F itself: the scan reaches F', async () => {
    const { run, record, other } = await pastValidBefore();
    cancel(run.chain, run.walletState.account, record.reference, 1100);
    expect(await eip3009EndProof(record, run.deps)).toBe('over');
    expect(await switchWalletWithEip3009(record, other.wallet, run.fresh, run.deps)).toMatchObject({
      ok: true,
    });
  });
});

describe('the gaps review round 2 named', () => {
  it.each([
    ['rejected', { code: 4001 }, 'connect_failed'],
    ['busy', { code: -32002 }, 'connect_failed'],
  ] as const)(
    'keeps a switch live when the other wallet answers step 1 %s',
    async (walletError, error, reason) => {
      const run = await world();
      const record = await signedNotSent(run);
      const other = fakeWallet(OTHER_SECRET, BASE_SEPOLIA.evmChainId ?? 0);
      other.state.requestError = error;
      expect(
        await switchWalletWithEip3009(record, other.wallet, run.fresh, run.deps),
      ).toMatchObject({
        ok: false,
        reason,
        walletError,
        afterMarker: true,
        attemptId: markerOf(record).attemptId,
      });
    },
  );

  it('keeps a switch live when the other wallet cannot reach the chain (wrong_chain)', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    const other = fakeWallet(OTHER_SECRET, BASE_SEPOLIA.evmChainId ?? 0);
    other.state.switchError = { code: 4901 };
    expect(await switchWalletWithEip3009(record, other.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'wrong_chain',
      afterMarker: true,
      attemptId: markerOf(record).attemptId,
    });
  });

  it.each([
    ['cancelled by the store', 'cancelled'],
    ['paid', 'paid'],
    ['ended', 'ended-unpaid'],
  ] as const)('refuses a resend once the order is %s, sending nothing', async (_label, outcome) => {
    const run = await world();
    run.chain.native.set(run.walletState.account, 1n);
    const short = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(short.reason).toBe('insufficient_native');
    const resend = short.resend;
    if (resend === undefined) {
      throw new Error('no resend');
    }
    const current = await stored(run);
    const marker = markerOf(current);
    let written;
    if (outcome === 'cancelled') {
      written = await store.update(current.orderId, current.version, {
        status: { status: 'cancelled', at: NOW },
      });
    } else if (outcome === 'paid') {
      written = await store.update(current.orderId, current.version, {
        state: 'paid',
        paidTx: `0x${'9'.repeat(64)}`,
        paidAt: NOW,
      });
    } else {
      written = await store.clearMarker(
        current.orderId,
        current.version,
        marker.attemptId,
        'ended-unpaid',
        undefined,
        { blockHash: `0x${'cd'.repeat(32)}`, timestamp: Number(marker.validBefore) + 1 },
      );
    }
    expect(written.ok).toBe(true);
    run.chain.native.set(run.walletState.account, 10n ** 18n);
    expect(await resendWithEip3009(resend, run.wallet, run.deps)).toMatchObject({
      ok: false,
      reason: 'not_payable',
    });
    expect(run.walletState.sent).toEqual([]);
  });

  it('refuses with fee_config_unavailable or fee_config_invalid when the fee terms fail, no marker', async () => {
    for (const [thrown, reason] of [
      [new Error('relay down'), 'fee_config_unavailable'],
      [new FeeConfigError('bad_config', 'broken'), 'fee_config_invalid'],
    ] as const) {
      const run = await world();
      run.deps.feeTerms = async () => {
        throw thrown;
      };
      expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason,
      });
      expect((await stored(run)).marker).toBeUndefined();
      expect(run.walletState.signed).toEqual([]);
    }
  });

  it('refuses another product address as offer_changed', async () => {
    const run = await world();
    const moved = { ...run.fresh, productAddress: `${run.fresh.productAddress}-moved` };
    expect(await payWithEip3009(run.record, run.wallet, moved, run.deps)).toMatchObject({
      reason: 'offer_changed',
    });
    expect(run.walletState.signed).toEqual([]);
  });

  it('hands back the store refusals of the marker write: needs_confirmation and exclusion', async () => {
    const asked = await world();
    vi.spyOn(store, 'setMarker').mockResolvedValueOnce({
      ok: false,
      reason: 'needs_confirmation',
      unconfirmed: ['old-order'],
    });
    expect(await payWithEip3009(asked.record, asked.wallet, asked.fresh, asked.deps)).toMatchObject(
      { ok: false, reason: 'needs_confirmation', unconfirmed: ['old-order'] },
    );
    expect(asked.walletState.signed).toEqual([]);
    vi.restoreAllMocks();
    const held = await world();
    vi.spyOn(store, 'setMarker').mockResolvedValueOnce({
      ok: false,
      reason: 'exclusion',
      holder: 'other-order',
    });
    expect(await payWithEip3009(held.record, held.wallet, held.fresh, held.deps)).toMatchObject({
      ok: false,
      reason: 'exclusion',
      holder: 'other-order',
    });
    expect(held.walletState.signed).toEqual([]);
    vi.restoreAllMocks();
  });

  it('gives wallet_failed with no resend when the send prompt throws other than a decline', async () => {
    const run = await world();
    run.walletState.sendError = new Error('the extension crashed');
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(result).toMatchObject({ reason: 'wallet_failed', afterMarker: true });
    expect(result.resend).toBeUndefined();
  });

  it('refuses, asking no wallet, an order the store closed', async () => {
    const run = await world();
    run.walletState.requestError = { code: 4001 };
    const closed = { ...run.record, status: { status: 'cancelled' as const, at: NOW } };
    expect(await payWithEip3009(closed, run.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'not_payable',
    });
  });

  it('refuses a payout on a chain that does not settle over EIP-3009, asking no wallet', async () => {
    const run = await world();
    run.walletState.requestError = { code: 4001 };
    const tempo = {
      ...run.record,
      payout: { ...run.record.payout, caip19: caip19Of(CHAINS.TEMPO_DEVNET) },
    };
    expect(await payWithEip3009(tempo, run.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'not_payable',
    });
  });

  it('refuses an account that is not an EVM address as connect_failed', async () => {
    const run = await world();
    run.walletState.account = 'not-an-address';
    expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'connect_failed',
      walletError: 'failed',
    });
  });

  it('refuses a retry over a stored request that pays anything else, signing nothing', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    const tampered = {
      ...record,
      paymentRequest: JSON.stringify({ rail: 'eip3009', payee: OTHER_SECRET.length }),
    };
    expect(await retryWithEip3009(tampered, run.wallet, run.fresh, run.deps)).toMatchObject({
      reason: 'not_payable',
      afterMarker: true,
    });
    expect(run.walletState.signed.length).toBe(1);
  });

  it('stores a pending hash the watch is given while paying', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    const pending = `0x${'a'.repeat(64)}`;
    await watchEip3009Payment(record, run.deps, { pendingHash: pending });
    expect(markerOf(await stored(run)).txHash).toBe(pending);
  });

  it('never counts a leg below the price as paid', async () => {
    const run = await world();
    const { record, hash } = await sent(run);
    land(run.chain, {
      hash,
      authorizer: run.walletState.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE - 1n,
      block: 980,
    });
    expect(await watchEip3009Payment(record, run.deps)).toMatchObject({ state: 'waiting' });
    expect((await stored(run)).state).toBe('paying');
  });
});

describe('every refusal code is pinned by a test (review round 2)', () => {
  // A new code without an entry here does not compile; an entry whose code no
  // assertion in this file names fails.
  const EVERY_REFUSAL: Record<Eip3009PayRefusal, string | true> = {
    not_payable: true,
    connect_failed: true,
    stale_offer: true,
    offer_changed: true,
    too_late: true,
    self_payment: true,
    insufficient_token: true,
    no_native: true,
    token_blocked: true,
    unpayable: true,
    payer_unsupported: true,
    wrong_chain: true,
    rpc_error: true,
    exclusion: true,
    needs_confirmation: true,
    conflict: true,
    fee_not_zero: true,
    rejected: true,
    sign_failed: true,
    sign_declined: true,
    insufficient_native: true,
    wrong_chain_after_sign: true,
    resign_needed: true,
    send_declined: true,
    wallet_failed: true,
    send_failed: true,
    other_payer: true,
    nonce_used: true,
    still_waiting: true,
    fee_config_unavailable: true,
    fee_config_invalid: true,
    store_outdated: 'this rail never plans a fee (E7: fee 0 only), so nothing gives it',
  };

  it.each(Object.entries(EVERY_REFUSAL))('%s', (code, pinned) => {
    if (pinned !== true) {
      return;
    }
    const source = readFileSync(__filename, 'utf8');
    const asserted = [
      `reason: '${code}'`,
      `toBe('${code}')`,
      `refusedBeforeMarker(run, '${code}'`,
      `, '${code}')`,
      `, '${code}']`,
    ];
    expect(asserted.some((form) => source.includes(form))).toBe(true);
  });
});

describe('review round 3: one send per signature, unsaved hashes, account case, closed orders', () => {
  /** A first attempt declined at the send prompt, with its resend handle. */
  async function declined(run: World): Promise<NonNullable<Eip3009PayResult['resend']>> {
    run.walletState.sendError = { code: 4001 };
    const first = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(first.reason).toBe('send_declined');
    run.walletState.sendError = undefined;
    if (first.resend === undefined) {
      throw new Error('no resend handle');
    }
    return first.resend;
  }

  it('refuses a resend handle once its attempt was sent: the wallet is asked once', async () => {
    const run = await world();
    const handle = await declined(run);
    expect(await resendWithEip3009(handle, run.wallet, run.deps)).toMatchObject({ ok: true });
    expect(await resendWithEip3009(handle, run.wallet, run.deps)).toMatchObject({
      ok: false,
      reason: 'not_payable',
    });
    expect(run.walletState.sent).toHaveLength(1);
  });

  it('sends once for two concurrent resends of one attempt', async () => {
    const run = await world();
    const handle = await declined(run);
    const [left, right] = await Promise.all([
      resendWithEip3009(handle, run.wallet, run.deps),
      resendWithEip3009(handle, run.wallet, run.deps),
    ]);
    expect([left.ok, right.ok].sort()).toEqual([false, true]);
    expect(run.walletState.sent).toHaveLength(1);
  });

  it('keeps the handle usable after a resend the buyer declined again', async () => {
    const run = await world();
    const handle = await declined(run);
    run.walletState.sendError = { code: 4001 };
    expect(await resendWithEip3009(handle, run.wallet, run.deps)).toMatchObject({
      reason: 'send_declined',
    });
    run.walletState.sendError = undefined;
    expect(await resendWithEip3009(handle, run.wallet, run.deps)).toMatchObject({ ok: true });
    expect(run.walletState.sent).toHaveLength(1);
  });

  it('refuses the handle after a send the wallet failed (it may have gone out)', async () => {
    const run = await world();
    const handle = await declined(run);
    run.walletState.sendError = { code: -32603, message: 'internal' };
    expect(await resendWithEip3009(handle, run.wallet, run.deps)).toMatchObject({
      reason: 'wallet_failed',
    });
    run.walletState.sendError = undefined;
    expect(await resendWithEip3009(handle, run.wallet, run.deps)).toMatchObject({
      reason: 'not_payable',
    });
    expect(run.walletState.sent).toEqual([]);
  });

  /** A retry whose send went out but whose hash write was refused: tx2 lives only in memory. */
  async function retriedUnsaved(run: World): Promise<{ record: OrderRecord; tx2: string }> {
    const { record } = await sent(run);
    run.chain.latest = { number: 1001, timestamp: NOW + 60 };
    const refusing: OrderStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'updateMarker') {
          return async (...args: Parameters<OrderStore['updateMarker']>) => {
            const next = args[3];
            if (next.rail === 'eip3009' && next.txHash?.endsWith('00000002') === true) {
              return { ok: false, reason: 'conflict' } as const;
            }
            return await target.updateMarker(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const retried = await retryWithEip3009(record, run.wallet, run.fresh, {
      ...run.deps,
      store: refusing,
    });
    if (!retried.ok) {
      throw new Error(retried.reason);
    }
    expect(retried.hashUnsaved).toBe(true);
    const latest = await stored(run);
    expect(markerOf(latest).txHash).not.toBe(retried.hash);
    return { record: latest, tx2: retried.hash };
  }

  it('follows an unsaved retry hash by hash: paid at the credit tag with the nonce scan down', async () => {
    const run = await world();
    const { record, tx2 } = await retriedUnsaved(run);
    land(run.chain, {
      hash: tx2,
      authorizer: run.walletState.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 985,
    });
    run.chain.down.add('eth_getLogs');
    expect(await watchEip3009Payment(record, run.deps, { pendingHash: tx2 })).toMatchObject({
      state: 'paid',
      record: { state: 'paid', paidTx: tx2 },
    });
  });

  it('says confirming for an unsaved retry hash above the credit tag', async () => {
    const run = await world();
    const { record, tx2 } = await retriedUnsaved(run);
    land(run.chain, {
      hash: tx2,
      authorizer: run.walletState.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 995,
    });
    run.chain.down.add('eth_getLogs');
    expect(await watchEip3009Payment(record, run.deps, { pendingHash: tx2 })).toMatchObject({
      state: 'confirming',
      hash: tx2,
    });
  });

  it('stores the authorizer lowercase for a wallet that answers a checksummed account', async () => {
    const run = await world();
    const checksummed = `0x${run.walletState.account.slice(2).toUpperCase()}`;
    const wallet: Eip3009Wallet = { ...run.wallet, requestAccounts: async () => [checksummed] };
    run.walletState.sendError = { code: 4001 };
    failed(await payWithEip3009(run.record, wallet, run.fresh, run.deps));
    run.walletState.sendError = undefined;
    const record = await stored(run);
    expect(markerOf(record).authorizer).toBe(run.walletState.account.toLowerCase());
    run.chain.latest = { number: 1001, timestamp: NOW + 60 };
    expect(await retryWithEip3009(record, wallet, run.fresh, run.deps)).toMatchObject({
      ok: true,
    });
  });

  it('refuses a self payment from a checksummed payer', async () => {
    const self = await world();
    self.walletState.account = PAYEE;
    self.chain.tokens.set(PAYEE, PRICE * 2n);
    const wallet: Eip3009Wallet = {
      ...self.wallet,
      requestAccounts: async () => [`0x${PAYEE.slice(2).toUpperCase()}`],
    };
    const result = failed(await payWithEip3009(self.record, wallet, self.fresh, self.deps));
    expect(result.reason).toBe('self_payment');
    expect((await stored(self)).marker).toBeUndefined();
  });

  it('clears the marker on a declined prompt even after a record version bump during it', async () => {
    const run = await world();
    run.walletState.onSign = async () => {
      const current = await stored(run);
      await store.update(current.orderId, current.version, {
        acknowledgedRelays: [...current.acknowledgedRelays, 'wss://more.example.com'],
      });
    };
    run.walletState.signError = { code: 4001 };
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(result.reason).toBe('rejected');
    const record = await stored(run);
    expect(record.state).toBe('ordered');
    expect(record.marker).toBeUndefined();
  });

  it('treats a switch to the marker own account as a plain retry, with no proof read', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    run.chain.latest = { number: 1001, timestamp: NOW + 60 };
    run.chain.calls.length = 0;
    expect(await switchWalletWithEip3009(record, run.wallet, run.fresh, run.deps)).toMatchObject({
      ok: true,
    });
    const pinned = run.chain.calls.filter((call) =>
      call.params.some(
        (param) => typeof param === 'object' && param !== null && 'blockHash' in param,
      ),
    );
    expect(pinned).toEqual([]);
    expect(markerOf(await stored(run)).switchProof).toBeUndefined();
  });

  it.each(['ended-unpaid', 'paid'] as const)(
    'answers never for a %s order holding a signed marker, with no read',
    async (state) => {
      const run = await world();
      const record = await signedNotSent(run);
      run.chain.calls.length = 0;
      const closed: OrderRecord = { ...record, state };
      expect(await eip3009EndProof(closed, run.deps)).toBe('never');
      expect(run.chain.calls).toEqual([]);
    },
  );

  it.each([
    ['an amount of 0', { amount: '0' }],
    ['a payee that is not an address', { payout: 'not-an-address' }],
  ] as const)('refuses a record with %s before anything is asked', async (_name, change) => {
    const run = await world();
    const record: OrderRecord =
      'amount' in change
        ? { ...run.record, amount: change.amount }
        : { ...run.record, payout: { ...run.record.payout, address: change.payout } };
    const result = failed(await payWithEip3009(record, run.wallet, run.fresh, run.deps));
    expect(result.reason).toBe('not_payable');
    expect(run.walletState.signed).toEqual([]);
    expect(run.walletState.sent).toEqual([]);
  });
});

describe('review round 4: shared sends, wallet answers, caller inputs', () => {
  async function declinedHandle(run: World): Promise<NonNullable<Eip3009PayResult['resend']>> {
    run.walletState.sendError = { code: 4001 };
    const first = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    run.walletState.sendError = undefined;
    if (first.resend === undefined) {
      throw new Error('no resend handle');
    }
    return first.resend;
  }

  it('shares one send across every handle of an attempt: an older handle is refused once a newer one sent', async () => {
    const run = await world();
    const older = await declinedHandle(run);
    run.walletState.sendError = { code: 4001 };
    const again = failed(await resendWithEip3009(older, run.wallet, run.deps));
    run.walletState.sendError = undefined;
    expect(again.reason).toBe('send_declined');
    if (again.resend === undefined) {
      throw new Error('no newer handle');
    }
    expect(await resendWithEip3009(again.resend, run.wallet, run.deps)).toMatchObject({ ok: true });
    expect(await resendWithEip3009(older, run.wallet, run.deps)).toMatchObject({
      ok: false,
      reason: 'not_payable',
    });
    expect(run.walletState.sent).toHaveLength(1);
  });

  it('refuses the handle after a send whose answer was no hash: the wallet may have broadcast', async () => {
    const run = await world();
    const handle = await declinedHandle(run);
    const nextHash = run.walletState.nextHash;
    run.walletState.nextHash = () => 'nope';
    expect(await resendWithEip3009(handle, run.wallet, run.deps)).toMatchObject({
      reason: 'wallet_failed',
    });
    run.walletState.nextHash = nextHash;
    expect(await resendWithEip3009(handle, run.wallet, run.deps)).toMatchObject({
      reason: 'not_payable',
    });
    expect(run.walletState.sent).toHaveLength(1);
  });

  it('keeps the handle usable after a resend that threw before the wallet was asked', async () => {
    const run = await world();
    const handle = await declinedHandle(run);
    let failOnce = true;
    const flaky: OrderStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'get' && failOnce) {
          return async () => {
            failOnce = false;
            throw new Error('store down');
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      resendWithEip3009(handle, run.wallet, { ...run.deps, store: flaky }),
    ).rejects.toThrow('store down');
    expect(await resendWithEip3009(handle, run.wallet, run.deps)).toMatchObject({ ok: true });
    expect(run.walletState.sent).toHaveLength(1);
  });

  it('reports a busy chain switch raw (connect_failed, busy), never wrong_chain', async () => {
    const run = await world();
    run.walletState.chainId = 1;
    run.walletState.switchError = { code: -32002 };
    expect(failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps))).toMatchObject(
      { reason: 'connect_failed', walletError: 'busy' },
    );
    expect((await stored(run)).marker).toBeUndefined();
  });

  it('sends the missing receipt for a stored payment that has none', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    const hash = `0x${'6'.repeat(64)}`;
    const written = await store.update(record.orderId, record.version, {
      state: 'paid',
      paidTx: hash,
      paidAt: NOW,
    });
    if (!written.ok) {
      throw new Error(written.reason);
    }
    expect(written.record.receiptWrap).toBeUndefined();
    const before = run.relays.published.length;
    const watched = await watchEip3009Payment(written.record, run.deps);
    expect(watched.state).toBe('paid');
    expect(run.relays.published.length).toBe(before + 1);
    expect(watched.record.receiptWrap).toBeDefined();
  });

  it('ignores a malformed pending hash: no throw, nothing stored', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    const watched = await watchEip3009Payment(record, run.deps, { pendingHash: '0x1234' });
    expect(watched.state).not.toBe('paid');
    expect(markerOf(await stored(run)).txHash).toBeUndefined();
    await expect(watchEip3009Payment(await stored(run), run.deps)).resolves.toBeDefined();
  });

  it('stores a checksummed pending hash lowercase and judges it once', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    const hash = `0x${'ab'.repeat(32)}`;
    run.chain.calls.length = 0;
    await watchEip3009Payment(record, run.deps, {
      pendingHash: hash.toUpperCase().replace('0X', '0x'),
    });
    expect(markerOf(await stored(run)).txHash).toBe(hash);
    const receipts = run.chain.calls.filter(
      (call) => call.method === 'eth_getTransactionReceipt' && call.params[0] === hash,
    );
    expect(receipts).toHaveLength(1);
  });

  const BAD_MARKERS = [
    ['an authorizer that is not an address', { authorizer: 'nope' }],
    ['a floor that is not decimal', { floorBlock: 'x' }],
    ['a floor beyond safe integers', { floorBlock: '9'.repeat(20) }],
    ['a validBefore that is not decimal', { validBefore: '-1' }],
    ['a stored hash that is not one', { txHash: '0x12' }],
    ['a stored hash in upper case', { txHash: `0x${'AB'.repeat(32)}` }],
  ] as const;

  async function tampered(
    run: World,
    change: Partial<Extract<PaymentMarker, { rail: 'eip3009' }>>,
  ): Promise<OrderRecord> {
    const record = await signedNotSent(run);
    return { ...record, marker: { ...markerOf(record), ...change } };
  }

  it.each(BAD_MARKERS)(
    'refuses a retry and a switch of a record with %s, asking no wallet',
    async (_name, change) => {
      const run = await world();
      const record = await tampered(run, change);
      const signedBefore = run.walletState.signed.length;
      expect(failed(await retryWithEip3009(record, run.wallet, run.fresh, run.deps)).reason).toBe(
        'not_payable',
      );
      expect(
        failed(await switchWalletWithEip3009(record, run.wallet, run.fresh, run.deps)).reason,
      ).toBe('not_payable');
      expect(run.walletState.signed).toHaveLength(signedBefore);
      expect(run.walletState.sent).toEqual([]);
    },
  );

  it.each(BAD_MARKERS)(
    'proves nothing and ends nothing for a record with %s, with no read',
    async (_name, change) => {
      const run = await world();
      const record = await tampered(run, change);
      run.chain.calls.length = 0;
      expect(await eip3009EndProof(record, run.deps)).toBe('never');
      expect(await endEip3009Order(record, run.deps)).toMatchObject({
        ended: false,
        proof: 'never',
      });
      expect(await watchEip3009Payment(record, run.deps)).toMatchObject({ state: 'waiting' });
      expect(run.chain.calls).toEqual([]);
      expect((await stored(run)).state).toBe('paying');
    },
  );

  it.each(BAD_MARKERS)(
    'refuses a resend when the stored record holds %s',
    async (_name, change) => {
      const run = await world();
      const handle = await declinedHandle(run);
      const lying: OrderStore = new Proxy(store, {
        get(target, property, receiver) {
          if (property === 'get') {
            return async (orderId: string) => {
              const record = await target.get(orderId);
              return record === undefined
                ? undefined
                : { ...record, marker: { ...markerOf(record), ...change } };
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      expect(
        failed(await resendWithEip3009(handle, run.wallet, { ...run.deps, store: lying })).reason,
      ).toBe('not_payable');
      expect(run.walletState.sent).toEqual([]);
    },
  );
});

describe('review round 5: refusals after a signature keep the attempt live', () => {
  async function cancelled(run: World, record: OrderRecord): Promise<OrderRecord> {
    const written = await store.update(record.orderId, record.version, {
      status: { status: 'cancelled', at: NOW },
    });
    if (!written.ok) {
      throw new Error(written.reason);
    }
    return written.record;
  }

  it.each(['retry', 'switch', 'resend'] as const)(
    'a %s on an order the store cancelled after the signature is not_payable with afterMarker',
    async (path) => {
      const run = await world();
      run.walletState.sendError = { code: 4001 };
      const declined = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
      run.walletState.sendError = undefined;
      const resend = declined.resend;
      if (resend === undefined) {
        throw new Error('no resend');
      }
      const record = await cancelled(run, await stored(run));
      const marker = markerOf(record);
      const other = fakeWallet(OTHER_SECRET, BASE_SEPOLIA.evmChainId ?? 0);
      let result: Eip3009PayResult;
      if (path === 'retry') {
        result = await retryWithEip3009(record, run.wallet, run.fresh, run.deps);
      } else if (path === 'switch') {
        result = await switchWalletWithEip3009(record, other.wallet, run.fresh, run.deps);
      } else {
        result = await resendWithEip3009(resend, run.wallet, run.deps);
      }
      expect(result).toMatchObject({
        ok: false,
        reason: 'not_payable',
        afterMarker: true,
        attemptId: marker.attemptId,
      });
      expect(run.walletState.sent).toEqual([]);
      expect(other.state.signed).toEqual([]);
      expect(markerOf(await stored(run)).signed).toBe(true);
    },
  );

  it('a retry on a cancelled order whose marker never signed is plain not_payable', async () => {
    const run = await world();
    const record = await cancelled(run, await signedNotSent(run));
    const marker = markerOf(record);
    const unsigned: OrderRecord = {
      ...record,
      marker: { ...marker, signed: undefined, signature: undefined, txHash: undefined },
    };
    const before = run.walletState.signed.length;
    const result = failed(await retryWithEip3009(unsigned, run.wallet, run.fresh, run.deps));
    expect(result.reason).toBe('not_payable');
    expect(result.afterMarker).toBeUndefined();
    expect(run.walletState.signed.length).toBe(before);
  });

  it('a resend refused on a paid order does not claim a live attempt', async () => {
    const run = await world();
    run.walletState.sendError = { code: 4001 };
    const declined = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    run.walletState.sendError = undefined;
    const resend = declined.resend;
    if (resend === undefined) {
      throw new Error('no resend');
    }
    const current = await stored(run);
    const written = await store.update(current.orderId, current.version, {
      state: 'paid',
      paidTx: `0x${'9'.repeat(64)}`,
      paidAt: NOW,
    });
    expect(written.ok).toBe(true);
    const result = failed(await resendWithEip3009(resend, run.wallet, run.deps));
    expect(result.reason).toBe('not_payable');
    expect(result.afterMarker).toBeUndefined();
  });

  it('stores the retry signature over the old one, and its resend sends (X27)', async () => {
    const run = await world();
    const before = await signedNotSent(run);
    const oldSignature = markerOf(before).signature;
    run.chain.latest.timestamp = NOW + 500;
    run.walletState.sendError = { code: 4001 };
    const declined = failed(await retryWithEip3009(before, run.wallet, run.fresh, run.deps));
    run.walletState.sendError = undefined;
    expect(declined.reason).toBe('send_declined');
    const marker = markerOf(await stored(run));
    expect(marker.signature).toBeDefined();
    expect(marker.signature).not.toBe(oldSignature);
    const resend = declined.resend;
    if (resend === undefined) {
      throw new Error('no resend');
    }
    expect(await resendWithEip3009(resend, run.wallet, run.deps)).toMatchObject({ ok: true });
    expect(run.walletState.sent.length).toBe(1);
  });

  it('answers never with no read for an ended order with no marker (X9)', async () => {
    const run = await world();
    const ended = await endEip3009Order(run.record, run.deps);
    expect(ended).toMatchObject({ ended: true, record: { state: 'ended-unpaid' } });
    run.chain.calls.length = 0;
    expect(await eip3009EndProof(ended.record, run.deps)).toBe('never');
    expect(run.chain.calls).toEqual([]);
  });

  it('a decline after another tab cleared the marker is a plain conflict: no attempt is live (X12)', async () => {
    const run = await world();
    let attemptId = '';
    run.walletState.onSign = async () => {
      const current = await stored(run);
      attemptId = markerOf(current).attemptId;
      await store.clearMarker(current.orderId, current.version, attemptId, 'ordered');
    };
    run.walletState.signError = { code: 4001 };
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(result.reason).toBe('conflict');
    expect(attemptId).not.toBe('');
    expect(result.afterMarker).toBeUndefined();
    expect(result.attemptId).toBeUndefined();
    expect(result.record?.state).toBe('ordered');
  });

  it('sends no new receipt for a paid order whose receipt names another hash (X13)', async () => {
    const run = await world();
    const first = await sent(run);
    expect(first.record.receiptWrap).toBeDefined();
    const other = `0x${'7'.repeat(64)}`;
    const written = await store.update(first.record.orderId, first.record.version, {
      state: 'paid',
      paidTx: other,
      paidAt: NOW,
    });
    if (!written.ok) {
      throw new Error(written.reason);
    }
    const before = run.relays.published.length;
    const watched = await watchEip3009Payment(written.record, run.deps);
    expect(watched.state).toBe('paid');
    expect(run.relays.published.length).toBe(before);
  });
});

describe('review round 6: whether a refusal leaves an attempt live is read from the record it returns', () => {
  /** A wallet's own paid attempt is on the record, not on the stale copy the caller holds. */
  async function staleAfterSigned(run: World): Promise<void> {
    await signedNotSent(run);
  }

  it('T1: a retry of a marker that looked unsigned but was signed meanwhile gives conflict, live', async () => {
    const run = await world();
    let snapshot: OrderRecord | undefined;
    run.walletState.onSign = async () => {
      snapshot = await stored(run);
    };
    run.walletState.sendError = { code: 4001 };
    failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    run.walletState.sendError = undefined;
    run.walletState.onSign = undefined;
    if (snapshot === undefined) {
      throw new Error('no snapshot');
    }
    expect(markerOf(snapshot).signed).toBeUndefined();
    const result = failed(await retryWithEip3009(snapshot, run.wallet, run.fresh, run.deps));
    const marker = markerOf(await stored(run));
    expect(result).toMatchObject({
      reason: 'conflict',
      afterMarker: true,
      attemptId: marker.attemptId,
    });
    expect(marker.signed).toBe(true);
  });

  it('T2: a first attempt on a stale ordered copy of an order another tab signed is live', async () => {
    const run = await world();
    await staleAfterSigned(run);
    const signedBefore = run.walletState.signed.length;
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    const marker = markerOf(await stored(run));
    expect(result).toMatchObject({
      reason: 'not_payable',
      afterMarker: true,
      attemptId: marker.attemptId,
    });
    expect(run.walletState.signed.length).toBe(signedBefore);
  });

  it('T3: a used nonce found on a stale copy follows the attempt already there, never freezes it', async () => {
    const run = await world();
    const { hash } = await sent(run);
    const before = await stored(run);
    land(run.chain, {
      hash,
      authorizer: run.walletState.account,
      nonce: before.reference,
      payee: PAYEE,
      value: PRICE,
      block: 105,
    });
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    const after = await stored(run);
    expect(result).toMatchObject({
      reason: 'still_waiting',
      afterMarker: true,
      attemptId: markerOf(after).attemptId,
    });
    expect(markerOf(after).usedAtStart).toBeUndefined();
    expect(markerOf(after)).toEqual(markerOf(before));
  });

  it('a used nonce with no attempt on the record is still frozen as nonce_used, not live', async () => {
    const run = await world();
    run.chain.used.add(usedKey(run.walletState.account, run.record.reference));
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(result.reason).toBe('nonce_used');
    expect(result.afterMarker).toBeUndefined();
    expect(markerOf(await stored(run)).usedAtStart).toBe(true);
  });

  it('every entry refusing over a signed live marker carries afterMarker and its attemptId', async () => {
    const entries: {
      name: string;
      run: (run: World, current: OrderRecord) => Promise<Eip3009PayResult>;
    }[] = [
      {
        name: 'pay on a stale ordered copy',
        run: async (run) => await payWithEip3009(run.record, run.wallet, run.fresh, run.deps),
      },
      {
        name: 'pay on the paying record',
        run: async (run, current) => await payWithEip3009(current, run.wallet, run.fresh, run.deps),
      },
      {
        name: 'retry from another account',
        run: async (run, current) => {
          const other = fakeWallet(OTHER_SECRET, BASE_SEPOLIA.evmChainId ?? 0);
          return await retryWithEip3009(current, other.wallet, run.fresh, run.deps);
        },
      },
      {
        name: 'retry on a cancelled order',
        run: async (run, current) => {
          const closed = { ...current, status: { status: 'cancelled' as const, at: NOW } };
          return await retryWithEip3009(closed, run.wallet, run.fresh, run.deps);
        },
      },
      {
        name: 'switch before the proof',
        run: async (run, current) => {
          const other = fakeWallet(OTHER_SECRET, BASE_SEPOLIA.evmChainId ?? 0);
          return await switchWalletWithEip3009(current, other.wallet, run.fresh, run.deps);
        },
      },
      {
        name: 'retry with the chain read down',
        run: async (run, current) => {
          run.chain.down.add('eth_call');
          const result = await retryWithEip3009(current, run.wallet, run.fresh, run.deps);
          run.chain.down.delete('eth_call');
          return result;
        },
      },
    ];
    for (const entry of entries) {
      store = new OrderStore(new MemoryOrderBackend());
      const run = await world();
      const current = await signedNotSent(run);
      const result = await entry.run(run, current);
      const marker = markerOf(await stored(run));
      expect(result.ok, entry.name).toBe(false);
      expect(result, entry.name).toMatchObject({ afterMarker: true, attemptId: marker.attemptId });
      expect(marker.signed, entry.name).toBe(true);
    }
  });

  it('Y18: a marker write lost to another tab on a first attempt is conflict, not not_payable', async () => {
    const run = await world();
    const real = run.deps.store;
    const original = real.setMarker.bind(real);
    real.setMarker = async (...args) => {
      const current = await real.get(run.record.orderId);
      await real.update(run.record.orderId, current?.version ?? 0, {
        acknowledgedRelays: [...(current?.acknowledgedRelays ?? []), 'wss://more.example.com'],
      });
      return original(...args);
    };
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(result.reason).toBe('conflict');
    expect(run.walletState.signed).toEqual([]);
  });

  it.each(['retry', 'switch'] as const)(
    'Y18: a %s whose marker write loses to a bump during step 2 is conflict, live',
    async (kind) => {
      const run = await world();
      const current = await signedNotSent(run);
      const attemptId = markerOf(current).attemptId;
      let bumped = false;
      const client = run.deps.client;
      const deps: Eip3009PayDeps = {
        ...run.deps,
        client: {
          request: async (args) => {
            if (!bumped && args.method === 'eth_call') {
              bumped = true;
              const now = await stored(run);
              await store.update(now.orderId, now.version, {
                acknowledgedRelays: [...now.acknowledgedRelays, 'wss://more.example.com'],
              });
            }
            return await client.request(args);
          },
        },
      };
      let result: Eip3009PayResult;
      if (kind === 'retry') {
        result = await retryWithEip3009(current, run.wallet, run.fresh, deps);
      } else {
        const other = fakeWallet(OTHER_SECRET, BASE_SEPOLIA.evmChainId ?? 0);
        run.chain.tokens.set(other.state.account, PRICE * 2n);
        run.chain.native.set(other.state.account, 10n ** 18n);
        const validBefore = Number(markerOf(current).validBefore);
        run.chain.finalized = { number: 1100, timestamp: validBefore + 1 };
        run.chain.latest = { number: 1200, timestamp: validBefore + 60 };
        result = await switchWalletWithEip3009(current, other.wallet, run.fresh, deps);
      }
      expect(bumped).toBe(true);
      expect(result).toMatchObject({ ok: false, reason: 'conflict', afterMarker: true, attemptId });
    },
  );
});

describe('review round 7: a refusal is built in one place only', () => {
  it('builds afterMarker in exactly one place in the source, and adds it to no refusal afterwards', () => {
    const source = readFileSync(new URL('../../src/buyer/eip3009-pay.ts', import.meta.url), 'utf8');
    expect(source.match(/afterMarker: /g) ?? []).toHaveLength(1);
    expect(source.match(/\blive\(/g) ?? []).toHaveLength(0);
    expect(source.match(/\.\.\.[^,}]*\), attemptId/g) ?? []).toHaveLength(0);
  });

  it('PA: an approved signature after another tab ended the unsigned attempt is a plain conflict', async () => {
    const run = await world();
    run.walletState.onSign = async () => {
      const current = await stored(run);
      const ended = await endEip3009Order(current, run.deps);
      expect(ended.ended).toBe(true);
    };
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(result.reason).toBe('conflict');
    expect(result.afterMarker).toBeUndefined();
    expect(result.attemptId).toBeUndefined();
    expect(result.record?.state).toBe('ended-unpaid');
    expect((await stored(run)).state).toBe('ended-unpaid');
    expect(run.walletState.sent).toEqual([]);
  });

  it('PB: a decline after another tab signed its own attempt follows THAT attempt', async () => {
    const run = await world();
    run.walletState.onSign = async () => {
      const current = await stored(run);
      const marker = markerOf(current);
      const cleared = await store.clearMarker(
        current.orderId,
        current.version,
        marker.attemptId,
        'ordered',
      );
      if (!cleared.ok) {
        throw new Error(cleared.reason);
      }
      const next = { ...marker, attemptId: 'other-tab' };
      const set = await store.setMarker(cleared.record.orderId, cleared.record.version, next, NOW);
      if (!set.ok) {
        throw new Error(set.reason);
      }
      const signed = await store.updateMarker(set.record.orderId, set.record.version, 'other-tab', {
        ...next,
        signed: true,
        signature: `0x${'ab'.repeat(65)}`,
      });
      if (!signed.ok) {
        throw new Error(signed.reason);
      }
    };
    run.walletState.signError = { code: 4001 };
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(result).toMatchObject({ reason: 'conflict', afterMarker: true, attemptId: 'other-tab' });
    expect(markerOf(await stored(run)).attemptId).toBe('other-tab');
  });

  it('a used nonce on a record another tab froze meanwhile is nonce_used, not followed (Z4)', async () => {
    const run = await world();
    run.chain.used.add(usedKey(run.walletState.account, run.record.reference));
    const real = run.deps.store;
    const original = real.setMarker.bind(real);
    let raced = false;
    real.setMarker = async (...args) => {
      if (!raced) {
        raced = true;
        const frozen = await original(...args);
        if (!frozen.ok) {
          throw new Error(frozen.reason);
        }
        return { ok: false, reason: 'conflict' };
      }
      return original(...args);
    };
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    real.setMarker = original;
    expect(raced).toBe(true);
    expect(result.reason).toBe('nonce_used');
    expect(result.afterMarker).toBeUndefined();
    expect(markerOf(await stored(run)).usedAtStart).toBe(true);
  });

  it('a used nonce whose request write is refused is still nonce_used (Z5)', async () => {
    const run = await world();
    run.chain.used.add(usedKey(run.walletState.account, run.record.reference));
    const real = run.deps.store;
    const original = real.update.bind(real);
    real.update = async () => ({ ok: false, reason: 'exclusion', holder: 'other' });
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    real.update = original;
    expect(result.reason).toBe('nonce_used');
    expect((await stored(run)).marker).toBeUndefined();
    expect(run.walletState.signed).toEqual([]);
  });

  it('a used nonce with the finalized block unreadable is nonce_used, never rpc_error (Z6)', async () => {
    const run = await world();
    run.chain.used.add(usedKey(run.walletState.account, run.record.reference));
    run.chain.failIf = (method, params) => tagOf(method, params) === 'finalized';
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(result.reason).toBe('nonce_used');
    expect(result.afterMarker).toBeUndefined();
    expect((await stored(run)).marker).toBeUndefined();
    expect(run.walletState.signed).toEqual([]);
  });

  it('an end whose clear is lost after an over proof is not ended (Z21)', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    run.chain.finalized = { number: 1100, timestamp: Number(markerOf(record).validBefore) + 1 };
    const real = run.deps.store;
    const original = real.clearMarker.bind(real);
    real.clearMarker = async () => ({ ok: false, reason: 'conflict' });
    const ended = await endEip3009Order(record, run.deps);
    real.clearMarker = original;
    expect(ended).toMatchObject({ ended: false, proof: 'over' });
    expect((await stored(run)).state).toBe('paying');
  });
});

describe('review round 8', () => {
  it('stores the hash a wallet returns in upper case as lowercase, and the watch finds it paid', async () => {
    const run = await world();
    const upper = `0x${'AB'.repeat(32)}`;
    run.walletState.nextHash = () => upper;
    const result = await payWithEip3009(run.record, run.wallet, run.fresh, run.deps);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const lower = upper.toLowerCase();
    expect(result.hash).toBe(lower);
    const record = await stored(run);
    expect(markerOf(record).txHash).toBe(lower);
    land(run.chain, {
      hash: lower,
      authorizer: run.walletState.account,
      nonce: record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 995,
    });
    run.chain.safe = { number: 995, timestamp: NOW };
    expect(await watchEip3009Payment(record, run.deps)).toMatchObject({
      state: 'paid',
      record: { state: 'paid', paidTx: lower },
    });
  });

  it('keeps the resend handle when the wallet refuses to switch back, and it sends next time', async () => {
    const run = await world();
    run.walletState.sendError = { code: 4001 };
    const declined = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(declined.reason).toBe('send_declined');
    run.walletState.sendError = undefined;
    const first = declined.resend;
    if (first === undefined) {
      throw new Error('no resend');
    }
    run.walletState.chainId = 1;
    run.walletState.switchError = { code: 4001 };
    const refused = failed(await resendWithEip3009(first, run.wallet, run.deps));
    expect(refused.reason).toBe('wrong_chain_after_sign');
    expect(run.walletState.sent).toEqual([]);
    const again = refused.resend;
    if (again === undefined) {
      throw new Error('no resend after the failed switch back');
    }
    run.walletState.switchError = undefined;
    expect(await resendWithEip3009(again, run.wallet, run.deps)).toMatchObject({ ok: true });
    expect(run.walletState.sent.length).toBe(1);
  });

  it('notes no receiptTx when the receipt write is lost, and a later watch publishes the receipt', async () => {
    const run = await world();
    let lost = false;
    const losing = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'update') {
          return async (...args: Parameters<typeof store.update>) => {
            const [, , patch] = args;
            if (!lost && 'receiptWrap' in patch) {
              lost = true;
              return { ok: false, reason: 'conflict' } as const;
            }
            return target.update(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await payWithEip3009(run.record, run.wallet, run.fresh, {
      ...run.deps,
      store: losing,
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(lost).toBe(true);
    const record = await stored(run);
    expect(record.receiptWrap).toBeUndefined();
    expect(markerOf(record).receiptTx).toBeUndefined();
    const before = run.relays.published.length;
    const watched = await watchEip3009Payment(record, run.deps);
    expect(run.relays.published.length).toBe(before + 1);
    expect(watched.record.receiptWrap).toBeDefined();
    expect(markerOf(watched.record).receiptTx).toBe(result.hash);
  });

  it('marks a signature whose write was refused as signed, not sent', async () => {
    const run = await world();
    run.walletState.onSign = async () => {
      const current = await stored(run);
      await store.clearMarker(
        current.orderId,
        current.version,
        markerOf(current).attemptId,
        'ordered',
      );
    };
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(result.reason).toBe('conflict');
    expect(result.signedNotSent).toBe(true);
    expect(run.walletState.sent).toEqual([]);
  });

  it('adds no signedNotSent to a conflict before any signature', async () => {
    const run = await world();
    run.walletState.onSign = async () => {
      const current = await stored(run);
      await store.clearMarker(
        current.orderId,
        current.version,
        markerOf(current).attemptId,
        'ordered',
      );
    };
    run.walletState.signError = { code: 4001 };
    const result = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(result.reason).toBe('conflict');
    expect(result.signedNotSent).toBeUndefined();
  });

  it('overrides no reason on a refusal after it is built', () => {
    const source = readFileSync(new URL('../../src/buyer/eip3009-pay.ts', import.meta.url), 'utf8');
    expect(source.match(/\.\.\.[^,}]*, reason: /g) ?? []).toHaveLength(0);
    expect(source.match(/signedNotSent: true as const/g) ?? []).toHaveLength(1);
  });
});

describe('review round 9: a strict wallet and chain', () => {
  const CURVE_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

  it.each([
    ['a bare recovery id (v 0/1)', { answerBareV: true }],
    ['the high-s twin', { answerHighS: true }],
  ] as const)(
    'pays with the canonical signature when the wallet answers %s',
    async (_label, form) => {
      const run = await world();
      Object.assign(run.walletState, form);
      const result = await payWithEip3009(run.record, run.wallet, run.fresh, run.deps);
      expect(result).toMatchObject({ ok: true });
      const signature = markerOf(await stored(run)).signature ?? '';
      const v = Number.parseInt(signature.slice(130, 132), 16);
      expect([27, 28]).toContain(v);
      expect(BigInt(`0x${signature.slice(66, 130)}`) <= CURVE_N / 2n).toBe(true);
      const [call] = run.walletState.sent;
      expect(call?.data).toContain(signature.slice(2));
      const estimate = run.chain.calls.find((entry) => entry.method === 'eth_estimateGas');
      expect(String((estimate?.params[0] as { data: string }).data)).toContain(signature.slice(2));
    },
  );

  it('asks the typed-data prompt for the connected payer, never another address', async () => {
    const run = await world();
    expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
      ok: true,
    });
    expect(run.walletState.signedFor).toEqual([run.walletState.account]);
  });

  it('pays from the first account a wallet holding two answers', async () => {
    const run = await world();
    run.walletState.extraAccounts = [addressOf(OTHER_SECRET)];
    expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
      ok: true,
    });
    expect(markerOf(await stored(run)).authorizer).toBe(run.walletState.account.toLowerCase());
    expect(run.walletState.sent[0]?.from.toLowerCase()).toBe(run.walletState.account.toLowerCase());
  });

  it('follows another tab whose marker won the freeze race: still_waiting, never frozen', async () => {
    const run = await world();
    run.chain.used.add(usedKey(run.walletState.account, run.record.reference));
    const other: Eip3009Marker = {
      rail: 'eip3009',
      attemptId: 'other-tab',
      setAt: NOW,
      authorizer: run.walletState.account.toLowerCase(),
      floorBlock: '950',
      validBefore: String(NOW + 900),
      signed: true,
      signature: `0x${'ab'.repeat(65)}`,
    };
    let raced = false;
    const racing: OrderStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'setMarker') {
          return async (...args: Parameters<OrderStore['setMarker']>) => {
            const marker = args[2];
            if (!raced && marker.rail === 'eip3009' && marker.usedAtStart === true) {
              raced = true;
              const current = await target.get(args[0]);
              if (current !== undefined) {
                await target.setMarker(current.orderId, current.version, other, NOW);
              }
              return { ok: false, reason: 'conflict' } as const;
            }
            return await target.setMarker(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await payWithEip3009(run.record, run.wallet, run.fresh, {
      ...run.deps,
      store: racing,
    });
    expect(raced).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      reason: 'still_waiting',
      afterMarker: true,
      attemptId: 'other-tab',
    });
    expect(markerOf(await stored(run)).usedAtStart).toBeUndefined();
  });

  it.each(['completed', 'refunded'] as const)(
    'closes the watch of a %s order, with or without paidTx, reading nothing',
    async (state) => {
      const run = await world();
      for (const paidTx of [undefined, `0x${'7'.repeat(64)}`]) {
        const record: OrderRecord = {
          ...run.record,
          state,
          ...(paidTx === undefined ? {} : { paidTx }),
        };
        const before = run.chain.calls.length;
        const watched = await watchEip3009Payment(record, run.deps);
        expect(watched).toMatchObject({ state: 'closed' });
        expect(run.chain.calls.length).toBe(before);
      }
    },
  );

  it('publishes no receipt and stores no receiptWrap for a hash it could not store', async () => {
    const run = await world();
    const refusing: OrderStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'updateMarker') {
          return async (...args: Parameters<OrderStore['updateMarker']>) => {
            const next = args[3];
            if (next.rail === 'eip3009' && next.txHash !== undefined) {
              return { ok: false, reason: 'conflict' } as const;
            }
            return await target.updateMarker(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const publishedBefore = run.relays.published.length;
    const result = await payWithEip3009(run.record, run.wallet, run.fresh, {
      ...run.deps,
      store: refusing,
    });
    expect(result).toMatchObject({ ok: true, hashUnsaved: true });
    const record = await stored(run);
    expect(record.receiptWrap).toBeUndefined();
    expect(markerOf(record).txHash).toBeUndefined();
    expect(run.relays.published.length).toBe(publishedBefore);
  });

  it('throws when the chain time cannot be read, never answers 0', async () => {
    const run = await world();
    run.chain.down.add('eth_getBlockByNumber');
    await expect(readEip3009ChainTime(run.chain.client)).rejects.toThrow(/could not be read/);
  });

  it('writes paidAt when the watch finds the payment paid', async () => {
    const run = await world();
    const result = await payWithEip3009(run.record, run.wallet, run.fresh, run.deps);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    land(run.chain, {
      hash: result.hash,
      authorizer: run.walletState.account,
      nonce: run.record.reference,
      payee: PAYEE,
      value: PRICE,
      block: 980,
    });
    const watched = await watchEip3009Payment(await stored(run), run.deps);
    expect(watched).toMatchObject({ state: 'paid' });
    expect((await stored(run)).paidAt).toBe(NOW + 30);
  });
});

describe('review round 10: a pinned read, a wallet that cannot name its chain, the proof edge', () => {
  it('reads the proof pinned at F only: a node that does not hold another block fails the read', async () => {
    const run = await world();
    const record = await signedNotSent(run);
    const validBefore = Number(markerOf(record).validBefore);
    run.chain.finalized = { number: 1100, timestamp: validBefore + 1 };
    run.chain.latest = { number: 1200, timestamp: validBefore + 60 };
    expect(await eip3009EndProof(record, run.deps)).toBe('over');
    expect(run.chain.pinnedReads).toEqual([blockHashOf(1100)]);
  });

  it('refuses at connect, before anything is composed, when the wallet cannot name its chain', async () => {
    const run = await world();
    run.walletState.chainIdError = new Error('chainId unavailable');
    expect(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps)).toMatchObject({
      ok: false,
      reason: 'wrong_chain',
    });
    const record = await stored(run);
    expect(record.marker).toBeUndefined();
    expect(storedEip3009Request(record)).toBeUndefined();
    expect(run.walletState.signed).toEqual([]);
    expect(run.walletState.sent).toEqual([]);
  });

  it('sends nothing at step 6 when the wallet cannot name its chain, and the resend works after', async () => {
    const run = await world();
    run.walletState.onSign = async () => {
      run.walletState.chainIdError = new Error('chainId unavailable');
    };
    const wrong = failed(await payWithEip3009(run.record, run.wallet, run.fresh, run.deps));
    expect(wrong).toMatchObject({ reason: 'wrong_chain_after_sign', afterMarker: true });
    expect(run.walletState.sent).toEqual([]);
    const resend = wrong.resend;
    if (resend === undefined) {
      throw new Error('no resend');
    }
    run.walletState.chainIdError = undefined;
    expect(await resendWithEip3009(resend, run.wallet, run.deps)).toMatchObject({ ok: true });
    expect(run.walletState.sent.length).toBe(1);
  });

  it.each([
    ['at validBefore', 0],
    ['one second before validBefore', -1],
  ])('answers too_early with F %s', async (_label, offset) => {
    const run = await world();
    const record = await signedNotSent(run);
    const validBefore = Number(markerOf(record).validBefore);
    run.chain.finalized = { number: 1100, timestamp: validBefore + offset };
    run.chain.latest = { number: 1200, timestamp: validBefore + 60 };
    expect(await eip3009EndProof(record, run.deps)).toBe('too_early');
    expect(await endEip3009Order(record, run.deps)).toMatchObject({ ended: false });
  });
});

describe('review round 11: an end that loses to another tab', () => {
  it('pins the send margin and the authorization window', () => {
    expect(SEND_MARGIN_SECS).toBe(120);
    expect(EIP3009_VALID_SECS).toBe(15 * 60);
  });

  it('does not end a stale unsigned record whose signature another tab stored meanwhile', async () => {
    const run = await world();
    run.walletState.signError = { code: 4001 };
    await payWithEip3009(run.record, run.wallet, run.fresh, run.deps);
    run.walletState.signError = undefined;
    const ordered = await stored(run);
    const set = await store.setMarker(ordered.orderId, ordered.version, {
      rail: 'eip3009',
      attemptId: 'tab-a',
      setAt: NOW,
      authorizer: run.walletState.account,
      floorBlock: '950',
      validBefore: String(NOW + 930),
    });
    if (!set.ok) {
      throw new Error(set.reason);
    }
    const signedWrite = await store.updateMarker(set.record.orderId, set.record.version, 'tab-a', {
      ...markerOf(set.record),
      signed: true,
      signature: `0x${'ab'.repeat(65)}`,
    });
    expect(signedWrite.ok).toBe(true);
    const ended = await endEip3009Order(set.record, run.deps);
    expect(ended.ended).toBe(false);
    expect((await stored(run)).state).toBe('paying');
  });

  it('does not end a stale ordered record once another tab set a marker', async () => {
    const run = await world();
    run.walletState.signError = { code: 4001 };
    await payWithEip3009(run.record, run.wallet, run.fresh, run.deps);
    run.walletState.signError = undefined;
    const stale = await stored(run);
    expect(stale.state).toBe('ordered');
    const set = await store.setMarker(stale.orderId, stale.version, {
      rail: 'eip3009',
      attemptId: 'tab-b',
      setAt: NOW,
      authorizer: run.walletState.account,
      floorBlock: '950',
      validBefore: String(NOW + 930),
    });
    if (!set.ok) {
      throw new Error(set.reason);
    }
    const ended = await endEip3009Order(stale, run.deps);
    expect(ended.ended).toBe(false);
    expect((await stored(run)).state).toBe('paying');
  });
});

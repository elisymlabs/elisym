/**
 * Canned offers and views for the checkout's look: the dev-only fixture page
 * (`bun scripts/dev.ts fixtures`) and the UI tests render `Checkout` with
 * these. Never part of the build.
 */
import { type OfferWarning, type TrustLevel, parseCaip19 } from '@elisym/commerce';
import type { LoadedOffer, PricedPayout } from '@elisym/commerce/buyer';
import {
  type Asset,
  PATHUSD_TEMPO,
  USDCE_TEMPO_MAINNET,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
} from '@elisym/pay-core';
import type { Purchase, PurchaseStatus } from '../../src/app/history';
import { type About, type View, payoutPaying } from '../../src/app/session';
import { nowSeconds } from '../../src/app/ui/clock';
import type { PurchasesSource } from '../../src/app/ui/PurchasesStep';

export type ReadyOffer = Extract<LoadedOffer, { ok: true }>;
export type OfferView = Extract<View, { kind: 'offer' }>;
export type CannedPayout = 'solana-devnet' | 'solana-mainnet' | 'tempo-devnet' | 'tempo-mainnet';

const COINS: Record<CannedPayout, { caip2: string; asset: Asset; address: string }> = {
  'solana-devnet': {
    caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    asset: USDC_SOLANA_DEVNET,
    address: '9vSzxkCJiEuGwYnJGo17XsofAANM5GMzBg5rJquejs7o',
  },
  'solana-mainnet': {
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    asset: USDC_SOLANA_MAINNET,
    address: '9vSzxkCJiEuGwYnJGo17XsofAANM5GMzBg5rJquejs7o',
  },
  'tempo-devnet': {
    caip2: 'eip155:42431',
    asset: PATHUSD_TEMPO,
    address: '0x5696da2cecea22f127948458382ac2c59bc8e4bb',
  },
  'tempo-mainnet': {
    caip2: 'eip155:4217',
    asset: USDCE_TEMPO_MAINNET,
    address: '0x5696da2cecea22f127948458382ac2c59bc8e4bb',
  },
};

/** 49 of the coin, in its subunits. */
function priced(kind: CannedPayout): PricedPayout {
  const coin = COINS[kind];
  const namespace = coin.caip2.startsWith('eip155:') ? 'erc20' : 'token';
  const caip19 = parseCaip19(`${coin.caip2}/${namespace}:${coin.asset.mint ?? ''}`);
  if (caip19 === undefined) {
    throw new Error(`no registry coin for ${kind}`);
  }
  return {
    target: { caip19, address: coin.address, walletSigned: true },
    amount: 49n * 10n ** BigInt(coin.asset.decimals),
  };
}

export interface CannedOfferOptions {
  level?: TrustLevel;
  domain?: string;
  name?: string;
  title?: string;
  summary?: string;
  payouts?: readonly CannedPayout[];
  confirm?: OfferWarning[];
  notices?: OfferWarning[];
}

export function cannedOffer(options: CannedOfferOptions = {}): ReadyOffer {
  const payouts = (options.payouts ?? ['solana-devnet']).map(priced);
  const level = options.level ?? 'A';
  const domain = options.domain ?? (level === 'C' ? undefined : 'shop.example');
  const storePubkey = 'a'.repeat(64);
  return {
    ok: true,
    offer: {
      level,
      ...(domain === undefined ? {} : { domain }),
      storePubkey,
      ownerPubkey: 'b'.repeat(64),
      profile: options.name === undefined ? { name: 'Demo Shop' } : { name: options.name },
      product: {
        storePubkey,
        d: 'course-101',
        title: options.title ?? 'Agents 101',
        ...(options.summary === undefined
          ? { summary: 'Twelve lessons on building paying agents.' }
          : { summary: options.summary }),
        description: 'Twelve lessons.',
        price: { amount: '49', currency: 'USD' },
        images: [],
        topics: [],
        visibility: 'on-sale',
        listedOnElisym: false,
        endpoints: [],
        accept: payouts.map((payout) => payout.target.caip19.id),
        createdAt: 1_750_000_000,
      },
      payouts: payouts.map((payout) => payout.target),
      paytoCreatedAt: 1_750_000_000,
      warnings: [...(options.confirm ?? []), ...(options.notices ?? [])],
    },
    productAddress: `30402:${storePubkey}:course-101`,
    payouts,
    confirm: options.confirm ?? [],
    notices: options.notices ?? [],
    hints: [],
    relays: [],
    snapshotAt: 1_750_000_000,
  };
}

/** The offer as the session shows it, first payout chosen, unless `overrides` say otherwise. */
export function offerView(offer: ReadyOffer, overrides: Partial<OfferView> = {}): OfferView {
  const payoutIndex = overrides.payoutIndex ?? 0;
  const payout = offer.payouts[payoutIndex] ?? offer.payouts[0];
  if (payout === undefined) {
    throw new Error('an offer without a payout');
  }
  return {
    kind: 'offer',
    offer,
    payout,
    payouts: offer.payouts,
    payoutIndex,
    wallets: [{ name: 'Phantom' }, { name: 'Solflare' }],
    askEmail: false,
    email: '',
    ...overrides,
  };
}

/** What a progress view of `offer` is about: its store and product. */
export function aboutOf(offer: ReadyOffer, email?: string): About {
  const { profile, level, domain, product } = offer.offer;
  return {
    store: { name: profile.name, level, ...(domain === undefined ? {} : { domain }) },
    product: {
      title: product.title,
      ...(product.summary === undefined ? {} : { summary: product.summary }),
      price: product.price,
    },
    ...(email === undefined ? {} : { email }),
  };
}

type WaitingView = Extract<View, { kind: 'waiting_payment' }>;

/** A Solana wait for `paying`, nothing decided yet; `overrides` say otherwise. */
export function waitingView(
  about: About,
  paying: WaitingView['paying'],
  overrides: Partial<WaitingView> = {},
): WaitingView {
  return {
    kind: 'waiting_payment',
    about,
    ...(paying === undefined ? {} : { paying }),
    asset: paying?.asset ?? USDC_SOLANA_DEVNET,
    canRetry: false,
    wallets: [],
    tempo: false,
    signed: true,
    followOnly: false,
    unserved: false,
    ...overrides,
  };
}

/** A dev-only start for the fixture page: what is open, and the hint at once. */
export interface CannedProps {
  initialListOpen?: boolean;
  hintAfterMs?: number;
  unansweredHintMs?: number;
  purchases?: PurchasesSource;
  initialPurchasesOpen?: boolean;
  initialOpened?: string;
  finishFillMs?: number;
  finishWaitMs?: number;
}

/** A fixture drawn as `view`, then as `next` once mounted (a live transition to look at). */
export interface CannedView {
  name: string;
  view: View | undefined;
  props?: CannedProps;
  next?: View;
}

const CANNED_STATUSES: readonly PurchaseStatus[] = [
  'delivered',
  'refunded',
  'waiting_store',
  'paying',
  'blocked',
  'cancelled_paid',
];

/** `count` purchases of mixed states, newest first (the fixture page and the UI tests). */
export function cannedPurchases(count: number, now = nowSeconds()): Purchase[] {
  const paying = payoutPaying(priced('solana-devnet'));
  return Array.from({ length: count }, (_, index) => {
    const status = CANNED_STATUSES[index % CANNED_STATUSES.length] ?? 'delivered';
    const orderId = `${index.toString(16).padStart(8, '0')}-c7e7-47c0-b790-cfdebe6d55a3`;
    const createdAt = now - index * 86_400;
    const delivered = status === 'delivered';
    return {
      orderId,
      createdAt,
      status,
      receipt: {
        store: 'Demo Shop',
        product: index % 2 === 0 ? 'Deposit 1 USD' : 'A course with a much longer title than most',
        paying,
        orderId,
        orderedAt: createdAt,
        ...(delivered || status === 'refunded' ? { answeredAt: createdAt + 60 } : {}),
        ...(delivered || status === 'refunded' ? {} : { openStatus: status }),
      },
      assetId:
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      thisProduct: index % 2 === 0,
    };
  });
}

/** A read-only source of fixed purchases. */
export function cannedSource(purchases: Purchase[]): PurchasesSource {
  return {
    purchases: async () => purchases,
    purchase: async (orderId) => purchases.find((each) => each.orderId === orderId),
  };
}

/** Purchases whose opened detail finds its sent transaction on chain. */
function sentSource(purchases: Purchase[]): PurchasesSource {
  return {
    purchases: async () => purchases,
    purchase: async (orderId) => {
      const found = purchases.find((each) => each.orderId === orderId);
      return found === undefined
        ? undefined
        : {
            ...found,
            receipt: {
              ...found.receipt,
              sent: {
                tx: CANNED_SIGNATURE,
                explorer: `https://explorer.solana.com/tx/${CANNED_SIGNATURE}?cluster=devnet`,
              },
            },
          };
    },
  };
}

/** A Solana signature and a Tempo hash, for receipts. */
const CANNED_SIGNATURE =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const CANNED_HASH = '0x9b2f5c1d7e3a4b6c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e';

/** Every state the checkout draws, for the fixture page. Times are from the device clock now. */

export function cannedViews(): CannedView[] {
  const now = nowSeconds();
  const solana = cannedOffer();
  const many = cannedOffer({
    level: 'C',
    payouts: ['solana-devnet', 'tempo-devnet'],
    confirm: ['payout_recently_changed'],
    notices: ['origin_unverifiable'],
  });
  const tempo = cannedOffer({ level: 'B', domain: 'elisym.shop', payouts: ['tempo-mainnet'] });
  const paying = payoutPaying(priced('solana-devnet'));
  const tempoPaying = payoutPaying(priced('tempo-devnet'));
  const about = aboutOf(solana, 'buyer@example.com');
  return [
    { name: 'loading', view: undefined },
    { name: 'offer', view: offerView(solana) },
    { name: 'offer: two networks, email', view: offerView(many, { askEmail: true }) },
    {
      name: 'offer: the payout list open',
      view: offerView(many),
      props: { initialListOpen: true },
    },
    {
      name: 'offer: earlier payment confirming, countdown',
      view: offerView(solana, {
        problem: {
          reason: 'earlier_payment',
          phase: 'confirming',
          retryIn: { seconds: 75, at: now },
        },
      }),
    },
    {
      name: 'offer: earlier payment confirming, in a moment',
      view: offerView(solana, { problem: { reason: 'earlier_payment', phase: 'confirming' } }),
    },
    {
      name: 'offer: earlier Tempo request open, countdown',
      view: offerView(tempo, {
        wallets: [{ name: 'MetaMask' }],
        problem: {
          reason: 'earlier_payment',
          phase: 'tempo_request',
          retryIn: { seconds: 29 * 60, at: now },
        },
      }),
    },
    {
      name: 'offer: earlier Tempo request open, in a moment',
      view: offerView(tempo, {
        wallets: [{ name: 'MetaMask' }],
        problem: { reason: 'earlier_payment', phase: 'tempo_request' },
      }),
    },
    {
      name: 'offer: earlier payment waiting for the store',
      view: offerView(solana, { problem: { reason: 'earlier_payment', phase: 'waiting_store' } }),
    },
    {
      name: 'offer: earlier payment, cancelled by the store',
      view: offerView(solana, {
        problem: { reason: 'earlier_payment', phase: 'waiting_store', cancelled: true },
      }),
    },
    {
      name: 'offer: a changed price (Choose wallet)',
      view: offerView(many, { askEmail: true, problem: { reason: 'offer_changed' } }),
    },
    { name: 'offer: Tempo mainnet', view: offerView(tempo, { wallets: [{ name: 'MetaMask' }] }) },
    {
      name: 'offer: Tempo wallets',
      view: offerView(tempo, { wallets: [{ name: 'MetaMask' }] }),
    },
    {
      name: 'offer: a wallet without Tempo',
      view: offerView(tempo, {
        wallets: [{ name: 'MetaMask' }],
        problem: { reason: 'tempo_unsupported' },
      }),
    },
    {
      name: 'offer: a problem',
      view: offerView(solana, { problem: { reason: 'offer_changed' } }),
    },
    {
      name: 'no wallet',
      view: offerView(solana, { wallets: [] }),
    },
    {
      name: 'working: waiting for the wallet',
      view: { kind: 'working', step: 'checking', paying, about, cancellable: true },
    },
    {
      name: 'working: the wallet has not answered',
      view: { kind: 'working', step: 'checking', paying: tempoPaying, about, cancellable: true },
      props: { hintAfterMs: 0 },
    },
    { name: 'working', view: { kind: 'working', step: 'signing', paying, about } },
    {
      name: 'signing: wallet unanswered, no estimate yet',
      view: { kind: 'working', step: 'signing', paying, about, unsureAt: now + 600 },
      props: { unansweredHintMs: 0 },
    },
    {
      name: 'signing: wallet unanswered, countdown',
      view: {
        kind: 'working',
        step: 'signing',
        paying,
        about,
        startOverIn: { seconds: 65, at: now },
        unsureAt: now + 600,
      },
      props: { unansweredHintMs: 0 },
    },
    {
      name: 'signing: wallet unanswered, 0:00 (checking)',
      view: {
        kind: 'working',
        step: 'signing',
        paying,
        about,
        startOverIn: { seconds: 0, at: now },
        unsureAt: now + 600,
      },
      props: { unansweredHintMs: 0 },
    },
    {
      name: 'signing: wallet unanswered, taking long',
      view: {
        kind: 'working',
        step: 'signing',
        paying,
        about,
        // The countdown ended UNSURE_AFTER_SECS ago and the attempt is still unresolved.
        startOverIn: { seconds: 0, at: now - 600 },
        unsureAt: now - 1,
      },
      props: { unansweredHintMs: 0 },
    },
    {
      name: 'signing: Tempo request unanswered, countdown',
      view: {
        kind: 'working',
        step: 'signing',
        paying: tempoPaying,
        about,
        startOverIn: { seconds: 29 * 60, at: now },
        unsureAt: now - 60,
      },
      props: { unansweredHintMs: 0 },
    },
    {
      name: 'waiting for the payment',
      view: waitingView(about, paying, {
        explorer: 'https://explorer.solana.com/tx/abc?cluster=devnet',
        retryIn: { seconds: 75, at: now },
        unsureAt: now + 600,
      }),
    },
    {
      name: 'wallet did not sign: retry countdown',
      view: waitingView(about, paying, {
        signed: false,
        problem: { reason: 'wallet_failed' },
        retryIn: { seconds: 72, at: now },
        unsureAt: now + 600,
      }),
    },
    {
      name: 'retry',
      view: waitingView(about, paying, {
        canRetry: true,
        signed: false,
        wallets: [{ name: 'Phantom' }],
        problem: { reason: 'wallet_failed' },
      }),
    },
    {
      name: 'follow-only: start over countdown',
      view: waitingView(about, paying, {
        followOnly: true,
        retryIn: { seconds: 40, at: now },
        unsureAt: now + 600,
      }),
    },
    {
      name: 'network not checked here',
      view: waitingView(about, paying, { unserved: true, unsureAt: now + 600 }),
    },
    {
      name: 'Tempo: request countdown',
      view: waitingView(about, tempoPaying, {
        tempo: true,
        signed: false,
        requestEndsIn: { seconds: 2400, at: now },
        unsureAt: now + 600,
      }),
    },
    {
      name: 'waiting for the store',
      view: { kind: 'waiting_store', paying, about, cancelled: false, noAnswer: false },
    },
    {
      name: 'paid, cancelled',
      view: { kind: 'waiting_store', paying, about, cancelled: true, noAnswer: true },
    },
    {
      name: 'old prompt',
      view: { kind: 'old_prompt', orders: 1, until: now + 900, about, paying: tempoPaying },
    },
    {
      name: 'payment complete',
      view: {
        kind: 'delivered',
        store: about.store,
        product: about.product,
        receipt: {
          store: 'Demo Shop',
          product: about.product.title,
          paying,
          orderId: 'b3a7c2d4-0000-4000-8000-000000000001',
          paid: {
            tx: CANNED_SIGNATURE,
            at: now - 120,
            explorer: `https://explorer.solana.com/tx/${CANNED_SIGNATURE}?cluster=devnet`,
          },
          answeredAt: now - 60,
        },
      },
    },
    {
      name: 'payment complete: Tempo',
      view: {
        kind: 'delivered',
        store: about.store,
        product: about.product,
        receipt: {
          store: 'Demo Shop',
          product: about.product.title,
          paying: tempoPaying,
          orderId: 'b3a7c2d4-0000-4000-8000-000000000002',
          paid: { tx: CANNED_HASH, at: now - 300 },
          answeredAt: now - 200,
        },
      },
    },
    {
      name: 'refunded',
      view: {
        kind: 'refunded',
        store: about.store,
        product: about.product,
        receipt: {
          store: 'Demo Shop',
          product: about.product.title,
          paying,
          orderId: 'b3a7c2d4-0000-4000-8000-000000000003',
          answeredAt: now - 60,
        },
      },
    },
    {
      name: 'payment complete: the store answered first (transaction sent)',
      view: {
        kind: 'delivered',
        store: about.store,
        product: about.product,
        receipt: {
          store: 'Demo Shop',
          product: about.product.title,
          paying,
          orderId: 'b3a7c2d4-0000-4000-8000-000000000004',
          sent: {
            tx: CANNED_SIGNATURE,
            explorer: `https://explorer.solana.com/tx/${CANNED_SIGNATURE}?cluster=devnet`,
          },
          answeredAt: now - 30,
        },
      },
    },
    {
      name: 'offer: a long product name',
      view: offerView(
        cannedOffer({
          title:
            'Deposit 1 USD to your account balance, credited at once, with a receipt for your records and taxes',
          name: 'A store with a very long name that will not fit on one line at all',
        }),
      ),
    },
    {
      name: 'offer: a long verified domain',
      view: offerView(
        cannedOffer({
          name: 'Northwind Learning Collective',
          domain: 'courses.northwind-learning-collective.example',
        }),
      ),
    },
    {
      name: 'cancelled',
      view: { kind: 'cancelled', store: about.store, product: about.product },
    },
    { name: 'blocked', view: { kind: 'blocked', store: about.store, product: about.product } },
    {
      name: 'refused',
      view: {
        kind: 'refused',
        reason: 'offer_refused',
        message: 'The store is not on this domain.',
        store: { name: 'Demo Shop' },
        product: about.product,
      },
    },
    {
      name: 'sold-out',
      view: {
        kind: 'refused',
        reason: 'sold_out',
        message: 'Sold out. This product is not available right now.',
        store: { name: 'Demo Shop' },
        product: about.product,
      },
    },
    ...[0, 3, 40].map((count) => ({
      name: `your purchases: ${count}`,
      view: offerView(solana),
      props: { purchases: cannedSource(cannedPurchases(count, now)), initialPurchasesOpen: true },
    })),
    ...cannedPurchases(CANNED_STATUSES.length, now).map((purchase) => ({
      name: `your purchases: detail ${purchase.status}`,
      view: offerView(solana),
      props: {
        purchases: cannedSource([purchase]),
        initialPurchasesOpen: true,
        initialOpened: purchase.orderId,
      },
    })),
    {
      name: 'your purchases: detail with a sent transaction',
      view: offerView(solana),
      props: {
        purchases: sentSource(cannedPurchases(1, now)),
        initialPurchasesOpen: true,
        initialOpened: cannedPurchases(1, now)[0]?.orderId ?? '',
      },
    },
    {
      name: 'progress: finishing (the last stage filled, held)',
      view: waitingView(about, paying),
      next: {
        kind: 'delivered',
        store: about.store,
        product: about.product,
        receipt: {
          store: 'Demo Shop',
          product: about.product.title,
          paying,
          orderId: 'b3a7c2d4-0000-4000-8000-000000000005',
          paid: { tx: CANNED_SIGNATURE, at: now - 5 },
          answeredAt: now,
        },
      },
      props: { finishFillMs: 60_000 },
    },
  ];
}

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
import { type About, type View, payoutPaying } from '../../src/app/session';
import { nowSeconds } from '../../src/app/ui/clock';

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
    continuing: false,
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
  initialWalletsOpen?: boolean;
  initialListOpen?: boolean;
  hintAfterMs?: number;
}

/** Every state the checkout draws, for the fixture page. Times are from the device clock now. */
export function cannedViews(): { name: string; view: View | undefined; props?: CannedProps }[] {
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
      name: 'offer: wallets open',
      view: offerView(many, { askEmail: true }),
      props: { initialWalletsOpen: true },
    },
    { name: 'offer: Tempo mainnet', view: offerView(tempo, { wallets: [{ name: 'MetaMask' }] }) },
    {
      name: 'offer: continuing',
      view: offerView(solana, { askEmail: true, continuing: 'ordered' }),
    },
    {
      name: 'offer: a problem',
      view: offerView(solana, { problem: { reason: 'offer_changed' } }),
    },
    {
      name: 'no wallet',
      view: offerView(solana, { wallets: [] }),
      props: { initialWalletsOpen: true },
    },
    { name: 'working', view: { kind: 'working', step: 'signing', paying, about } },
    {
      name: 'working: no answer from the wallet',
      view: { kind: 'working', step: 'signing', paying, about },
      props: { hintAfterMs: 0 },
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
      name: 'delivered: link',
      view: {
        kind: 'delivered',
        text: 'https://shop.example/course',
        link: 'https://shop.example/course',
        store: about.store,
      },
    },
    {
      name: 'delivered: text',
      view: { kind: 'delivered', text: 'LICENSE-KEY-1234-5678', store: about.store },
    },
    { name: 'refunded', view: { kind: 'refunded', store: about.store } },
    { name: 'cancelled', view: { kind: 'cancelled', store: about.store } },
    { name: 'blocked', view: { kind: 'blocked', store: about.store } },
    {
      name: 'refused',
      view: {
        kind: 'refused',
        message: 'The store is not on this domain.',
        store: { name: 'Demo Shop' },
      },
    },
  ];
}

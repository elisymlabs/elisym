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
import { type View, payoutPaying } from '../../src/app/session';

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
    confirm: offer.confirm,
    confirmed: offer.confirm.length === 0,
    notices: offer.notices,
    wallets: [{ name: 'Phantom' }, { name: 'Solflare' }],
    continuing: false,
    askEmail: false,
    email: '',
    ...overrides,
  };
}

/** Every state the checkout draws, for the fixture page. */
export function cannedViews(): { name: string; view: View | undefined }[] {
  const solana = cannedOffer();
  const many = cannedOffer({
    level: 'C',
    payouts: ['solana-devnet', 'tempo-devnet'],
    confirm: ['payout_recently_changed'],
    notices: ['origin_unverifiable'],
  });
  const tempo = cannedOffer({ level: 'B', domain: 'elisym.shop', payouts: ['tempo-mainnet'] });
  const paying = payoutPaying(priced('solana-devnet'));
  const asset = USDC_SOLANA_DEVNET;
  return [
    { name: 'loading', view: undefined },
    { name: 'review', view: offerView(solana) },
    { name: 'review: warnings, two networks, email', view: offerView(many, { askEmail: true }) },
    { name: 'review: Tempo mainnet', view: offerView(tempo, { wallets: [{ name: 'MetaMask' }] }) },
    {
      name: 'review: continuing',
      view: offerView(solana, { askEmail: true, continuing: 'ordered' }),
    },
    {
      name: 'review: a problem',
      view: offerView(solana, { problem: { reason: 'offer_changed' } }),
    },
    { name: 'no wallet', view: offerView(solana, { wallets: [] }) },
    { name: 'working', view: { kind: 'working', step: 'signing', paying } },
    {
      name: 'waiting for the payment',
      view: {
        kind: 'waiting_payment',
        paying,
        asset,
        canRetry: false,
        wallets: [],
        tempo: false,
        confirm: [],
        confirmed: true,
        unsureLong: false,
        explorer: 'https://explorer.solana.com/tx/abc?cluster=devnet',
      },
    },
    {
      name: 'retry',
      view: {
        kind: 'waiting_payment',
        paying,
        asset,
        canRetry: true,
        wallets: [{ name: 'Phantom' }],
        tempo: false,
        confirm: ['payout_recently_changed'],
        confirmed: false,
        unsureLong: false,
        problem: { reason: 'wallet_failed' },
      },
    },
    {
      name: 'waiting for the store',
      view: { kind: 'waiting_store', paying, cancelled: false, noAnswer: false },
    },
    {
      name: 'paid, cancelled',
      view: { kind: 'waiting_store', paying, cancelled: true, noAnswer: true },
    },
    { name: 'old prompt', view: { kind: 'old_prompt', orders: 1, until: 1_750_000_900 } },
    {
      name: 'delivered: link',
      view: {
        kind: 'delivered',
        text: 'https://shop.example/course',
        link: 'https://shop.example/course',
      },
    },
    { name: 'delivered: text', view: { kind: 'delivered', text: 'LICENSE-KEY-1234-5678' } },
    { name: 'refunded', view: { kind: 'refunded' } },
    { name: 'cancelled', view: { kind: 'cancelled' } },
    { name: 'blocked', view: { kind: 'blocked' } },
    { name: 'refused', view: { kind: 'refused', message: 'The store is not on this domain.' } },
  ];
}

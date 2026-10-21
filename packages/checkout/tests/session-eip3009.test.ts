/**
 * Settlement gating: an `eip3009` chain (Ethereum, Arbitrum, Base) is in the
 * registry and is EVM, but this widget does not pay on it yet. Its payout is
 * never servable, whatever clients the build has, and no rail reads for it.
 */
import { payoutRail } from '@elisym/commerce';
import { type LoadedOffer, type OrderRecord, OrderStore, loadOffer } from '@elisym/commerce/buyer';
import { USDC_BASE_DEVNET } from '@elisym/pay-core';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EIP3009_USDC,
  MemoryRelays,
  NOW,
  inboxList,
  makeShop,
} from '../../commerce/tests/buyer/fixtures';
import { record, solanaMarker } from '../../commerce/tests/buyer/order-store.contract';
import { TempoChainUnsupported, connectTempo } from '../src/app/evm-wallets';
import { recordRail } from '../src/app/receipts';
import { CheckoutSession, type SessionDeps, type View } from '../src/app/session';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';
import { NO_FEE_TERMS } from './fee-fixtures';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';
const PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const BASE_CAIP19 = `eip155:84532/erc20:${USDC_BASE_DEVNET.mint}`;

type Ready = Extract<LoadedOffer, { ok: true }>;

let backend: IndexedDbOrderBackend;
let store: OrderStore;

beforeEach(async () => {
  backend = new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory()));
  store = new OrderStore(backend);
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** A client that fails the test if any rail reads through it. */
const UNREAD = {
  request: () => {
    throw new Error('no rail may read for an eip3009 payout');
  },
};

/** The session's views for a store offering only `caip19` (an eip3009 USDC), after `seed` ran. */
async function viewsOfOnly(
  caip19: string,
  seed: (productAddress: string) => Promise<void> = async () => undefined,
): Promise<View[]> {
  const shop = makeShop({ caip19, payout: PAYOUT });
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const loaded = await loadOffer(shop.naddr, {
    client: relays,
    pageOrigin: PAGE,
    families: ['solana', 'evm'],
    now: NOW,
  });
  if (!loaded.ok) {
    throw new Error(loaded.message);
  }
  const offer: Ready = loaded;
  expect(offer.payouts.map((payout) => payout.target.caip19.id)).toEqual([caip19]);
  const views: View[] = [];
  const deps: SessionDeps = {
    store,
    readClient: relays,
    clientFor: () => relays,
    rpcFor: () => ({}) as never,
    feeTerms: NO_FEE_TERMS,
    wallets: () => [],
    tempoFor: () => UNREAD,
    tempoWallets: () => [],
    tempoChainTime: async () => NOW,
    reloadOffer: async () => offer,
    now: () => NOW,
    chainTime: async () => NOW,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    onView: (view) => views.push(view),
    onStatus: () => undefined,
    onBanner: () => undefined,
  };
  await seed(offer.productAddress);
  const session = new CheckoutSession(offer, deps);
  await session.start();
  await settle();
  return views;
}

const REFUSED = {
  kind: 'refused',
  reason: 'offer_refused',
  message: 'This network is not available here yet.',
};

describe('a store offering only an eip3009 USDC payout', () => {
  it('lists all six eip3009 USDC', () => {
    expect(EIP3009_USDC.map(({ chain }) => chain.chainName)).toEqual([
      'Ethereum',
      'Sepolia',
      'Arbitrum One',
      'Arbitrum Sepolia',
      'Base',
      'Base Sepolia',
    ]);
  });

  it.each(EIP3009_USDC)(
    'on $chain.chainName shows "no new payment on this network", with every client the build could have',
    async ({ caip19 }) => {
      expect((await viewsOfOnly(caip19)).at(-1)).toMatchObject(REFUSED);
    },
  );

  it('follows no eip3009 order in progress, though a Solana RPC is there', async () => {
    // Written past the store: PR 1's store refuses a marker on these payouts.
    const views = await viewsOfOnly(BASE_CAIP19, async (productAddress) => {
      await backend.transactProduct(productAddress, () => ({
        write: [
          {
            ...record('attempt', {
              productAddress,
              state: 'paying',
              medium: 'base-devnet',
              payout: { caip19: BASE_CAIP19, address: PAYOUT },
            }),
            marker: solanaMarker('a'),
          },
        ],
        result: undefined,
      }));
    });
    expect(views.at(-1)).toMatchObject(REFUSED);
    expect(views.at(-1)).not.toHaveProperty('orderId');
    expect(views.some((view) => view.kind === 'waiting_payment')).toBe(false);
  });
});

describe('the rail of an eip3009 record and chain', () => {
  it.each(EIP3009_USDC)('on $chain.chainName is no rail of this widget', ({ caip19 }) => {
    const record = { payout: { caip19, address: PAYOUT } } as OrderRecord;
    expect(payoutRail(caip19)).toBe('eip3009');
    expect(recordRail(record)).toBeUndefined();
    const tempo = {
      payout: { caip19: 'eip155:42431/erc20:0x20c0000000000000000000000000000000000000' },
    } as OrderRecord;
    expect(recordRail(tempo)).toBe('tempo');
  });

  it.each(EIP3009_USDC)(
    "on $chain.chainName is never added to a wallet under Tempo's name and gas coin",
    async ({ chain }) => {
      const requests: string[] = [];
      const provider = {
        request: async (args: { method: string }) => {
          requests.push(args.method);
          if (args.method === 'eth_requestAccounts') {
            return [PAYOUT];
          }
          if (args.method === 'wallet_switchEthereumChain') {
            throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
          }
          return null;
        },
      };
      await expect(connectTempo(provider, chain)).rejects.toBeInstanceOf(TempoChainUnsupported);
      expect(requests).not.toContain('wallet_addEthereumChain');
    },
  );
});

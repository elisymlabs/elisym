/** Consistent content for the designer gallery; shared test fixtures and real payments stay unchanged. */
import type { PricedPayout } from '@elisym/commerce/buyer';
import type { Asset } from '@elisym/pay-core';
import type { Purchase } from '../../src/app/history';
import type { About, Paying, Receipt, StoreInfo, View } from '../../src/app/session';
import type { PurchasesSource } from '../../src/app/ui/PurchasesStep';
import { cannedViews, type CannedView } from './canned';

const TITLE = 'Test payment';
const STORE = 'PayCore';
const PRICE = { amount: '0.10', currency: 'USD' };
const amount = (asset: Asset) => 10n ** BigInt(asset.decimals) / 10n;
const paying = (value: Paying): Paying => ({ ...value, amount: String(amount(value.asset)) });
const payout = (value: PricedPayout): PricedPayout => ({ ...value, amount: amount(value.target.caip19.asset) });
const store = (value: StoreInfo): StoreInfo => ({ ...value, name: STORE });
const product = (value: About['product']): About['product'] => ({ title: TITLE, price: { ...value.price, ...PRICE } });
const about = (value: About): About => ({ ...value, store: store(value.store), product: product(value.product) });
const receipt = (value: Receipt, title = TITLE): Receipt => ({ ...value, store: STORE, product: title, ...(value.paying ? { paying: paying(value.paying) } : {}) });
const purchase = (value: Purchase): Purchase => ({ ...value, receipt: receipt(value.receipt, value.thisProduct ? TITLE : 'Another test payment') });
const purchases = (source: PurchasesSource): PurchasesSource => ({
  purchases: async () => (await source.purchases()).map(purchase),
  purchase: async (id) => { const found = await source.purchase(id); return found ? purchase(found) : undefined; },
});

function viewData(value: View | undefined, stressText: boolean): View | undefined {
  if (!value) {return value;}
  if (value.kind === 'offer') {
    const listed = value.payouts.map(payout);
    const original = value.offer.offer.product;
    const { summary: _summary, ...originalProduct } = original;
    return {
      ...value,
      ...(value.problem?.reason === 'tempo_unsupported' ? {
        // A named demo selection makes the inline failure visible without labelling MetaMask unsupported.
        problem: { ...value.problem, wallet: { name: 'Demo wallet' } },
      } : {}),
      payout: listed[value.payoutIndex] ?? payout(value.payout),
      payouts: listed,
      offer: {
        ...value.offer,
        payouts: value.offer.payouts.map(payout),
        offer: {
          ...value.offer.offer,
          profile: { ...value.offer.offer.profile, name: stressText ? value.offer.offer.profile.name : STORE },
          product: { ...originalProduct, title: stressText ? original.title : TITLE, price: PRICE },
        },
      },
    };
  }
  if ('about' in value) {return { ...value, about: about(value.about), ...(value.paying ? { paying: paying(value.paying) } : {}) };}
  return {
    ...value,
    ...(value.store ? { store: store(value.store) } : {}),
    ...(value.product ? { product: product(value.product) } : {}),
    ...('receipt' in value && value.receipt ? { receipt: receipt(value.receipt) } : {}),
  };
}

export function reviewFixture(name: string): CannedView {
  const fixtures = cannedViews();
  let found = fixtures.find((fixture) => fixture.name === name);
  if (name === 'review: forty wallets') {
    const offer = fixtures.find((fixture) => fixture.name === 'offer')!;
    if (offer.view?.kind !== 'offer') { throw new Error('Missing offer fixture'); }
    found = { name, view: { ...offer.view, wallets: [
      { name: 'Phantom' }, { name: 'Solflare' },
      ...Array.from({ length: 38 }, (_, index) => ({ name: 'Demo wallet ' + (index + 3) })),
    ] } };
  }
  if (name === 'review: creating order') {
    const signing = fixtures.find((fixture) => fixture.name === 'working')!;
    if (signing.view?.kind !== 'working') {throw new Error('Missing working fixture');}
    found = { name, view: { ...signing.view, step: 'ordering' } };
  }
  if (!found) {throw new Error(`Unknown review fixture: ${name}`);}
  // Long-copy checks deliberately retain their long titles; they are explicitly labelled.
  const stressText = name.startsWith('offer: a long');
  return {
    ...found,
    view: viewData(found.view, stressText),
    ...(found.next ? { next: viewData(found.next, stressText) } : {}),
    ...(found.props ? { props: { ...found.props, ...(found.props.purchases ? { purchases: purchases(found.props.purchases) } : {}) } } : {}),
  };
}

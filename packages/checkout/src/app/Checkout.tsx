import type { OfferWarning } from '@elisym/commerce';
import type { RefusalReason, Screen } from './controller';

interface Props {
  screen: Screen;
}

const REFUSALS: Record<RefusalReason, string> = {
  not_framed: 'This checkout only works embedded in a store page.',
  no_hello: 'The store page did not start the checkout.',
  no_product: 'This checkout names no product.',
  no_storage:
    'This browser blocks storage for the checkout (private mode?). Payments need it to stay safe.',
  offer_refused: 'This product cannot be bought here.',
  failed: 'The checkout could not start. Reload the page to try again.',
};

const WARNINGS: Record<OfferWarning, string> = {
  domain_unverified: 'The store names a domain that does not confirm it.',
  origin_mismatch: 'This page is not on the store’s domain.',
  origin_unverifiable: 'No domain vouches for this store: check you trust this page.',
  payout_recently_changed: 'The store changed where it is paid very recently.',
  payout_changed: 'The store is paid to a different address than on your last purchase.',
  payout_unsigned: 'The payout address carries no wallet proof.',
  owner_unpinned: 'First purchase from this store on this site.',
};

/** Store data is rendered as text only; no remote images in the slice. */
export function Checkout({ screen }: Props) {
  if (screen.kind === 'waiting' || screen.kind === 'loading') {
    return <p class="muted">Loading…</p>;
  }
  if (screen.kind === 'refused') {
    return (
      <div class="refused" role="alert">
        <p>{REFUSALS[screen.reason]}</p>
        {screen.message === undefined ? null : <p class="muted">{screen.message}</p>}
      </div>
    );
  }
  const { offer } = screen;
  const { product } = offer.offer;
  const warnings = [...offer.confirm, ...offer.notices];
  return (
    <article>
      <h1>{product.title}</h1>
      {product.summary === undefined ? null : <p>{product.summary}</p>}
      <p class="price">
        {product.price.amount} {product.price.currency}
      </p>
      <p class="muted">
        Sold by {offer.offer.profile.name ?? 'an unnamed store'}
        {offer.offer.domain === undefined ? '' : ` (${offer.offer.domain})`}, trust level{' '}
        {offer.offer.level}
      </p>
      {warnings.length === 0 ? null : (
        <ul class="warnings">
          {warnings.map((warning) => (
            <li key={warning}>{WARNINGS[warning]}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

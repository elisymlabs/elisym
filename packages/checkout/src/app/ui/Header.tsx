import type { StoreInfo } from '../session';
import { shownText } from './text';
import { TrustChip } from './TrustChip';

interface Props {
  /** What is bought, as the store lists it; none before an offer is known. */
  product: string | undefined;
  store: StoreInfo | undefined;
  testNetwork: boolean;
}

/**
 * The product first, then who sells it and how far the store is verified - no
 * chip when the level is not known now (an order's old snapshot). Store text is
 * untrusted: rendered as text, clamped by CSS, the full value in `title`.
 */
export function Header({ product, store, testNetwork }: Props) {
  const storeName = store === undefined ? undefined : (store.name ?? 'Unnamed store');
  const chip =
    store?.level === undefined ? null : <TrustChip level={store.level} domain={store.domain} />;
  return (
    <header class="header">
      <h1
        id="checkout-title"
        class="product-title"
        tabindex={-1}
        {...(product === undefined ? {} : { title: product })}
      >
        {product === undefined ? 'Checkout' : shownText(product)}
      </h1>
      {storeName === undefined && !testNetwork ? null : (
        <p class="store-line">
          {storeName === undefined ? null : (
            <span class="store-name" title={storeName}>
              {shownText(storeName)}
            </span>
          )}
          {testNetwork ? <span class="badge">Test network</span> : null}
          {chip}
        </p>
      )}
    </header>
  );
}

import { useState } from 'preact/hooks';
import type { StoreInfo } from '../session';
import { shownText } from './text';
import { TrustChip } from './TrustChip';

/** What the header names: the product's title and, when the listing has one, its picture. */
export interface HeaderProduct {
  title: string;
  /** An `https:` URL from the listing (commerce keeps no other). */
  image?: string;
}

interface Props {
  /** What is bought, as the store lists it; none before an offer is known. */
  product: HeaderProduct | undefined;
  store: StoreInfo | undefined;
  testNetwork: boolean;
}

/**
 * The product first, then who sells it and how far the store is verified - no
 * chip when the level is not known now (an order's old snapshot). Store text is
 * untrusted: rendered as text, clamped by CSS, the full value in `title`. The
 * picture is decorative (the title names the product), sent no referrer, and
 * gone when it does not load.
 */
export function Header({ product, store, testNetwork }: Props) {
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const storeName = store === undefined ? undefined : (store.name ?? 'Unnamed store');
  const chip =
    store?.level === undefined ? null : <TrustChip level={store.level} domain={store.domain} />;
  const image = product?.image;
  return (
    <header class="header">
      {image === undefined || image === failed ? null : (
        <img
          class="product-image"
          src={image}
          alt=""
          referrerpolicy="no-referrer"
          decoding="async"
          onError={() => setFailed(image)}
        />
      )}
      <h1
        id="checkout-title"
        class="product-title"
        tabindex={-1}
        {...(product === undefined ? {} : { title: product.title })}
      >
        {product === undefined ? 'Checkout' : shownText(product.title)}
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

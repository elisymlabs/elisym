import {
  type CatalogItem,
  type CatalogVariant,
  type StoreConfig,
  productPageUrl,
} from '@elisym/askr';
import { type NativeCartPlatform, nativeAddToCart, nativeCartPlatform } from '../native-cart';
import {
  type CartButton,
  type PickState,
  addToCartDetail,
  cartButton,
  hostAddToCartHook,
  pickState,
} from '../variant';
import { element, httpsUrl } from './dom';
import { formatPrice } from './price';
import { STRINGS } from './strings';

export interface CardContext {
  document: Document;
  config: StoreConfig;
  /** Advisory handoff count (3). */
  reportClick: (address: string) => void;
  pageOrigin: string | undefined;
}

/** The product page: the first `r` on one of the store's `origin`/`link-origin` entries (K12). */
export function cardPageUrl(item: CatalogItem, config: StoreConfig): string | undefined {
  return httpsUrl(productPageUrl(item, [...config.origins, ...config.linkOrigins]));
}

function productLink(
  context: CardContext,
  item: CatalogItem,
  url: string,
  className: string,
  text: string,
): HTMLAnchorElement {
  const link = element(context.document, 'a', className, text);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.addEventListener('click', () => context.reportClick(item.address));
  return link;
}

/**
 * A product card from the widget's own catalog fetch (4.3): image, title
 * (linking to the product page when it is on an allowed origin), price,
 * labels, one selector per option, and the add-to-cart button of 6.
 */
export function renderCard(context: CardContext, item: CatalogItem, reason?: string): HTMLElement {
  const { document } = context;
  const card = element(document, 'div', 'card');
  const image = httpsUrl(item.images[0]);
  if (image !== undefined) {
    const img = element(document, 'img');
    img.src = image;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    card.append(img);
  }
  const pageUrl = cardPageUrl(item, context.config);
  card.append(
    pageUrl === undefined
      ? element(document, 'span', 'card-title', item.title)
      : productLink(context, item, pageUrl, 'card-title', item.title),
  );
  const price = element(document, 'span', 'price');
  card.append(price);
  if (item.visibility === 'pre-order') {
    card.append(element(document, 'span', 'label', STRINGS.preOrder));
  }
  if (reason !== undefined) {
    card.append(element(document, 'span', 'reason', reason));
  }
  const pick: Record<string, string> = {};
  const selectorsBox = element(document, 'div');
  const actionBox = element(document, 'div');
  card.append(selectorsBox, actionBox);

  const currentButton = (state: PickState): CartButton =>
    cartButton(item, state, {
      hook: hostAddToCartHook(),
      native: nativeCartPlatform(context.config, context.pageOrigin),
    });
  let renderedKind: CartButton['kind'] | undefined;

  const addNatively = async (
    add: HTMLButtonElement,
    platform: NativeCartPlatform,
    variant: CatalogVariant,
  ): Promise<void> => {
    const origin = context.pageOrigin;
    if (origin === undefined) {
      return;
    }
    context.reportClick(item.address);
    add.disabled = true;
    add.textContent = STRINGS.adding;
    add.setAttribute('aria-busy', 'true');
    const added = await nativeAddToCart(platform, origin, variant);
    if (!actionBox.contains(add)) {
      return;
    }
    add.removeAttribute('aria-busy');
    if (added) {
      add.disabled = false;
      add.textContent = STRINGS.added;
      return;
    }
    const failed = element(document, 'span', 'label cart-failed', STRINGS.addFailed);
    failed.setAttribute('role', 'status');
    if (pageUrl === undefined) {
      add.disabled = false;
      add.textContent = STRINGS.addToCart;
      actionBox.append(failed);
      return;
    }
    actionBox.replaceChildren(
      failed,
      productLink(context, item, pageUrl, 'view', STRINGS.viewProduct),
    );
    document.defaultView?.open(pageUrl, '_blank', 'noopener,noreferrer');
  };

  const update = (): void => {
    const state = pickState(item, pick);
    price.textContent = formatPrice(item, state.variant?.price);
    const button = currentButton(state);
    renderedKind = button.kind;
    actionBox.replaceChildren();
    if (button.kind === 'sold-out') {
      actionBox.append(element(document, 'span', 'label sold-out', STRINGS.soldOut));
    } else if (button.kind === 'hook') {
      const add = element(document, 'button', 'cart', STRINGS.addToCart);
      add.type = 'button';
      add.disabled = !button.enabled;
      add.addEventListener('click', () => {
        const hook = hostAddToCartHook();
        const current = pickState(item, pick);
        if (!hook || !current.complete || current.soldOut) {
          return;
        }
        context.reportClick(item.address);
        try {
          hook(addToCartDetail(item, current));
        } catch {
          return;
        }
      });
      actionBox.append(add);
    } else if (button.kind === 'native') {
      const { platform, variant } = button;
      if (variant) {
        const add = element(document, 'button', 'cart', STRINGS.addToCart);
        add.type = 'button';
        add.addEventListener('click', () => {
          void addNatively(add, platform, variant);
        });
        actionBox.append(add);
      } else if (pageUrl !== undefined) {
        actionBox.append(productLink(context, item, pageUrl, 'view', STRINGS.viewProduct));
      }
    }
  };

  for (const selector of pickState(item, pick).selectors) {
    const label = element(document, 'label', 'selector', selector.name);
    const select = element(document, 'select');
    const placeholder = element(
      document,
      'option',
      undefined,
      `${STRINGS.choose} ${selector.name}`,
    );
    placeholder.value = '';
    select.append(placeholder);
    for (const value of selector.values) {
      const option = element(document, 'option', undefined, value);
      option.value = value;
      select.append(option);
    }
    select.addEventListener('change', () => {
      if (select.value === '') {
        delete pick[selector.name];
      } else {
        pick[selector.name] = select.value;
      }
      update();
    });
    label.append(select);
    selectorsBox.append(label);
  }
  update();
  // The host may set its hook after the card rendered (6): pick it up before the visitor acts.
  const refresh = (): void => {
    if (currentButton(pickState(item, pick)).kind !== renderedKind) {
      update();
    }
  };
  card.addEventListener('pointerenter', refresh);
  card.addEventListener('focusin', refresh);
  return card;
}

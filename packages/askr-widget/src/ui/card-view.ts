import {
  type CatalogItem,
  type CatalogVariant,
  type StoreConfig,
  productPageUrl,
} from '@elisym/askr';
import type { ClickKind } from '../gateway';
import {
  type NativeCartPlatform,
  nativeAddToCart,
  nativeCartPlatform,
  nativeCartVariantId,
} from '../native-cart';
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

/** How long a button says it added before it offers to add again. */
export const ADDED_MS = 1400;

type CartState = 'ready' | 'busy' | 'done';

/** Read at render time: the texts follow the widget's language. */
function cartLabel(state: CartState): string {
  if (state === 'busy') {
    return STRINGS.adding;
  }
  return state === 'done' ? STRINGS.added : STRINGS.addToCart;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A cart, drawn in the button's text color. */
function cartIcon(document: Document): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'cart-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const basket = document.createElementNS(SVG_NS, 'path');
  basket.setAttribute(
    'd',
    'M3 4h2.2l2.3 10.1a1.2 1.2 0 0 0 1.2.9h8.6a1.2 1.2 0 0 0 1.2-.9L20 8H6.1',
  );
  svg.append(basket);
  for (const wheelX of [9.5, 16.5]) {
    const wheel = document.createElementNS(SVG_NS, 'circle');
    wheel.setAttribute('cx', String(wheelX));
    wheel.setAttribute('cy', '19.5');
    wheel.setAttribute('r', '1.4');
    svg.append(wheel);
  }
  return svg;
}

interface CartControl {
  button: HTMLButtonElement;
  /** A visually hidden live region beside the button: it announces a finished add. */
  announcer: HTMLSpanElement;
  setState: (state: CartState) => void;
  /** Say "added" for ADDED_MS, taking no click meanwhile, then offer to add again. */
  showAdded: () => void;
}

/**
 * The add-to-cart button. Its three labels share one grid cell and only the current one is
 * visible, so the button keeps the width of the longest and the row never shifts. The
 * accessible name follows the state.
 */
function cartButtonElement(document: Document): CartControl {
  const button = element(document, 'button', 'cart');
  button.type = 'button';
  const labels = element(document, 'span', 'cart-labels');
  for (const state of ['ready', 'busy', 'done'] as const) {
    const label = element(document, 'span', `cart-label cart-${state}`, cartLabel(state));
    label.setAttribute('aria-hidden', 'true');
    labels.append(label);
  }
  button.append(cartIcon(document), labels);
  const announcer = element(document, 'span', 'visually-hidden');
  announcer.setAttribute('role', 'status');
  let addedTimer: ReturnType<typeof setTimeout> | undefined;
  const setState = (state: CartState): void => {
    if (addedTimer !== undefined) {
      clearTimeout(addedTimer);
      addedTimer = undefined;
    }
    button.dataset.state = state;
    button.setAttribute('aria-label', state === 'done' ? STRINGS.addedToCart : cartLabel(state));
    announcer.textContent = state === 'done' ? STRINGS.addedToCart : '';
    if (state === 'done') {
      button.setAttribute('aria-disabled', 'true');
    } else {
      button.removeAttribute('aria-disabled');
    }
    if (state === 'busy') {
      button.setAttribute('aria-busy', 'true');
    } else {
      button.removeAttribute('aria-busy');
    }
  };
  // While it says added the button takes no click (a second tap would add the product
  // again). It stays enabled to the browser, marked aria-disabled, so a keyboard user's focus
  // stays on it instead of falling to the top of the page.
  button.addEventListener('click', (event) => {
    if (button.dataset.state === 'done') {
      event.stopImmediatePropagation();
    }
  });
  const showAdded = (): void => {
    setState('done');
    addedTimer = setTimeout(() => {
      addedTimer = undefined;
      setState('ready');
    }, ADDED_MS);
  };
  setState('ready');
  return { button, announcer, setState, showAdded };
}

/** Up to this many short values show as buttons; more, or longer, go in a select. */
const MAX_CHOICES = 6;
const MAX_CHOICE_CHARS = 14;

function fitsAsChoices(values: readonly string[]): boolean {
  return (
    values.length <= MAX_CHOICES && values.every((value) => [...value].length <= MAX_CHOICE_CHARS)
  );
}

/**
 * Short values as toggle buttons under the option's name: one tap picks (aria-pressed marks
 * it), a tap on the picked one changes nothing, so an add in flight is never dropped.
 */
function choiceGroup(
  document: Document,
  name: string,
  values: readonly string[],
  choose: (value: string) => void,
): HTMLElement {
  const box = element(document, 'div', 'choice-group');
  const label = element(document, 'span', 'choice-name', name);
  const group = element(document, 'div', 'choices');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', name);
  const buttons = values.map((value) => {
    const button = element(document, 'button', 'choice', value);
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-pressed') === 'true') {
        return;
      }
      for (const other of buttons) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      choose(value);
    });
    return button;
  });
  group.append(...buttons);
  label.setAttribute('aria-hidden', 'true');
  box.append(label, group);
  return box;
}

/** Many or long values in a select, its placeholder naming the option. */
function selectBox(
  document: Document,
  name: string,
  values: readonly string[],
  choose: (value: string) => void,
): HTMLElement {
  // The option's name is read out with the select; the placeholder shows it on screen.
  const label = element(document, 'label', 'selector');
  label.append(element(document, 'span', 'visually-hidden', name));
  const select = element(document, 'select');
  const placeholder = element(document, 'option', undefined, `${STRINGS.choose} ${name}`);
  placeholder.value = '';
  select.append(placeholder);
  for (const value of values) {
    const option = element(document, 'option', undefined, value);
    option.value = value;
    select.append(option);
  }
  select.addEventListener('change', () => choose(select.value));
  label.append(select);
  return label;
}

/** How long a tap on a button that waits for a pick keeps its hint up (a touch screen has no hover). */
export const HINT_MS = 2400;

/** Ties each hint to its button (`aria-describedby`); ids stay unique on the page. */
let hintCount = 0;

/**
 * Make the cart button wait for the visitor's pick: it looks disabled but stays focusable
 * (aria-disabled), and a hint over it names the options still to choose. The hint shows on
 * hover and focus, and for a moment after a tap.
 */
function waitForPick(
  document: Document,
  actionBox: HTMLElement,
  button: HTMLButtonElement,
  missing: readonly string[],
): HTMLElement {
  const hint = element(document, 'span', 'cart-hint', `${STRINGS.choose} ${missing.join(', ')}`);
  hint.setAttribute('role', 'tooltip');
  hintCount += 1;
  hint.id = `askr-cart-hint-${hintCount}`;
  button.classList.add('needs-pick');
  button.setAttribute('aria-disabled', 'true');
  button.setAttribute('aria-describedby', hint.id);
  actionBox.classList.add('waits-for-pick');
  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', (event) => {
    if (!button.classList.contains('needs-pick')) {
      return;
    }
    event.stopImmediatePropagation();
    actionBox.classList.add('hint-shown');
    clearTimeout(timer);
    timer = setTimeout(() => actionBox.classList.remove('hint-shown'), HINT_MS);
  });
  return hint;
}

/** The names of the card's options the pick has not set yet. */
function unpicked(state: PickState): string[] {
  const picked = state.options ?? {};
  return state.selectors
    .filter((selector) => picked[selector.name] === undefined)
    .map((selector) => selector.name);
}

export interface CardContext {
  document: Document;
  config: StoreConfig;
  /** Advisory handoff count (3): a product link opened, or an add to cart pressed. */
  reportClick: (address: string, kind: ClickKind) => void;
  pageOrigin: string | undefined;
  /** The widget's language, for the card's own texts (the reason is the model's). */
  language?: string;
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
  link.draggable = false;
  link.addEventListener('click', () => context.reportClick(item.address, 'link'));
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
  // The photo on top, filling its frame, the pre-order badge over it; then the title, the
  // reason, the options and a foot with the price and the button.
  const body = element(document, 'div', 'card-body');
  const image = httpsUrl(item.images[0]);
  const badge =
    item.visibility === 'pre-order'
      ? element(document, 'span', 'label', STRINGS.preOrder)
      : undefined;
  if (image !== undefined) {
    const media = element(document, 'div', 'card-media');
    const img = element(document, 'img');
    img.src = image;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    // The row drags sideways under a mouse: the photo must not start a drag of its own.
    img.draggable = false;
    media.append(img);
    if (badge) {
      media.append(badge);
    }
    card.append(media);
  } else if (badge) {
    body.append(badge);
  }
  const pageUrl = cardPageUrl(item, context.config);
  body.append(
    pageUrl === undefined
      ? element(document, 'span', 'card-title', item.title)
      : productLink(context, item, pageUrl, 'card-title', item.title),
  );
  if (reason !== undefined) {
    body.append(element(document, 'span', 'reason', reason));
  }
  const pick: Record<string, string> = {};
  const selectorsBox = element(document, 'div', 'card-options');
  const foot = element(document, 'div', 'card-foot');
  const price = element(document, 'span', 'price');
  const actionBox = element(document, 'div', 'card-actions');
  foot.append(price, actionBox);
  if (context.language !== undefined) {
    for (const own of [foot, selectorsBox]) {
      own.lang = context.language;
    }
    if (badge) {
      badge.lang = context.language;
    }
  }
  body.append(selectorsBox, foot);
  card.append(body);

  const currentButton = (state: PickState): CartButton =>
    cartButton(item, state, {
      hook: hostAddToCartHook(),
      native: nativeCartPlatform(context.config, context.pageOrigin),
    });
  let renderedKind: CartButton['kind'] | undefined;
  const nativeAddable = item.variants.some(
    (variant) => variant.available && nativeCartVariantId(variant) !== undefined,
  );

  const addNatively = async (
    cart: CartControl,
    platform: NativeCartPlatform,
    variant: CatalogVariant,
  ): Promise<void> => {
    const shopUrl = context.config.source.shopUrl;
    if (shopUrl === undefined) {
      return;
    }
    const { button: add, setState } = cart;
    context.reportClick(item.address, 'cart');
    add.disabled = true;
    setState('busy');
    const added = await nativeAddToCart(platform, shopUrl, variant);
    // The card was re-rendered meanwhile (another pick): this button and its answer are stale.
    if (!actionBox.contains(add)) {
      return;
    }
    if (added) {
      add.disabled = false;
      cart.showAdded();
      return;
    }
    const failed = element(document, 'span', 'label cart-failed', STRINGS.addFailed);
    failed.setAttribute('role', 'status');
    if (pageUrl === undefined) {
      add.disabled = false;
      setState('ready');
      actionBox.append(failed);
      return;
    }
    // No window.open here: the add answered long after the click, outside the user
    // gesture, so a popup blocker would eat it. The visible link is the handoff.
    actionBox.replaceChildren(
      failed,
      productLink(context, item, pageUrl, 'view', STRINGS.viewProduct),
    );
  };

  const update = (): void => {
    const state = pickState(item, pick);
    price.textContent = formatPrice(item, state.variant?.price);
    const button = currentButton(state);
    renderedKind = button.kind;
    actionBox.replaceChildren();
    actionBox.classList.remove('waits-for-pick', 'hint-shown');
    if (button.kind === 'sold-out') {
      actionBox.append(element(document, 'span', 'label sold-out', STRINGS.soldOut));
    } else if (button.kind === 'hook') {
      const cart = cartButtonElement(document);
      const add = cart.button;
      const hint = button.enabled
        ? undefined
        : waitForPick(document, actionBox, add, unpicked(state));
      add.addEventListener('click', () => {
        const hook = hostAddToCartHook();
        const current = pickState(item, pick);
        if (!hook || !current.complete || current.soldOut) {
          return;
        }
        context.reportClick(item.address, 'cart');
        try {
          hook(addToCartDetail(item, current));
        } catch {
          return;
        }
        cart.showAdded();
      });
      actionBox.append(add, cart.announcer);
      if (hint) {
        actionBox.append(hint);
      }
    } else if (button.kind === 'native') {
      const { platform, variant } = button;
      if (variant) {
        const cart = cartButtonElement(document);
        cart.button.addEventListener('click', () => {
          void addNatively(cart, platform, variant);
        });
        actionBox.append(cart.button, cart.announcer);
      } else if (!state.complete && nativeAddable) {
        // A pick would determine a variant the shop's cart takes: the button waits for it.
        const cart = cartButtonElement(document);
        const hint = waitForPick(document, actionBox, cart.button, unpicked(state));
        actionBox.append(cart.button, cart.announcer, hint);
      } else if (pageUrl !== undefined) {
        actionBox.append(productLink(context, item, pageUrl, 'view', STRINGS.viewProduct));
      }
    }
  };

  for (const selector of pickState(item, pick).selectors) {
    const choose = (value: string): void => {
      if (value === '') {
        delete pick[selector.name];
      } else {
        pick[selector.name] = value;
      }
      update();
    };
    selectorsBox.append(
      fitsAsChoices(selector.values)
        ? choiceGroup(document, selector.name, selector.values, choose)
        : selectBox(document, selector.name, selector.values, choose),
    );
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

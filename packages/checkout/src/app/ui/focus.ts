import type { View } from '../session';

/**
 * Where focus goes after a buyer's action draws a new view, or when a new view
 * removed the element that had it. In order: the one section heading (wallet,
 * progress, old prompt or outcome); for a mistyped email, the email field; the
 * problem note; the product title. Never when the buyer is elsewhere, and
 * never scrolling the page that frames the checkout.
 */
export function focusFallback(card: HTMLElement | null, view: View | undefined): void {
  if (card === null || !document.hasFocus()) {
    return;
  }
  const badEmail = view?.kind === 'offer' && view.problem?.reason === 'bad_email';
  const target =
    card.querySelector<HTMLElement>('[data-heading]') ??
    (badEmail ? card.querySelector<HTMLElement>('input[type="email"]') : null) ??
    card.querySelector<HTMLElement>('[data-problem-note]') ??
    card.querySelector<HTMLElement>('.product-title');
  target?.focus({ preventScroll: true });
}

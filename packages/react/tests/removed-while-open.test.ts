// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount, resetDocument } from './mount';

/**
 * The loader's behaviour for an element removed while its modal is open: it
 * closes in `disconnectedCallback`, and since the element no longer bubbles to
 * the page, fires the close on `document`.
 */
class OpenModalElement extends HTMLElement {
  static readonly loader = 'v3';

  disconnectedCallback(): void {
    document.dispatchEvent(
      new CustomEvent('elisym-close', { bubbles: true, detail: { element: this } }),
    );
  }
}
customElements.define('elisym-buy', OpenModalElement);

describe('an element removed while its modal is open', () => {
  it('still tells onClose, once', async () => {
    resetDocument();
    const onClose = vi.fn();
    const mounted = await mount({ product: 'naddr1qqtestproduct', onClose });
    const element = mounted.element();
    element.dispatchEvent(new CustomEvent('elisym-open', { bubbles: true }));
    await mounted.unmount();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

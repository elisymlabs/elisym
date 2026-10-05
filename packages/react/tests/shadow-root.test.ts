// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mountInShadowRoot, resetDocument } from './mount';

const PRODUCT = 'naddr1qqtestproduct';

/** The v3 loader's `open()`: one `elisym-open` on the element. */
function loaderOpens(element: HTMLElement): void {
  element.dispatchEvent(new CustomEvent('elisym-open', { bubbles: true }));
}

/**
 * The v3 loader's `close()`: `elisym-close` on the element (it bubbles, not
 * composed), and for an element no longer in the page, a second one on `document`.
 */
function loaderCloses(element: HTMLElement, reachesPage: boolean): void {
  const detail = { element };
  element.dispatchEvent(new CustomEvent('elisym-close', { bubbles: true, detail }));
  if (!reachesPage) {
    document.dispatchEvent(new CustomEvent('elisym-close', { bubbles: true, detail }));
  }
}

describe('an element inside a shadow root', () => {
  it('hears its close, which never leaves the shadow root', async () => {
    resetDocument();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const mounted = await mountInShadowRoot({ product: PRODUCT, onOpen, onClose });
    const element = mounted.element();
    loaderOpens(element);
    loaderCloses(element, true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    await mounted.unmount();
  });

  it('hears one close when the host is removed while the modal is open', async () => {
    resetDocument();
    const onClose = vi.fn();
    const mounted = await mountInShadowRoot({ product: PRODUCT, onClose });
    const element = mounted.element();
    loaderOpens(element);
    // Page code, not React, removes the host: the loader closes, on the element and on document.
    await act(async () => {
      mounted.shadow.host.remove();
      loaderCloses(element, false);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await mounted.unmount();
  });

  it('hears one close per opening, and none without one', async () => {
    resetDocument();
    const onClose = vi.fn();
    const mounted = await mountInShadowRoot({ product: PRODUCT, onClose });
    const element = mounted.element();
    loaderCloses(element, false);
    expect(onClose).not.toHaveBeenCalled();
    for (const opening of [1, 2]) {
      loaderOpens(element);
      element.dispatchEvent(
        new CustomEvent('elisym-close', { bubbles: true, composed: true, detail: { element } }),
      );
      expect(onClose).toHaveBeenCalledTimes(opening);
    }
    await mounted.unmount();
  });
});

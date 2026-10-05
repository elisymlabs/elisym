// @vitest-environment happy-dom
import { Activity, act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ElisymBuy, type ElisymBuyProps } from '../src';
import { resetDocument } from './mount';

const PRODUCT = 'naddr1qqtestproduct';

/**
 * The v3 loader's modal, as its open shadow root shows it: a `dialog` part,
 * opened with `showModal`, or, where that is missing, inside an overlay.
 */
class LoaderLikeElement extends HTMLElement {
  static readonly loader = 'v3';
  static withOverlay = false;
  private dialog: HTMLDialogElement | undefined;
  private overlay: HTMLDivElement | undefined;

  connectedCallback(): void {
    if (this.shadowRoot !== null) {
      return;
    }
    const root = this.attachShadow({ mode: 'open' });
    const dialog = document.createElement('dialog');
    dialog.setAttribute('part', 'dialog');
    this.dialog = dialog;
    if (LoaderLikeElement.withOverlay) {
      const overlay = document.createElement('div');
      overlay.hidden = true;
      overlay.append(dialog);
      root.append(overlay);
      this.overlay = overlay;
    } else {
      root.append(dialog);
    }
  }

  openModal(): void {
    if (this.overlay === undefined) {
      this.dialog?.setAttribute('open', '');
    } else {
      this.overlay.hidden = false;
    }
    this.dispatchEvent(new CustomEvent('elisym-open', { bubbles: true }));
  }

  closeModal(): void {
    if (this.overlay === undefined) {
      this.dialog?.removeAttribute('open');
    } else {
      this.overlay.hidden = true;
    }
    this.dispatchEvent(
      new CustomEvent('elisym-close', { bubbles: true, detail: { element: this } }),
    );
  }
}
customElements.define('elisym-buy', LoaderLikeElement);

function loaderElement(container: HTMLElement): LoaderLikeElement {
  const found = container.querySelector('elisym-buy');
  if (!(found instanceof LoaderLikeElement)) {
    throw new Error('no <elisym-buy> rendered');
  }
  return found;
}

describe('a modal already open when the component subscribes', () => {
  for (const withOverlay of [false, true]) {
    const path = withOverlay ? 'the overlay' : 'showModal';
    it(`counts its close after hiding and showing the component again (${path})`, async () => {
      resetDocument();
      LoaderLikeElement.withOverlay = withOverlay;
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      const onClose = vi.fn();
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const show = async (mode: 'visible' | 'hidden'): Promise<void> => {
        const props: ElisymBuyProps = { product: PRODUCT, onClose };
        await act(async () => {
          root.render(createElement(Activity, { mode, children: createElement(ElisymBuy, props) }));
        });
      };
      await show('visible');
      const element = loaderElement(container);
      element.openModal();
      // Hidden: the listeners go, the element and its open modal stay.
      await show('hidden');
      await show('visible');
      expect(loaderElement(container)).toBe(element);
      element.closeModal();
      expect(onClose).toHaveBeenCalledTimes(1);
      await act(async () => {
        root.unmount();
      });
    });
  }

  for (const withOverlay of [false, true]) {
    const path = withOverlay ? 'the overlay' : 'showModal';
    it(`counts no close for a modal built but closed (${path})`, async () => {
      resetDocument();
      LoaderLikeElement.withOverlay = withOverlay;
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      const onClose = vi.fn();
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(ElisymBuy, { product: PRODUCT, onClose }));
      });
      const element = loaderElement(container);
      // Opened and closed once: the loader's parts stay in the shadow root, closed.
      element.openModal();
      element.closeModal();
      await act(async () => {
        root.render(createElement(ElisymBuy, { product: PRODUCT, onClose, key: 'again' }));
      });
      const again = loaderElement(container);
      // Subscribed to a closed modal: a close with no opening before it counts for nothing.
      again.dispatchEvent(
        new CustomEvent('elisym-close', { bubbles: true, detail: { element: again } }),
      );
      expect(onClose).toHaveBeenCalledTimes(1);
      again.openModal();
      again.closeModal();
      expect(onClose).toHaveBeenCalledTimes(2);
      await act(async () => {
        root.unmount();
      });
    });
  }

  it('counts the close of a modal opened before the component subscribed', async () => {
    resetDocument();
    LoaderLikeElement.withOverlay = false;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    // Server-rendered markup, upgraded and opened before React hydrates it.
    container.innerHTML = `<elisym-buy product="${PRODUCT}"></elisym-buy>`;
    const element = loaderElement(container);
    element.openModal();
    const { hydrateRoot } = await import('react-dom/client');
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, createElement(ElisymBuy, { product: PRODUCT, onClose }));
    });
    expect(loaderElement(container)).toBe(element);
    element.closeModal();
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      root?.unmount();
    });
  });
});

describe('a browser without HTMLDialogElement (the fallback path)', () => {
  it('reads the overlay without the global, open and closed', async () => {
    const { loaderModalOpen } = await import('../src/loader-state');
    resetDocument();
    LoaderLikeElement.withOverlay = true;
    const element = document.createElement('elisym-buy');
    document.body.append(element);
    if (!(element instanceof LoaderLikeElement)) {
      throw new Error('not upgraded');
    }
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'HTMLDialogElement');
    Reflect.deleteProperty(globalThis, 'HTMLDialogElement');
    try {
      expect(typeof globalThis.HTMLDialogElement).toBe('undefined');
      expect(loaderModalOpen(element)).toBe(false);
      element.openModal();
      expect(loaderModalOpen(element)).toBe(true);
      element.closeModal();
      expect(loaderModalOpen(element)).toBe(false);
    } finally {
      if (saved !== undefined) {
        Object.defineProperty(globalThis, 'HTMLDialogElement', saved);
      }
    }
  });
});

describe('an element from another realm', () => {
  it('is read by its attributes', async () => {
    const { loaderModalOpen } = await import('../src/loader-state');
    const { Window } = await import('happy-dom');
    const other = new Window();
    const host = other.document.createElement('div');
    other.document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const overlay = other.document.createElement('div');
    overlay.hidden = true;
    const dialog = other.document.createElement('dialog');
    dialog.setAttribute('part', 'dialog');
    overlay.append(dialog);
    root.append(overlay);
    expect(loaderModalOpen(host)).toBe(false);
    overlay.hidden = false;
    expect(loaderModalOpen(host)).toBe(true);
    overlay.hidden = true;
    dialog.setAttribute('open', '');
    expect(loaderModalOpen(host)).toBe(true);
    await other.happyDOM.close();
  });
});

describe('nodes that are no instance of this realm', () => {
  it('are read by attributes alone', async () => {
    const { loaderModalOpen } = await import('../src/loader-state');
    const attributes = (names: string[]) => ({
      hasAttribute: (name: string) => names.includes(name),
    });
    const host = (dialogAttributes: string[], overlayAttributes: string[] | undefined) => {
      const overlay = overlayAttributes === undefined ? null : { ...attributes(overlayAttributes) };
      const dialog = { parentElement: overlay, ...attributes(dialogAttributes) };
      return { shadowRoot: { querySelector: () => dialog } };
    };
    expect(loaderModalOpen(host(['open'], undefined))).toBe(true);
    expect(loaderModalOpen(host([], undefined))).toBe(false);
    expect(loaderModalOpen(host([], []))).toBe(true);
    expect(loaderModalOpen(host([], ['hidden']))).toBe(false);
    expect(loaderModalOpen({ shadowRoot: null })).toBe(false);
  });
});

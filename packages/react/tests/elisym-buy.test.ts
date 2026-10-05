// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { V3_LOADER_INTEGRITY, V3_LOADER_SRC } from '../src';
import { loaderScripts, mount, resetDocument } from './mount';

const PRODUCT = 'naddr1qqtestproduct';

function fire(target: EventTarget, type: string, detail?: unknown): void {
  target.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
}

beforeEach(() => {
  resetDocument();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the loader script', () => {
  it('is added once per document, pinned, however many elements there are', async () => {
    const first = await mount({ product: PRODUCT });
    const second = await mount({ product: PRODUCT, display: 'inline' });
    const scripts = loaderScripts();
    expect(scripts).toHaveLength(1);
    const [script] = scripts;
    expect(script?.getAttribute('src')).toBe(V3_LOADER_SRC);
    expect(script?.getAttribute('integrity')).toBe(V3_LOADER_INTEGRITY);
    expect(script?.getAttribute('crossorigin')).toBe('anonymous');
    expect(script?.parentElement).toBe(document.head);
    await first.unmount();
    await second.unmount();
  });

  it('is not added again when the page already has it', async () => {
    const own = document.createElement('script');
    own.setAttribute('src', V3_LOADER_SRC);
    document.body.append(own);
    const mounted = await mount({ product: PRODUCT });
    expect(loaderScripts()).toEqual([own]);
    await mounted.unmount();
  });
});

describe('the element', () => {
  it('carries the attributes, leaving out false booleans', async () => {
    const mounted = await mount({
      product: PRODUCT,
      network: 'devnet',
      collectEmail: true,
      strictOrigin: false,
      className: 'buy',
    });
    const element = mounted.element();
    expect(element.getAttribute('product')).toBe(PRODUCT);
    expect(element.getAttribute('network')).toBe('devnet');
    expect(element.getAttribute('collect-email')).toBe('');
    expect(element.hasAttribute('strict-origin')).toBe(false);
    expect(element.getAttribute('class')).toBe('buy');

    await mounted.render({ product: PRODUCT, network: 'devnet', collectEmail: false });
    expect(element.hasAttribute('collect-email')).toBe(false);
    await mounted.unmount();
  });

  it('waits with a present, empty reference, then passes it with strict origin', async () => {
    const mounted = await mount({ product: PRODUCT, requireCustomerRef: true });
    const element = mounted.element();
    expect(element.getAttribute('customer-ref')).toBe('');
    expect(element.hasAttribute('strict-origin')).toBe(false);

    await mounted.render({ product: PRODUCT, requireCustomerRef: true, customerRef: 'user_42' });
    expect(element.getAttribute('customer-ref')).toBe('user_42');
    expect(element.getAttribute('strict-origin')).toBe('');
    await mounted.unmount();
  });
});

describe('the events', () => {
  it('calls the handlers, onPaid on completed only', async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const onStatus = vi.fn();
    const onPaid = vi.fn();
    const mounted = await mount({ product: PRODUCT, onOpen, onClose, onStatus, onPaid });
    const element = mounted.element();

    fire(element, 'elisym-open');
    fire(element, 'elisym-status', { state: 'paid' });
    fire(element, 'elisym-status', { state: 'completed' });
    fire(element, 'elisym-status', { state: 'not-a-state' });
    fire(element, 'elisym-close', { element });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onStatus.mock.calls).toEqual([['paid'], ['completed']]);
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    await mounted.unmount();
  });

  it('calls the latest handler after a re-render', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const mounted = await mount({ product: PRODUCT, onStatus: first });
    await mounted.render({ product: PRODUCT, onStatus: second });
    fire(mounted.element(), 'elisym-status', { state: 'ready' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('ready');
    await mounted.unmount();
  });

  it('hears a close fired on document for its own element only', async () => {
    const onClose = vi.fn();
    const mounted = await mount({ product: PRODUCT, onClose });
    const element = mounted.element();
    const other = document.createElement('elisym-buy');

    fire(element, 'elisym-open');
    // What the loader does for an element removed from the page while its modal is open.
    fire(document, 'elisym-close', { element: other });
    expect(onClose).not.toHaveBeenCalled();
    fire(document, 'elisym-close', { element });
    expect(onClose).toHaveBeenCalledTimes(1);
    await mounted.unmount();
  });

  it('removes its listeners on unmount', async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const onStatus = vi.fn();
    const mounted = await mount({ product: PRODUCT, onOpen, onClose, onStatus });
    const element = mounted.element();
    await mounted.unmount();
    await act(async () => {
      fire(element, 'elisym-open');
      fire(element, 'elisym-status', { state: 'ready' });
      fire(document, 'elisym-close', { element });
    });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

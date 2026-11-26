// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** What the loader told the page through `console.error`. */
function told(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((call: unknown[]) => call[0])
    .filter(
      (first: unknown): first is string => typeof first === 'string' && first.startsWith('elisym:'),
    );
}

describe('v4 after another loader defined <elisym-buy>', () => {
  it('says customer-ref needs v3 or v4 when an element on the page carries one', async () => {
    // An older loader (no `loader` marker) came first.
    customElements.define('elisym-buy', class extends HTMLElement {});
    const element = document.createElement('elisym-buy');
    element.setAttribute('customer-ref', 'user_42');
    document.body.appendChild(element);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await import('../src/embed/v4/embed');
    expect(told(errors)).toEqual([
      'elisym: customer-ref needs the v3 or v4 loader; another loader defined <elisym-buy> first',
    ]);
  });

  it('only warns when no element carries a reference', async () => {
    vi.resetModules();
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    document.body.appendChild(document.createElement('elisym-buy'));
    const listens = vi.spyOn(document, 'addEventListener');
    await import('../src/embed/v4/embed');
    expect(warnings).toHaveBeenCalledTimes(1);
    // The document is parsed already: nothing waits for it.
    expect(listens.mock.calls.some(([type]) => type === 'DOMContentLoaded')).toBe(false);
    expect(told(errors)).toEqual([]);
  });

  it('checks again once the document is parsed: a loader in the head sees no elements yet', async () => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const state = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    const listens = vi.spyOn(document, 'addEventListener');
    await import('../src/embed/v4/embed');
    expect(told(errors)).toEqual([]);
    expect(listens.mock.calls.some(([type]) => type === 'DOMContentLoaded')).toBe(true);
    // The body is parsed: an element with a reference is there now.
    const element = document.createElement('elisym-buy');
    element.setAttribute('customer-ref', 'user_42');
    document.body.appendChild(element);
    state.mockReturnValue('interactive');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(told(errors)).toEqual([
      'elisym: customer-ref needs the v3 or v4 loader; another loader defined <elisym-buy> first',
    ]);
  });

  it('says it once when the element is there both at load and once parsed', async () => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const element = document.createElement('elisym-buy');
    element.setAttribute('customer-ref', 'user_42');
    document.body.appendChild(element);
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    await import('../src/embed/v4/embed');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(told(errors)).toHaveLength(1);
  });
});

describe('the PayCore global', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'PayCore');
  });

  it('is defined when absent, as the loader the entry imports', async () => {
    vi.resetModules();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await import('../src/embed/v4/entry');
    const { PAY_CORE } = await import('../src/embed/v4/embed');
    expect(window.PayCore).toBe(PAY_CORE);
    expect(told(errors)).toEqual([]);
  });

  it('another v4 copy keeps the first one, silently', async () => {
    const first = { version: 'v4', open: () => undefined };
    window.PayCore = first;
    vi.resetModules();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await import('../src/embed/v4/entry');
    expect(window.PayCore).toBe(first);
    expect(told(errors)).toEqual([]);
  });

  const owned: [string, unknown][] = [
    ['an object of its own', { open: () => undefined }],
    ['another version', { version: 'v5', open: () => undefined }],
    ['null', null],
    ['a string', 'v4'],
  ];

  it.each(owned)('the page owning the name (%s) keeps it, and is told once', async (_name, own) => {
    window.PayCore = own;
    vi.resetModules();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await import('../src/embed/v4/entry');
    expect(window.PayCore).toBe(own);
    expect(told(errors)).toEqual([
      'elisym: window.PayCore is taken; PayCore.open is not available',
    ]);
  });
});

describe('a page that defines <elisym-checkout> itself', () => {
  it('makes PayCore.open throw a clear Error, with nothing appended', async () => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { PAY_CORE } = await import('../src/embed/v4/embed');
    const constructed = vi.fn();
    customElements.define(
      'elisym-checkout',
      class extends HTMLElement {
        constructor() {
          super();
          constructed();
        }
      },
    );
    let thrown: unknown;
    try {
      PAY_CORE.open({ product: 'naddr1qqtestproduct' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain('<elisym-checkout>');
    expect(constructed).not.toHaveBeenCalled();
    expect(document.querySelector('elisym-checkout')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });
});

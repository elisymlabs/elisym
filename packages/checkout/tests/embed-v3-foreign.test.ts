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

describe('v3 after another loader defined <elisym-buy>', () => {
  it('says customer-ref needs v3 when an element on the page carries one', async () => {
    // An older loader (no `loader` marker) came first.
    customElements.define('elisym-buy', class extends HTMLElement {});
    const element = document.createElement('elisym-buy');
    element.setAttribute('customer-ref', 'user_42');
    document.body.appendChild(element);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await import('../src/embed/v3/embed');
    expect(told(errors)).toEqual([
      'elisym: customer-ref needs the v3 loader; another loader defined <elisym-buy> first',
    ]);
  });

  it('only warns when no element carries a reference', async () => {
    vi.resetModules();
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    document.body.appendChild(document.createElement('elisym-buy'));
    await import('../src/embed/v3/embed');
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(told(errors)).toEqual([]);
  });

  it('checks again once the document is parsed: a loader in the head sees no elements yet', async () => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const state = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    await import('../src/embed/v3/embed');
    expect(told(errors)).toEqual([]);
    // The body is parsed: an element with a reference is there now.
    const element = document.createElement('elisym-buy');
    element.setAttribute('customer-ref', 'user_42');
    document.body.appendChild(element);
    state.mockReturnValue('interactive');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(told(errors)).toEqual([
      'elisym: customer-ref needs the v3 loader; another loader defined <elisym-buy> first',
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
    await import('../src/embed/v3/embed');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(told(errors)).toHaveLength(1);
  });
});

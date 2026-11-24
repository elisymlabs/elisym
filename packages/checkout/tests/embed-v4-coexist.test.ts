// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** What the loaders told the page through `console.error`. */
function told(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((call: unknown[]) => call[0])
    .filter(
      (first: unknown): first is string => typeof first === 'string' && first.startsWith('elisym:'),
    );
}

/**
 * v3 and v4 on one page (Askr adds v4 to a store whose button is v3): v3 owns
 * `<elisym-buy>`, and v4 adds `PayCore` without a false error or warning.
 */
describe('v4 after v3 defined <elisym-buy>', () => {
  it('says nothing, even with customer-ref on the page, and still opens from code', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const v3 = await import('../src/embed/v3/embed');
    const element = document.createElement('elisym-buy');
    element.setAttribute('product', 'naddr1qqtestproduct');
    element.setAttribute('customer-ref', 'user_42');
    document.body.appendChild(element);
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    const v4 = await import('../src/embed/v4/embed');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(customElements.get('elisym-buy')).toBe(v3.ElisymBuy);
    expect(warnings).not.toHaveBeenCalled();
    expect(told(errors)).toEqual([]);
    const handle = v4.PAY_CORE.open({ product: 'naddr1qqtestproduct', customerRef: 'user_42' });
    expect(document.querySelector('elisym-checkout')).not.toBeNull();
    handle.close();
    expect(document.querySelector('elisym-checkout')).toBeNull();
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('v4 after another script defined <pay-buy>', () => {
  it('only warns about <pay-buy>: customer-ref is about <elisym-buy>, which v4 owns', async () => {
    customElements.define('pay-buy', class extends HTMLElement {});
    const element = document.createElement('elisym-buy');
    element.setAttribute('customer-ref', 'user_42');
    document.body.appendChild(element);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const v4 = await import('../src/embed/v4/embed');
    expect(warnings.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'elisym: <pay-buy> is already defined; load one embed.js per page',
    ]);
    expect(
      errors.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].startsWith('elisym:'),
      ),
    ).toEqual([]);
    expect(customElements.get('elisym-buy')).toBe(v4.ElisymBuy);
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('v4 after v3 defined <elisym-buy>', () => {
  it('only warns: v3 reads customer-ref too, and <pay-buy> is still v4', async () => {
    const v3 = await import('../src/embed/v3/embed');
    const element = document.createElement('elisym-buy');
    element.setAttribute('customer-ref', 'user_42');
    document.body.appendChild(element);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const v4 = await import('../src/embed/v4/embed');
    expect(warnings.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'elisym: <elisym-buy> is already defined; load one embed.js per page',
    ]);
    expect(
      errors.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].startsWith('elisym:'),
      ),
    ).toEqual([]);
    expect(customElements.get('elisym-buy')).toBe(v3.ElisymBuy);
    expect(customElements.get('pay-buy')).toBe(v4.PayBuy);
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OLDER_LOADER_WARNING, mount, olderLoaderWarnings, resetDocument } from './mount';

/** A marker this package does not know: not trusted to take a customer reference. */
class UnknownLoaderElement extends HTMLElement {
  static readonly loader = 'v5';
}
customElements.define('elisym-buy', UnknownLoaderElement);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a loader with an unknown marker', () => {
  it('is told apart from v3 and v4', async () => {
    resetDocument();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = await mount({ product: 'naddr1qqtestproduct', customerRef: 'user_42' });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([[OLDER_LOADER_WARNING]]);
    await mounted.unmount();
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OLDER_LOADER_WARNING, mount, olderLoaderWarnings, resetDocument } from './mount';

/** A loader that marks itself, but not as v3. */
class OtherLoaderElement extends HTMLElement {
  static readonly loader = 'v2';
}
customElements.define('elisym-buy', OtherLoaderElement);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a loader marked as something other than v3', () => {
  it('is told apart from v3', async () => {
    resetDocument();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = await mount({ product: 'naddr1qqtestproduct', customerRef: 'user_42' });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([[OLDER_LOADER_WARNING]]);
    await mounted.unmount();
  });
});

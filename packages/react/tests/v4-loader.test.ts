// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoaderWarnings } from '../src/loader';
import { loaderScripts, mount, olderLoaderWarnings, resetDocument } from './mount';

const PRODUCT = 'naddr1qqtestproduct';

/** The v4 loader's class carries `loader = 'v4'` and, like v3, takes a customer reference. */
class V4LoaderElement extends HTMLElement {
  static readonly loader = 'v4';
}
customElements.define('elisym-buy', V4LoaderElement);

beforeEach(() => {
  resetDocument();
  resetLoaderWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the v4 loader came first', () => {
  it('adds no v3 script and says nothing when a reference is passed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = await mount({ product: PRODUCT, customerRef: 'user_42' });
    expect(loaderScripts()).toEqual([]);
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([]);
    await mounted.unmount();
  });
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoaderWarnings } from '../src/loader';
import {
  OLDER_LOADER_WARNING,
  loaderScripts,
  mount,
  olderLoaderWarnings,
  resetDocument,
} from './mount';

const PRODUCT = 'naddr1qqtestproduct';

/** v1 or v2: defines `<elisym-buy>` with no `loader` marker. */
class OlderLoaderElement extends HTMLElement {}
customElements.define('elisym-buy', OlderLoaderElement);

beforeEach(() => {
  resetDocument();
  resetLoaderWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an older loader came first', () => {
  it('adds no v3 script: the first loader owns every element', async () => {
    const mounted = await mount({ product: PRODUCT });
    expect(loaderScripts()).toEqual([]);
    await mounted.unmount();
  });

  it('says so once, as the loader does, when a reference is passed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await mount({ product: PRODUCT, customerRef: 'user_42' });
    const second = await mount({ product: PRODUCT, requireCustomerRef: true });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([[OLDER_LOADER_WARNING]]);
    await first.unmount();
    await second.unmount();
  });

  it('says nothing for an element with no reference', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = await mount({ product: PRODUCT });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([]);
    await mounted.unmount();
  });
});

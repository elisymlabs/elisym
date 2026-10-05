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

function pageLoads(version: string): HTMLScriptElement {
  const script = document.createElement('script');
  script.setAttribute('src', `https://pay.elisym.network/${version}/embed.js`);
  script.defer = true;
  document.head.append(script);
  return script;
}

beforeEach(() => {
  resetDocument();
  resetLoaderWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the page loads an older loader that has not run yet', () => {
  it('adds no v3 script on top, and says so when a reference is passed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const older = pageLoads('v2');
    const mounted = await mount({ product: PRODUCT, customerRef: 'user_42' });
    expect(loaderScripts()).toEqual([older]);
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([[OLDER_LOADER_WARNING]]);
    await mounted.unmount();
  });

  it('says nothing when the page loads v3 itself', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const own = pageLoads('v3');
    const mounted = await mount({ product: PRODUCT, customerRef: 'user_42' });
    expect(loaderScripts()).toEqual([own]);
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([]);
    await mounted.unmount();
  });

  it('says nothing for an empty reference that is not required', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pageLoads('v1');
    const mounted = await mount({ product: PRODUCT, customerRef: '' });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([]);
    await mounted.unmount();
  });
});

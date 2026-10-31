// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoaderWarnings } from '../src/loader';
import { loaderScripts, mount, olderLoaderWarnings, resetDocument } from './mount';

const PRODUCT = 'naddr1qqtestproduct';

beforeEach(() => {
  resetDocument();
  resetLoaderWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the default loader, with the page loading pay.elisym.network v4 itself', () => {
  it('adds no v3 on top, and v4 takes the reference: nothing said', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const script = document.createElement('script');
    script.setAttribute('src', 'https://pay.elisym.network/v4/embed.js');
    document.head.append(script);
    const mounted = await mount({ product: PRODUCT, customerRef: 'user_42' });
    expect(loaderScripts()).toEqual([script]);
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([]);
    await mounted.unmount();
  });
});

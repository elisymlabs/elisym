// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOADER, V3_LOADER_INTEGRITY, V3_LOADER_SRC } from '../src';
import { resetLoaderWarnings } from '../src/loader';
import {
  OLDER_LOADER_WARNING,
  loaderScripts,
  mount,
  olderLoaderWarnings,
  resetDocument,
} from './mount';

const PRODUCT = 'naddr1qqtestproduct';
const PARTNER = {
  src: 'https://pay.partner.example/v4/embed.js',
  integrity: `sha384-${'A'.repeat(64)}`,
};
const BAD_LOADER =
  'elisym: loader must be { src: https://<checkout host>/vN/embed.js, integrity: sha384-... }';

function pageLoads(src: string): HTMLScriptElement {
  const script = document.createElement('script');
  script.setAttribute('src', src);
  script.defer = true;
  document.head.append(script);
  return script;
}

function told(calls: unknown[][], message: string): unknown[][] {
  return calls.filter((call) => call[0] === message);
}

beforeEach(() => {
  resetDocument();
  resetLoaderWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the loader prop', () => {
  it('defaults to the pinned v3 on pay.elisym.network', async () => {
    expect(DEFAULT_LOADER).toEqual({ src: V3_LOADER_SRC, integrity: V3_LOADER_INTEGRITY });
    expect(Object.isFrozen(DEFAULT_LOADER)).toBe(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = await mount({ product: PRODUCT });
    const [script] = loaderScripts();
    expect(script?.getAttribute('src')).toBe(V3_LOADER_SRC);
    expect(script?.getAttribute('integrity')).toBe(V3_LOADER_INTEGRITY);
    await mounted.unmount();
  });

  it('adds the configured loader, pinned, once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await mount({ product: PRODUCT, loader: PARTNER });
    const second = await mount({ product: PRODUCT, loader: PARTNER });
    const scripts = loaderScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.getAttribute('src')).toBe(PARTNER.src);
    expect(scripts[0]?.getAttribute('integrity')).toBe(PARTNER.integrity);
    expect(scripts[0]?.getAttribute('crossorigin')).toBe('anonymous');
    await first.unmount();
    await second.unmount();
  });

  it('adds nothing when the page already loads a loader from that checkout', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const own = pageLoads('https://pay.partner.example/v4/embed.js');
    const mounted = await mount({ product: PRODUCT, loader: PARTNER });
    expect(loaderScripts()).toEqual([own]);
    await mounted.unmount();
  });

  it('a loader the page itself loads from another checkout is not the configured one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pageLoads(V3_LOADER_SRC);
    const mounted = await mount({ product: PRODUCT, loader: PARTNER });
    expect(loaderScripts().map((script) => script.getAttribute('src'))).toEqual([
      V3_LOADER_SRC,
      PARTNER.src,
    ]);
    await mounted.unmount();
  });

  it('refuses a src that is not a loader: no script, said once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const src of [
      'http://pay.partner.example/v4/embed.js',
      'https://pay.partner.example/embed.js',
      'https://pay.partner.example/v4/embed.js?x=1',
      'https://pay.partner.example/v4/embed.js#x',
      'https://user@pay.partner.example/v4/embed.js',
      'https://:secret@pay.partner.example/v4/embed.js',
      'javascript:alert(1)',
      'not a url',
    ]) {
      const mounted = await mount({ product: PRODUCT, loader: { src, integrity: 'sha384-x' } });
      await mounted.unmount();
    }
    expect(loaderScripts()).toEqual([]);
    expect(told(error.mock.calls, BAD_LOADER)).toEqual([[BAD_LOADER]]);
  });

  it('refuses an integrity that would load unpinned: no script, said once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const integrity of [
      '',
      'sha-384-abc',
      'sha384 abc',
      'md5-abc',
      'sha384-ab"c',
      'xsha384-abc',
      'foo sha384-abc',
      'sha384-abc foo',
    ]) {
      const mounted = await mount({ product: PRODUCT, loader: { src: PARTNER.src, integrity } });
      await mounted.unmount();
    }
    expect(loaderScripts()).toEqual([]);
    expect(told(error.mock.calls, BAD_LOADER)).toEqual([[BAD_LOADER]]);
  });

  it('takes a list of hashes, as SRI allows', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const integrity = `sha256-${'B'.repeat(43)}= sha384-${'A'.repeat(64)}`;
    const mounted = await mount({ product: PRODUCT, loader: { src: PARTNER.src, integrity } });
    expect(loaderScripts().map((script) => script.getAttribute('integrity'))).toEqual([integrity]);
    await mounted.unmount();
  });

  it("decides once per document: the page's own loader found, a later loader adds nothing", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const own = pageLoads(V3_LOADER_SRC);
    const mounted = await mount({ product: PRODUCT });
    await mounted.render({ product: PRODUCT, loader: PARTNER });
    const other = await mount({ product: PRODUCT, loader: PARTNER });
    expect(loaderScripts()).toEqual([own]);
    await mounted.unmount();
    await other.unmount();
  });

  it('adds one script per document: a loader set or changed later adds nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = await mount({ product: PRODUCT });
    await mounted.render({ product: PRODUCT, loader: PARTNER });
    const other = await mount({ product: PRODUCT, loader: PARTNER });
    expect(loaderScripts().map((script) => script.getAttribute('src'))).toEqual([V3_LOADER_SRC]);
    await mounted.unmount();
    await other.unmount();
  });

  it('reads a relative page script against the document base', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = document.createElement('base');
    base.setAttribute('href', 'https://pay.partner.example/shop/');
    document.head.append(base);
    const own = pageLoads('/v4/embed.js');
    const mounted = await mount({ product: PRODUCT, loader: PARTNER });
    expect(loaderScripts()).toEqual([own]);
    await mounted.unmount();
  });
});

describe('the identity check follows the configured loader', () => {
  it('a v4 not run yet from that checkout takes the reference: nothing said', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pageLoads('https://pay.partner.example/v4/embed.js');
    const mounted = await mount({ product: PRODUCT, customerRef: 'user_42', loader: PARTNER });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([]);
    await mounted.unmount();
  });

  it('an older loader from that checkout is said once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pageLoads('https://pay.partner.example/v2/embed.js');
    const mounted = await mount({ product: PRODUCT, customerRef: 'user_42', loader: PARTNER });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([[OLDER_LOADER_WARNING]]);
    await mounted.unmount();
  });

  it('the warning follows a loader changed after mount', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pageLoads('https://pay.partner.example/v2/embed.js');
    const mounted = await mount({ product: PRODUCT, customerRef: 'user_42' });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([]);
    await mounted.render({ product: PRODUCT, customerRef: 'user_42', loader: PARTNER });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([[OLDER_LOADER_WARNING]]);
    await mounted.unmount();
  });

  it('a later loader (v5) takes the reference too', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pageLoads('https://pay.partner.example/v5/embed.js');
    const mounted = await mount({ product: PRODUCT, customerRef: 'user_42', loader: PARTNER });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([]);
    await mounted.unmount();
  });

  it('an element defined by v4 takes the reference: nothing said', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = await mount({ product: PRODUCT, customerRef: 'user_42', loader: PARTNER });
    await act(async () => {
      customElements.define(
        'elisym-buy',
        class extends HTMLElement {
          static readonly loader = 'v4';
        },
      );
      await customElements.whenDefined('elisym-buy');
    });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([]);
    await mounted.unmount();
  });
});

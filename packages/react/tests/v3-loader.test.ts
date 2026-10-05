// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoaderWarnings } from '../src/loader';
import { mount, olderLoaderWarnings, resetDocument } from './mount';

const PRODUCT = 'naddr1qqtestproduct';

/** The v3 loader's class carries `loader = 'v3'`. */
class V3LoaderElement extends HTMLElement {
  static readonly loader = 'v3';
}

beforeEach(() => {
  resetDocument();
  resetLoaderWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the v3 loader', () => {
  it('says nothing when v3 defines the element after the component mounted', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = await mount({ product: PRODUCT, customerRef: 'user_42' });
    await act(async () => {
      customElements.define('elisym-buy', V3LoaderElement);
      await customElements.whenDefined('elisym-buy');
    });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([]);
    await mounted.unmount();
  });
});

// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoaderWarnings } from '../src/loader';
import { OLDER_LOADER_WARNING, mount, olderLoaderWarnings, resetDocument } from './mount';

const PRODUCT = 'naddr1qqtestproduct';
const PARTNER = {
  src: 'https://pay.partner.example/v4/embed.js',
  integrity: `sha384-${'A'.repeat(64)}`,
};

beforeEach(() => {
  resetDocument();
  resetLoaderWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a loader marker', () => {
  it('a malformed loader marker is not v3', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = await mount({ product: PRODUCT, customerRef: 'user_42', loader: PARTNER });
    await act(async () => {
      customElements.define(
        'elisym-buy',
        class extends HTMLElement {
          static readonly loader = 'v3-legacy';
        },
      );
      await customElements.whenDefined('elisym-buy');
    });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([[OLDER_LOADER_WARNING]]);
    await mounted.unmount();
  });
});

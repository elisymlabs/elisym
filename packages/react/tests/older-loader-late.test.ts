// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OLDER_LOADER_WARNING, mount, olderLoaderWarnings, resetDocument } from './mount';

/** v1 or v2: defines `<elisym-buy>` with no `loader` marker. */
class OlderLoaderElement extends HTMLElement {}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an older loader defines the element after the component mounted', () => {
  it('says so once it is defined', async () => {
    resetDocument();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = await mount({ product: 'naddr1qqtestproduct', customerRef: 'user_42' });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([]);
    await act(async () => {
      customElements.define('elisym-buy', OlderLoaderElement);
      await customElements.whenDefined('elisym-buy');
    });
    expect(olderLoaderWarnings(error.mock.calls)).toEqual([[OLDER_LOADER_WARNING]]);
    await mounted.unmount();
  });
});

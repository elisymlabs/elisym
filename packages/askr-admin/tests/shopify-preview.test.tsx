import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PREVIEW_SHOP, createMockServer } from '../src/shopify-preview/mock-server';
import { ShopifyApi } from '../src/shopify/api';
import { ShopifyApp } from '../src/shopify/ShopifyApp';
import { buttonNamed, type Mounted, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('the local preview of the embedded admin (dev only)', () => {
  it('walks onboarding, Free and settings on the fake server', async () => {
    const server = createMockServer({
      ownerManages: false,
      replaceNextFinish: false,
      suspended: false,
    });
    const api = new ShopifyApi({
      token: () => Promise.resolve('t'),
      base: '',
      fetch: server.fetch,
    });
    mounted = await mount(<ShopifyApp api={api} shop={PREVIEW_SHOP} apiKey="preview" />);
    const container = mounted.container;
    const text = () => container.textContent ?? '';
    await settle(() => text().includes('Set up Askr for'));
    await act(async () => buttonNamed(container, 'Set up Askr').click());
    await settle(() => text().includes('Save your owner key'));
    await act(async () =>
      (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
    );
    await act(async () => buttonNamed(container, 'Finish setup').click());
    await settle(() => text().includes('Start on Free'));
    await act(async () => buttonNamed(container, 'Start on Free').click());
    await settle(() => text().includes('Plan: free'));
    await act(async () => buttonNamed(container, 'Settings').click());
    await settle(() =>
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'Save'),
    );
    await act(async () => buttonNamed(container, 'Save').click());
    await settle(() => text().includes('Saved.'));
    expect(text()).toContain('Saved. Your assistant uses the new settings shortly.');
  }, 30_000);
});

import { buildCatalogAuth, buildConfigDelegation } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
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

describe('the preview mock answers like the server (dev only)', () => {
  async function onboarded(
    scenario = { ownerManages: false, replaceNextFinish: false, suspended: false },
  ) {
    const server = createMockServer(scenario);
    const api = new ShopifyApi({
      token: () => Promise.resolve('t'),
      base: '',
      fetch: server.fetch,
    });
    const ownerSecret = generateSecretKey();
    const keys = await api.begin(PREVIEW_SHOP, ownerSecret, await api.time());
    const events = [
      finalizeEvent(
        buildCatalogAuth({ key: keys.catalogKey, mode: 'hosted', createdAt: keys.now }),
        ownerSecret,
      ),
      finalizeEvent(
        buildConfigDelegation({ key: keys.delegate, createdAt: keys.now }),
        ownerSecret,
      ),
    ];
    return { server, api, events, scenario };
  }

  const settings = (origins: string[]) => ({
    origins,
    linkOrigins: [],
    name: 'Tea',
    language: 'en',
    currency: 'EUR',
    private: { voice: '', instructions: '', notes: '' },
  });

  it('refuses a forged finish and replaces the next one when asked', async () => {
    const { api, events, scenario } = await onboarded();
    const forged = { ...events[0], sig: events[1]?.sig } as NostrEvent;
    await expect(api.finish([forged, events[1] as NostrEvent])).rejects.toMatchObject({
      code: 'bad_events',
    });
    scenario.replaceNextFinish = true;
    await expect(api.finish(events)).rejects.toMatchObject({ code: 'onboarding_replaced' });
    expect((await api.finish(events)).onboarded).toBe(true);
  });

  it('keeps the shop origins, caps the extras, and refuses writes the server would', async () => {
    const { api, events, scenario } = await onboarded();
    const view = await api.finish(events);
    expect(view.store?.connector?.enabled).toBe(true);
    const extra = (count: number) =>
      Array.from({ length: count }, (_unused, index) => `https://d${index}.example`);
    await api.saveSettings(settings(extra(18)));
    const read = await api.settings();
    expect(read.config?.origins.slice(0, 2)).toEqual([
      'https://preview-tea.example',
      `https://${PREVIEW_SHOP}`,
    ]);
    expect(read.config?.origins).toHaveLength(20);
    await expect(api.saveSettings(settings(extra(19)))).rejects.toMatchObject({
      code: 'too_many_origins',
    });
    scenario.ownerManages = true;
    await expect(api.saveSettings(settings([]))).rejects.toMatchObject({ code: 'owner_managed' });
    scenario.suspended = true;
    await expect(api.freePlan()).rejects.toMatchObject({ code: 'not_pending' });
  });
});

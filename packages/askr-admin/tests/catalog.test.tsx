import { type CatalogItemInput, buildCatalogItemEvent, parseCatalogItem } from '@elisym/askr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductsSection } from '../src/components/ProductsSection';
import { importItems, removeItem, upsertItem } from '../src/lib/catalog';
import { inputOfListing } from '../src/lib/store-data';
import {
  adminConfig,
  failingReader,
  fakeApi,
  fakeReader,
  listing,
  sessionDeps,
  storeView,
} from './fakes';
import { type Mounted, buttonNamed, byId, click, mount, settle, typeInto } from './mount';

const MUG: CatalogItemInput = {
  d: 'mug',
  title: 'Mug',
  price: { amount: '12.50', currency: 'USD' },
  url: 'https://tea.example/mug',
  images: ['https://cdn.example/mug.jpg'],
  sku: 'SKU-MUG',
  attrs: [{ name: 'material', value: 'clay' }],
};
const TEAPOT: CatalogItemInput = {
  d: 'teapot',
  title: 'Teapot',
  price: { amount: '30', currency: 'USD' },
  options: [{ name: 'Size', values: ['S', 'L'] }],
  variants: [
    { id: 'tp-s', price: '30', available: true, values: ['S'] },
    { id: 'tp-l', price: '45', available: true, values: ['L'] },
  ],
};
const CUP: CatalogItemInput = {
  d: 'cup',
  title: 'Cup',
  price: { amount: '5', currency: 'USD' },
  visibility: 'sold-out',
};
const HIDDEN: CatalogItemInput = {
  d: 'old',
  title: 'Old',
  price: { amount: '1', currency: 'USD' },
  visibility: 'hidden',
};

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('the catalog helpers', () => {
  it('always return the whole list', () => {
    const catalog = [MUG, TEAPOT];
    expect(upsertItem(catalog, { ...MUG, title: 'Big mug' }).map((item) => item.title)).toEqual([
      'Big mug',
      'Teapot',
    ]);
    expect(upsertItem(catalog, CUP).map((item) => item.d)).toEqual(['mug', 'teapot', 'cup']);
    expect(removeItem(catalog, 'mug').map((item) => item.d)).toEqual(['teapot']);
    expect(
      importItems(catalog, [CUP, { ...MUG, title: 'New mug' }], 'merge').map((item) => item.title),
    ).toEqual(['New mug', 'Teapot', 'Cup']);
    expect(importItems(catalog, [CUP], 'replace').map((item) => item.d)).toEqual(['cup']);
  });

  it('read a listing back into the input that rebuilds the same listing, so an untouched product is unchanged', () => {
    for (const input of [MUG, TEAPOT, CUP]) {
      const event = listing(input);
      const item = parseCatalogItem(event, { role: 'catalog' });
      if (item === undefined) {
        throw new Error(`${input.d} does not parse`);
      }
      expect(buildCatalogItemEvent(inputOfListing(item)).tags).toEqual(event.tags);
      expect(buildCatalogItemEvent(inputOfListing(item)).content).toEqual(event.content);
    }
  });
});

describe('the product editor', () => {
  it('sends the full current list with one edit, first as a dry run, then to publish', async () => {
    const api = fakeApi();
    const reader = fakeReader([listing(MUG), listing(TEAPOT), listing(CUP), listing(HIDDEN)]);
    const reload = vi.fn(async () => undefined);
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(api, reader)}
        view={storeView()}
        config={adminConfig()}
        reload={reload}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Teapot'));

    const editButtons = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Edit',
    );
    const mugRow = editButtons.find((button) => button.closest('tr')?.textContent?.includes('Mug'));
    if (mugRow === undefined) {
      throw new Error('no mug row');
    }
    await click(mugRow);
    await typeInto(byId(container, 'product-title'), 'Big mug');
    await click(buttonNamed(container, 'Keep this product'));

    await click(buttonNamed(container, 'Review changes'));
    await click(buttonNamed(container, 'Publish'));

    const calls = vi.mocked(api.catalog).mock.calls;
    expect(calls.map((call) => call[1])).toEqual([true, false]);
    for (const [items] of calls) {
      expect(items.map((item) => item.d).sort()).toEqual(['cup', 'mug', 'teapot']);
      const mug = items.find((item) => item.d === 'mug');
      expect(mug).toMatchObject({
        title: 'Big mug',
        sku: 'SKU-MUG',
        attrs: [{ name: 'material', value: 'clay' }],
      });
      expect(items.find((item) => item.d === 'teapot')?.variants).toHaveLength(2);
    }
    expect(reload).toHaveBeenCalled();
  });

  it('a removed product is left out, everything else is sent', async () => {
    const api = fakeApi();
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(api, fakeReader([listing(MUG), listing(TEAPOT)]))}
        view={storeView()}
        config={adminConfig()}
        reload={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Teapot'));
    const removeTeapot = [...container.querySelectorAll('button')].find(
      (button) =>
        button.textContent === 'Remove' && button.closest('tr')?.textContent?.includes('Teapot'),
    );
    if (removeTeapot === undefined) {
      throw new Error('no teapot row');
    }
    await click(removeTeapot);
    await click(buttonNamed(container, 'Review changes'));
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0].map((item) => item.d)).toEqual(['mug']);
  });

  it('sends nothing when the current catalog could not be read', async () => {
    const api = fakeApi();
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(api, failingReader())}
        view={storeView()}
        config={adminConfig()}
        reload={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('could not be read'));
    expect(buttonNamed(container, 'Review changes').disabled).toBe(true);
    expect(buttonNamed(container, 'Publish').disabled).toBe(true);
    expect(api.catalog).not.toHaveBeenCalled();
  });

  it('is shown only for the admin source', async () => {
    const api = fakeApi();
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(api, fakeReader([listing(MUG)]))}
        view={storeView()}
        config={adminConfig({ source: { kind: 'catalog' }, catalogKey: 'a'.repeat(64) })}
        reload={async () => undefined}
      />,
    );
    expect(mounted.container.textContent).toContain('Your products come from');
    expect(mounted.container.querySelector('table')).toBeNull();
  });
});

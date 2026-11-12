import { type CatalogItemInput, buildCatalogItemEvent, parseCatalogItem } from '@elisym/askr';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CsvImport } from '../src/components/CsvImport';
import { ProductsSection } from '../src/components/ProductsSection';
import { importItems, removeItem, upsertItem } from '../src/lib/catalog';
import { MAX_CSV_BYTES } from '../src/lib/csv';
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

const EMPTY_DIFF = { created: [], updated: [], hidden: [], unchanged: [] };

function rowButton(container: HTMLElement, label: string, row: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === label && button.closest('tr')?.textContent?.includes(row),
  );
  if (found === undefined) {
    throw new Error(`no ${label} button in the ${row} row`);
  }
  return found;
}

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
      expect(items.map((item) => item.d).sort()).toEqual(['cup', 'mug', 'old', 'teapot']);
      expect(items.find((item) => item.d === 'old')?.visibility).toBe('hidden');
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

  it('reads nothing while a sync publishes, and reads again once it is done', async () => {
    const api = fakeApi();
    const reader = fakeReader([listing(MUG), listing(TEAPOT)]);
    const query = vi.spyOn(reader, 'query');
    const deps = sessionDeps(api, reader);
    const running = storeView({ catalogSync: { state: 'running', diff: EMPTY_DIFF } });
    const done = storeView({ catalogSync: { state: 'done', diff: EMPTY_DIFF } });
    const section = (view: ReturnType<typeof storeView>) => (
      <ProductsSection
        deps={deps}
        view={view}
        config={adminConfig()}
        reload={async () => undefined}
      />
    );
    mounted = await mount(section(running));
    const { container } = mounted;
    expect(query).not.toHaveBeenCalled();
    expect(buttonNamed(container, 'Review changes').disabled).toBe(true);
    expect(container.textContent).toContain('Products are being published');
    expect(container.querySelector('table')).toBeNull();

    await mounted.rerender(section(done));
    await settle(() => (container.textContent ?? '').includes('Teapot'));
    expect(query).toHaveBeenCalledTimes(1);
    expect(buttonNamed(container, 'Review changes').disabled).toBe(false);
  });

  it('an edit after a review drops the reviewed diff, so the old one cannot be published', async () => {
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
    await click(buttonNamed(container, 'Review changes'));
    expect(buttonNamed(container, 'Publish').disabled).toBe(false);
    await click(rowButton(container, 'Remove', 'Teapot'));
    expect(buttonNamed(container, 'Publish').disabled).toBe(true);
  });

  it('refuses a new product with an ID already in use', async () => {
    const api = fakeApi();
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(api, fakeReader([listing(MUG)]))}
        view={storeView()}
        config={adminConfig()}
        reload={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Mug'));
    await click(buttonNamed(container, 'Add a product'));
    await typeInto(byId(container, 'product-d'), 'mug');
    await typeInto(byId(container, 'product-title'), 'Other mug');
    await typeInto(byId(container, 'product-price'), '3');
    await click(buttonNamed(container, 'Keep this product'));
    expect(container.textContent).toContain('another product already uses "mug"');
    await click(buttonNamed(container, 'Cancel'));
    await click(buttonNamed(container, 'Review changes'));
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0].map((item) => item.title)).toEqual(['Mug']);
  });

  it('keeps the ID of a product being edited', async () => {
    const api = fakeApi();
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(api, fakeReader([listing(MUG)]))}
        view={storeView()}
        config={adminConfig()}
        reload={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Mug'));
    await click(rowButton(container, 'Edit', 'Mug'));
    await typeInto(byId(container, 'product-d'), 'renamed');
    await click(buttonNamed(container, 'Keep this product'));
    await click(buttonNamed(container, 'Review changes'));
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0].map((item) => item.d)).toEqual(['mug']);
  });
});

describe('the CSV import', () => {
  async function chooseFile(container: HTMLElement, text: string) {
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('no file input');
    }
    Object.defineProperty(input, 'files', {
      value: [new File([text], 'products.csv', { type: 'text/csv' })],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('replacing the catalog with a file that has bad rows needs an explicit acknowledgement', async () => {
    const onImport = vi.fn();
    mounted = await mount(<CsvImport currency="USD" onImport={onImport} />);
    const { container } = mounted;
    await chooseFile(container, 'd,title,price\na,A,1\nb,B,oops\n');
    await settle(() => (container.textContent ?? '').includes('1 product read'));
    const use = buttonNamed(container, 'Use these 1 products');
    expect(use.disabled).toBe(false);
    const replace = [...container.querySelectorAll('input[type="radio"]')][1];
    if (!(replace instanceof HTMLInputElement)) {
      throw new Error('no replace option');
    }
    await click(replace);
    expect(use.disabled).toBe(true);
    const acknowledge = container.querySelector('input[type="checkbox"]');
    if (!(acknowledge instanceof HTMLInputElement)) {
      throw new Error('no acknowledgement');
    }
    await click(acknowledge);
    expect(use.disabled).toBe(false);
    await click(use);
    expect(onImport).toHaveBeenCalledWith([expect.objectContaining({ d: 'a' })], 'replace');
  });

  it('refuses a file larger than the server takes, without reading it', async () => {
    mounted = await mount(<CsvImport currency="USD" onImport={() => undefined} />);
    const { container } = mounted;
    await chooseFile(container, 'x'.repeat(MAX_CSV_BYTES + 1));
    await settle(() => (container.textContent ?? '').includes('larger than 8 MB'));
  });
});

import {
  type CatalogItemInput,
  type SyncDiff,
  buildCatalogItemEvent,
  parseCatalogItem,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CsvImport } from '../src/components/CsvImport';
import { ProductsSection } from '../src/components/ProductsSection';
import { changesOf, importItems, removeItem, upsertItem } from '../src/lib/catalog';
import { MAX_CSV_BYTES } from '../src/lib/csv';
import { inputOfListing } from '../src/lib/store-data';
import {
  NOW,
  SERVER_KEY,
  SERVER_KEY_SECRET,
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

const EMPTY_DIFF: SyncDiff = { created: [], updated: [], hidden: [], unchanged: [] };

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
    // A connector listing: its platform id, and price-from stated though the listed variant prices agree.
    const SYNCED: CatalogItemInput = {
      d: 'shopify:42',
      title: 'Kettle',
      price: { amount: '20', currency: 'USD' },
      sourceId: '42',
      priceFrom: true,
    };
    for (const input of [MUG, TEAPOT, CUP, SYNCED]) {
      const event = listing(input);
      const item = parseCatalogItem(event);
      if (item === undefined) {
        throw new Error(`${input.d} does not parse`);
      }
      expect(buildCatalogItemEvent(inputOfListing(item)).tags).toEqual(event.tags);
      expect(buildCatalogItemEvent(inputOfListing(item)).content).toEqual(event.content);
    }
  });
});

describe('the change a publish sends', () => {
  it('holds new and changed products and removed IDs, nothing about the rest', () => {
    const baseline = [MUG, TEAPOT, CUP];
    const draft = [{ ...MUG, title: 'Big mug' }, TEAPOT, HIDDEN];
    expect(changesOf(baseline, draft)).toEqual({
      items: [{ ...MUG, title: 'Big mug' }, HIDDEN],
      hide: ['cup'],
      untouched: ['teapot'],
    });
  });

  it('takes an equal product built another way (other key order, undefined fields) as unchanged', () => {
    // The same fields in the reverse order, plus a field left undefined.
    const item: CatalogItemInput = {
      ...Object.fromEntries(Object.entries(MUG).reverse()),
      ...MUG,
      summary: undefined,
    };
    expect(changesOf([MUG], [item])).toEqual({ items: [], hide: [], untouched: ['mug'] });
    // Inside arrays too: variants with their keys in another order.
    const teapot: CatalogItemInput = {
      ...TEAPOT,
      variants: (TEAPOT.variants ?? []).map((variant) => ({
        values: variant.values,
        available: variant.available,
        price: variant.price,
        id: variant.id,
      })),
    };
    expect(changesOf([TEAPOT], [teapot]).items).toEqual([]);
    expect(
      changesOf([MUG], [{ ...MUG, price: { ...MUG.price, amount: '12.5' } }]).items,
    ).toHaveLength(1);
  });
});

describe('a publish with products the editor could not read', () => {
  it('removes a product ID the relay holds but the editor could not read', async () => {
    const api = fakeApi();
    const unreadable = finalizeEvent(
      {
        kind: 30402,
        created_at: NOW - 40,
        tags: [['d', 'broken']],
        content: '',
      },
      SERVER_KEY_SECRET,
    );
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(api, fakeReader([listing(MUG), unreadable]))}
        view={storeView()}
        config={adminConfig()}
        reload={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Mug'));
    expect(container.textContent).not.toContain('broken');
    await click(rowButton(container, 'Edit', 'Mug'));
    await typeInto(byId(container, 'product-title'), 'Big mug');
    await click(buttonNamed(container, 'Save'));
    await click(buttonNamed(container, 'Review changes'));
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0]).toMatchObject({ hide: ['broken'] });
  });

  it('leaves out deleted products, IDs off the pattern and forged listings, so nothing is left to publish', async () => {
    const api = fakeApi();
    const gone = listing({ ...TEAPOT, visibility: 'hidden' }, NOW - 60);
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: NOW - 30,
        tags: [['a', `30402:${SERVER_KEY}:teapot`]],
        content: '',
      },
      SERVER_KEY_SECRET,
    );
    const offPattern = finalizeEvent(
      { kind: 30402, created_at: NOW - 40, tags: [['d', 'odd id']], content: '' },
      SERVER_KEY_SECRET,
    );
    const forged: NostrEvent = JSON.parse(
      JSON.stringify({
        ...finalizeEvent(
          { kind: 30402, created_at: NOW - 40, tags: [['d', 'forged']], content: '' },
          SERVER_KEY_SECRET,
        ),
        sig: '0'.repeat(128),
      }),
    );
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(api, fakeReader([listing(MUG), gone, deletion, offPattern, forged]))}
        view={storeView()}
        config={adminConfig()}
        reload={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Mug'));
    await click(buttonNamed(container, 'Review changes'));
    expect(container.textContent).toContain('Nothing to publish');
    expect(api.catalog).not.toHaveBeenCalled();
  });
});

describe('the product editor', () => {
  it('sends only the edited product, first as a dry run, then to publish', async () => {
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
    await click(buttonNamed(container, 'Save'));

    await click(buttonNamed(container, 'Review changes'));
    // The products not sent show as unchanged in the review.
    expect(container.textContent).toContain('Unchanged: 3');
    await click(buttonNamed(container, 'Publish'));

    const calls = vi.mocked(api.catalog).mock.calls;
    expect(calls.map((call) => call[1])).toEqual([true, false]);
    for (const [change] of calls) {
      expect(change.hide).toEqual([]);
      expect(change.items).toHaveLength(1);
      expect(change.items[0]).toMatchObject({
        d: 'mug',
        title: 'Big mug',
        sku: 'SKU-MUG',
        attrs: [{ name: 'material', value: 'clay' }],
      });
    }
    expect(reload).toHaveBeenCalled();
  });

  it('a removed product is sent by ID only, and nothing else is sent', async () => {
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
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0]).toMatchObject({
      items: [],
      hide: ['teapot'],
    });
  });

  it('says there is nothing to publish when the draft is as read, and sends nothing', async () => {
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
    // Opening a product and keeping it as it is changes nothing either.
    await click(rowButton(container, 'Edit', 'Teapot'));
    await click(buttonNamed(container, 'Save'));
    await click(buttonNamed(container, 'Review changes'));
    expect(container.textContent).toContain(
      'Nothing to publish: your products are already as shown.',
    );
    expect(api.catalog).not.toHaveBeenCalled();
    expect(buttonNamed(container, 'Publish').disabled).toBe(true);
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
    // One read gives the listings and every product ID K has.
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
    await click(rowButton(container, 'Remove', 'Mug'));
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
    await click(buttonNamed(container, 'Save'));
    expect(container.textContent).toContain('another product already uses "mug"');
    await click(buttonNamed(container, 'Cancel'));
    await click(buttonNamed(container, 'Review changes'));
    expect(container.textContent).toContain('Nothing to publish');
    expect(api.catalog).not.toHaveBeenCalled();
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
    await typeInto(byId(container, 'product-title'), 'Mug 2');
    await click(buttonNamed(container, 'Save'));
    await click(buttonNamed(container, 'Review changes'));
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0].items.map((item) => item.d)).toEqual(['mug']);
  });
});

describe('a review in flight', () => {
  function pendingCatalog() {
    let answer: (diff: typeof EMPTY_DIFF) => void = () => undefined;
    const catalog = vi.fn(
      (_change: { items: readonly CatalogItemInput[]; hide: readonly string[] }, dryRun: boolean) =>
        dryRun
          ? new Promise<{ diff: typeof EMPTY_DIFF }>((resolve) => {
              answer = (diff) => resolve({ diff });
            })
          : Promise.resolve({ diff: EMPTY_DIFF, started: true }),
    );
    return { catalog, answer: (diff: typeof EMPTY_DIFF) => answer(diff) };
  }

  it('locks the open editor and the CSV import while a review is out, so nothing is lost', async () => {
    const pending = pendingCatalog();
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(
          fakeApi({ catalog: pending.catalog }),
          fakeReader([listing(MUG), listing(TEAPOT)]),
        )}
        view={storeView()}
        config={adminConfig()}
        reload={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Teapot'));
    await click(rowButton(container, 'Remove', 'Teapot'));
    await click(rowButton(container, 'Edit', 'Mug'));
    await click(buttonNamed(container, 'Review changes'));
    const keep = buttonNamed(container, 'Save');
    const file = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(keep.closest('fieldset')?.disabled).toBe(true);
    expect(file?.closest('fieldset')?.disabled).toBe(true);
    await act(async () => {
      pending.answer({ ...EMPTY_DIFF, hidden: ['teapot'], unchanged: ['mug'] });
    });
    expect(buttonNamed(container, 'Save').closest('fieldset')?.disabled).toBe(false);
    expect(container.querySelector('input[type="file"]')?.closest('fieldset')?.disabled).toBe(
      false,
    );
  });

  it('gives focus back to what opened the editor once it closes', async () => {
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(fakeApi(), fakeReader([listing(MUG), listing(TEAPOT)]))}
        view={storeView()}
        config={adminConfig()}
        reload={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Teapot'));
    const edit = rowButton(container, 'Edit', 'Teapot');
    edit.focus();
    await click(edit);
    expect(document.activeElement?.textContent).toBe('Edit Teapot');
    await click(buttonNamed(container, 'Cancel'));
    expect(document.activeElement).toBe(rowButton(container, 'Edit', 'Teapot'));
    const add = buttonNamed(container, 'Add a product');
    add.focus();
    await click(add);
    await click(buttonNamed(container, 'Cancel'));
    // Add a product was hidden while the editor was open, and is focused again once it is back.
    expect(document.activeElement).toBe(buttonNamed(container, 'Add a product'));
  });

  it('edit during the review: the list cannot change, and Publish sends exactly the reviewed list', async () => {
    const pending = pendingCatalog();
    const api = fakeApi({ catalog: pending.catalog });
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
    await click(rowButton(container, 'Edit', 'Mug'));
    await typeInto(byId(container, 'product-title'), 'Big mug');
    await click(buttonNamed(container, 'Save'));
    await click(buttonNamed(container, 'Review changes'));
    // Every editing control is switched off while the review is out.
    expect(rowButton(container, 'Remove', 'Teapot').closest('fieldset')?.disabled).toBe(true);
    // Add a product sits in the section header, outside that fieldset: it is off on its own.
    expect(buttonNamed(container, 'Add a product').disabled).toBe(true);
    await click(rowButton(container, 'Remove', 'Teapot'));
    await act(async () => {
      pending.answer({ ...EMPTY_DIFF, unchanged: ['mug', 'teapot'] });
    });
    expect(container.textContent).toContain('Teapot');
    expect(buttonNamed(container, 'Add a product').disabled).toBe(false);
    await click(buttonNamed(container, 'Publish'));
    expect(
      pending.catalog.mock.calls.map((call) => [
        call[0].items.map((item) => item.d),
        call[0].hide,
        call[1],
      ]),
    ).toEqual([
      [['mug'], [], true],
      [['mug'], [], false],
    ]);
  });

  it('drops the answer of a review whose list was replaced meanwhile, and closes the editor', async () => {
    const pending = pendingCatalog();
    const api = fakeApi({ catalog: pending.catalog });
    const deps = sessionDeps(api, fakeReader([listing(MUG), listing(TEAPOT)]));
    const section = (view: ReturnType<typeof storeView>) => (
      <ProductsSection
        deps={deps}
        view={view}
        config={adminConfig()}
        reload={async () => undefined}
      />
    );
    mounted = await mount(section(storeView()));
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Teapot'));
    await click(rowButton(container, 'Remove', 'Teapot'));
    await click(rowButton(container, 'Edit', 'Mug'));
    expect(container.querySelector('#product-title')).not.toBeNull();
    await click(buttonNamed(container, 'Review changes'));
    // A sync starts elsewhere: the draft is dropped while the review is still out.
    await mounted.rerender(
      section(storeView({ catalogSync: { state: 'running', diff: EMPTY_DIFF } })),
    );
    expect(container.querySelector('#product-title')).toBeNull();
    await mounted.rerender(
      section(storeView({ catalogSync: { state: 'done', diff: EMPTY_DIFF } })),
    );
    await settle(() => (container.textContent ?? '').includes('Teapot'));
    expect(container.querySelector('#product-title')).toBeNull();
    await act(async () => {
      pending.answer({ ...EMPTY_DIFF, hidden: ['teapot'] });
    });
    expect(container.textContent).not.toContain('Removed: 1');
    expect(buttonNamed(container, 'Publish').disabled).toBe(true);
  });

  it('after a failed publish, says the list was read again and offers the one it tried', async () => {
    const api = fakeApi();
    const deps = sessionDeps(api, fakeReader([listing(MUG), listing(TEAPOT)]));
    const section = (view: ReturnType<typeof storeView>) => (
      <ProductsSection
        deps={deps}
        view={view}
        config={adminConfig()}
        reload={async () => undefined}
      />
    );
    mounted = await mount(section(storeView()));
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Teapot'));
    await click(rowButton(container, 'Remove', 'Teapot'));
    await click(buttonNamed(container, 'Review changes'));
    await click(buttonNamed(container, 'Publish'));
    await mounted.rerender(
      section(storeView({ catalogSync: { state: 'running', diff: EMPTY_DIFF } })),
    );
    await mounted.rerender(
      section(
        storeView({ catalogSync: { state: 'failed', diff: EMPTY_DIFF, error: 'relay down' } }),
      ),
    );
    await settle(() => (container.textContent ?? '').includes('The last publish failed'));
    expect(container.textContent).toContain('Teapot');
    await click(buttonNamed(container, 'Restore the list you tried to publish'));
    expect(container.textContent).not.toContain('Teapot');
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
    mounted = await mount(<CsvImport currency="USD" current={[]} onImport={onImport} />);
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

  it('warns before a merge drops variants, options or attributes, not when the file carries them', async () => {
    const onImport = vi.fn();
    mounted = await mount(<CsvImport currency="USD" current={[TEAPOT, MUG]} onImport={onImport} />);
    const { container } = mounted;
    await chooseFile(
      container,
      ['d,title,price,option:Size', 'teapot,Teapot,30,S', 'teapot,,,L'].join('\n'),
    );
    await settle(() => (container.textContent ?? '').includes('1 product read'));
    expect(container.textContent).not.toContain('are lost');
    await chooseFile(container, 'd,title,price\nteapot,Teapot,30\nmug,Mug,12.50');
    await settle(() => (container.textContent ?? '').includes('2 products read'));
    expect(container.textContent).toContain('are lost: teapot, mug.');
    // A file that carries everything the current product has replaces it without a warning.
    await chooseFile(
      container,
      [
        'd,title,price,url,image,sku,attr:material',
        'mug,Mug,12.50,https://tea.example/mug,https://cdn.example/mug.jpg,SKU-MUG,clay',
      ].join('\n'),
    );
    await settle(() => (container.textContent ?? '').includes('1 product read'));
    expect(container.textContent).not.toContain('are lost');
    await chooseFile(
      container,
      [
        'd,title,price,url,image,attr:material',
        'mug,Mug,12.50,https://tea.example/mug,https://cdn.example/mug.jpg,clay',
      ].join('\n'),
    );
    await settle(() => (container.textContent ?? '').includes('are lost: mug.'));
  });

  it('refuses a file larger than the server takes, without reading it', async () => {
    mounted = await mount(<CsvImport currency="USD" current={[]} onImport={() => undefined} />);
    const { container } = mounted;
    await chooseFile(container, 'x'.repeat(MAX_CSV_BYTES + 1));
    await settle(() => (container.textContent ?? '').includes('larger than 8 MB'));
  });
});

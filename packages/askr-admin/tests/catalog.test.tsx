import {
  type CatalogItemInput,
  MAX_CSV_BYTES,
  type SyncDiff,
  buildCatalogItemEvent,
  parseCatalogItem,
} from '@elisym/askr';
import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { finalizeEvent } from 'nostr-tools/pure';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CsvImport } from '../src/components/CsvImport';
import { ProductsSection } from '../src/components/ProductsSection';
import { ApiError } from '../src/lib/api';
import { changesOf, importItems, removeItem, upsertItem } from '../src/lib/catalog';
import { CatalogQueue, type Outcome } from '../src/lib/catalog-writer';
import type { AdminClient } from '../src/lib/deps';
import type { RelayReader } from '../src/lib/relay';
import { inputOfListing, readCatalog } from '../src/lib/store-data';
import type { StoreView } from '../src/lib/types';
import {
  NOW,
  SERVER_KEY,
  SERVER_KEY_SECRET,
  adminConfig,
  catalogSyncOf,
  failingReader,
  fakeApi,
  fakeReader,
  listing,
  sessionDeps,
  storeView,
} from './fakes';
import {
  type Mounted,
  buttonNamed,
  byId,
  chooseOption,
  click,
  mount,
  settle,
  typeInto,
} from './mount';

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

/** A relay whose next reads can be held, and whose events can change, as the tests need. */
function relayOf(initial: readonly NostrEvent[]) {
  let events = [...initial];
  let held: ((events: readonly NostrEvent[]) => void) | undefined;
  let holdNext = false;
  const reader: RelayReader = {
    query: vi.fn(async (filter: Filter) => {
      if (holdNext) {
        holdNext = false;
        const answer = await new Promise<readonly NostrEvent[]>((resolve) => {
          held = resolve;
        });
        return answer.filter((event) => matchFilter(filter, event));
      }
      return events.filter((event) => matchFilter(filter, event));
    }),
  };
  return {
    reader,
    set: (next: readonly NostrEvent[]) => {
      events = [...next];
    },
    holdNextRead: () => {
      holdNext = true;
    },
    /** Answer the held read with `answer`. */
    releaseRead: (answer: readonly NostrEvent[]) => {
      held?.(answer);
      held = undefined;
    },
  };
}

/** The fake API's catalog, each real write held until `release` is called for it. */
function heldCatalog(api: AdminClient) {
  const real = vi.mocked(api.catalog).getMockImplementation();
  const gates: (() => void)[] = [];
  vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
    await new Promise<void>((resolve) => {
      gates.push(resolve);
    });
    if (real === undefined) {
      throw new Error('no catalog');
    }
    return real(change, dryRun);
  });
  return {
    sent: () => vi.mocked(api.catalog).mock.calls.length,
    release: async () => {
      await act(async () => {
        gates.shift()?.();
      });
    },
  };
}

const queues: CatalogQueue[] = [];

interface Setup {
  api?: AdminClient;
  reader?: RelayReader;
  view?: StoreView;
  onChoosePlan?: () => void;
  pollMs?: number;
}

/** The products page over its own catalog queue, as the session gives it. */
async function mountProducts({
  api = fakeApi(),
  reader = fakeReader([listing(MUG), listing(TEAPOT)]),
  view = storeView(),
  onChoosePlan,
  pollMs = 1,
}: Setup = {}) {
  const reload = vi.fn(async () => undefined);
  const queue = new CatalogQueue({
    api,
    reload,
    readProducts: () => readCatalog(reader, SERVER_KEY, NOW),
    pollMs,
  });
  queues.push(queue);
  const deps = sessionDeps(api, reader);
  const section = (shown: StoreView) => (
    <ProductsSection
      deps={deps}
      view={shown}
      config={adminConfig()}
      queue={queue}
      {...(onChoosePlan === undefined ? {} : { onChoosePlan })}
    />
  );
  mounted = await mount(section(view));
  return {
    api,
    queue,
    reload,
    container: mounted.container,
    rerender: (shown: StoreView) => mounted?.rerender(section(shown)) ?? Promise.resolve(),
  };
}

afterEach(() => {
  for (const queue of queues.splice(0)) {
    queue.dispose();
  }
});

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

function hasButton(container: HTMLElement, label: string): boolean {
  return [...container.querySelectorAll('button')].some((button) => button.textContent === label);
}

function sentChanges(api: AdminClient) {
  return vi.mocked(api.catalog).mock.calls.map(([change, dryRun]) => ({
    items: change.items.map((item) => item.d),
    hide: change.hide,
    dryRun,
  }));
}

async function chooseFile(container: HTMLElement, contents: string) {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('no file input');
  }
  Object.defineProperty(input, 'files', {
    value: [new File([contents], 'products.csv', { type: 'text/csv' })],
    configurable: true,
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function editTitle(container: HTMLElement, row: string, title: string) {
  await click(rowButton(container, 'Edit', row));
  await typeInto(byId(container, 'product-title'), title);
  await click(buttonNamed(container, 'Save'));
}

async function confirmRemove(container: HTMLElement, row: string) {
  await click(rowButton(container, 'Remove', row));
  const confirm = container.querySelector(`button[aria-label="Remove ${row} for good"]`);
  if (!(confirm instanceof HTMLButtonElement)) {
    throw new Error(`no confirmation for ${row}`);
  }
  await click(confirm);
}

const UNREADABLE = finalizeEvent(
  { kind: 30402, created_at: NOW - 40, tags: [['d', 'broken']], content: '' },
  SERVER_KEY_SECRET,
);

describe('listed products the editor cannot read', () => {
  it('are counted, never removed by a save, and removed together after one confirmation', async () => {
    const { api, container } = await mountProducts({
      reader: fakeReader([listing(MUG), UNREADABLE]),
    });
    await settle(() => text(container).includes('Mug'));
    expect(text(container)).not.toContain('broken');
    expect(text(container)).toContain(
      '1 listed product cannot be read right now; they count toward your plan.',
    );
    expect(text(container)).toContain('1 product (1 unreadable) of 500 your plan allows');
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('Saved. Big mug is live in the chat.'));
    expect(sentChanges(api)).toEqual([{ items: ['mug'], hide: [], dryRun: false }]);
    await click(buttonNamed(container, 'Remove them'));
    expect(text(container)).toContain('Remove 1 unreadable product? They disappear from the chat.');
    await click(buttonNamed(container, 'Remove'));
    await settle(() => text(container).includes('Removed 1 unreadable product.'));
    expect(vi.mocked(api.catalog).mock.calls[1]?.[0]).toEqual({ items: [], hide: ['broken'] });
  });

  it('leaves out deleted products, IDs off the pattern and forged listings: no notice, no hide', async () => {
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
    const { api, container } = await mountProducts({
      reader: fakeReader([listing(MUG), gone, deletion, offPattern, forged]),
    });
    await settle(() => text(container).includes('Mug'));
    expect(text(container)).not.toContain('cannot be read right now');
    expect(text(container)).toContain('1 product of 500');
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('Saved.'));
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0]).toEqual({
      items: [expect.objectContaining({ d: 'mug' })],
      hide: [],
    });
  });
});

describe('the product editor', () => {
  it('Save publishes only the edited product at once, with no dry run, and closes once done', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT), listing(CUP), listing(HIDDEN)]);
    const { api, container, reload } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    // The read after the write is held: the list shows the write without it.
    relay.holdNextRead();
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('Saved. Big mug is live in the chat.'));
    expect(container.querySelector('#product-title')).toBeNull();
    const calls = vi.mocked(api.catalog).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe(false);
    expect(calls[0]?.[0].hide).toEqual([]);
    expect(calls[0]?.[0].items).toEqual([
      expect.objectContaining({
        d: 'mug',
        title: 'Big mug',
        sku: 'SKU-MUG',
        attrs: [{ name: 'material', value: 'clay' }],
      }),
    ]);
    expect(rowButton(container, 'Edit', 'Big mug')).toBeDefined();
    // The store was read again on the 202 and once the write ended.
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('says a hidden product is hidden from the chat, a visible one live', async () => {
    const { container } = await mountProducts();
    await click(rowButton(container, 'Edit', 'Mug'));
    await chooseOption(byId(container, 'product-visibility'), 'hidden');
    await click(buttonNamed(container, 'Save'));
    await settle(() => text(container).includes('Saved. Mug is hidden from the chat.'));
  });

  it('Remove asks first, then sends the ID only; Keep sends nothing', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT)]);
    const { api, container } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    relay.holdNextRead();
    await click(rowButton(container, 'Remove', 'Teapot'));
    expect(text(container)).toContain('Remove Teapot? It disappears from the chat.');
    await click(buttonNamed(container, 'Keep'));
    expect(api.catalog).not.toHaveBeenCalled();
    await confirmRemove(container, 'Teapot');
    await settle(() => text(container).includes('Removed Teapot.'));
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0]).toEqual({ items: [], hide: ['teapot'] });
    expect(container.querySelector('tbody')?.textContent).not.toContain('Teapot');
  });

  it('a product saved as it was sends nothing', async () => {
    const { api, container } = await mountProducts();
    await settle(() => text(container).includes('Teapot'));
    await click(rowButton(container, 'Edit', 'Teapot'));
    await click(buttonNamed(container, 'Save'));
    expect(text(container)).toContain('Nothing changed in Teapot.');
    expect(api.catalog).not.toHaveBeenCalled();
  });

  it('offers no action while the current catalog could not be read', async () => {
    const { api, container } = await mountProducts({ reader: failingReader() });
    await settle(() => text(container).includes('could not be read'));
    expect(hasButton(container, 'Add a product')).toBe(false);
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(api.catalog).not.toHaveBeenCalled();
  });

  it('is shown only for the admin source', async () => {
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(fakeApi(), fakeReader([listing(MUG)]))}
        view={storeView()}
        config={adminConfig({ source: { kind: 'catalog' }, catalogKey: 'a'.repeat(64) })}
      />,
    );
    expect(mounted.container.textContent).toContain('Your products come from');
    expect(mounted.container.querySelector('table')).toBeNull();
  });

  it('keeps the list and an open editor while a sync publishes, and reads again after one from elsewhere', async () => {
    const reader = fakeReader([listing(MUG), listing(TEAPOT)]);
    const query = vi.spyOn(reader, 'query');
    const { container, rerender } = await mountProducts({ reader });
    await settle(() => text(container).includes('Teapot'));
    expect(query).toHaveBeenCalledTimes(1);
    await click(rowButton(container, 'Edit', 'Mug'));
    await typeInto(byId(container, 'product-title'), 'Mug 2');
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    expect(text(container)).toContain('Publishing products...');
    expect(container.querySelector('table')).not.toBeNull();
    expect(byId(container, 'product-title')).toHaveProperty('value', 'Mug 2');
    await rerender(storeView({ catalogSync: catalogSyncOf('done') }));
    await settle(() => query.mock.calls.length === 2);
    expect(byId(container, 'product-title')).toHaveProperty('value', 'Mug 2');
  });

  it('refuses a new product with an ID already in use', async () => {
    const { api, container } = await mountProducts({ reader: fakeReader([listing(MUG)]) });
    await settle(() => text(container).includes('Mug'));
    await click(buttonNamed(container, 'Add a product'));
    await typeInto(byId(container, 'product-d'), 'mug');
    await typeInto(byId(container, 'product-title'), 'Other mug');
    await typeInto(byId(container, 'product-price'), '3');
    await click(buttonNamed(container, 'Save'));
    expect(text(container)).toContain('another product already uses "mug"');
    await click(buttonNamed(container, 'Cancel'));
    expect(api.catalog).not.toHaveBeenCalled();
  });

  it('keeps the ID of a product being edited', async () => {
    const { api, container } = await mountProducts({ reader: fakeReader([listing(MUG)]) });
    await settle(() => text(container).includes('Mug'));
    await click(rowButton(container, 'Edit', 'Mug'));
    await typeInto(byId(container, 'product-d'), 'renamed');
    await typeInto(byId(container, 'product-title'), 'Mug 2');
    await click(buttonNamed(container, 'Save'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 1);
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0].items.map((item) => item.d)).toEqual(['mug']);
  });

  it('gives focus back to what opened the editor once it closes', async () => {
    const { container } = await mountProducts();
    await settle(() => text(container).includes('Teapot'));
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
});

describe('writes one after another', () => {
  it('a Save in flight, then a Remove and a CSV import: they wait, then go out in order', async () => {
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => held.sent() === 1);
    expect(text(container)).toContain('Publishing...');
    expect(buttonNamed(container, 'Cancel').disabled).toBe(true);
    expect(byId(container, 'product-title').closest('fieldset')?.disabled).toBe(true);
    // The row being saved takes no other action meanwhile.
    expect(rowButton(container, 'Edit', 'Mug').disabled).toBe(true);
    expect(rowButton(container, 'Remove', 'Mug').disabled).toBe(true);
    await confirmRemove(container, 'Teapot');
    expect(container.querySelector('tbody')?.textContent).toContain('Waiting...');
    expect(
      container.querySelector('button[aria-label="Cancel the change to Teapot"]'),
    ).not.toBeNull();
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    expect(text(container)).toContain('Waiting for the products being published');
    await held.release();
    await settle(() => held.sent() === 2);
    await held.release();
    await settle(() => held.sent() === 3);
    await held.release();
    await settle(() => text(container).includes('Published 1 product from the file.'));
    expect(sentChanges(api)).toEqual([
      { items: ['mug'], hide: [], dryRun: false },
      { items: [], hide: ['teapot'], dryRun: false },
      { items: ['cup'], hide: [], dryRun: false },
    ]);
  });

  it('Cancel takes a waiting Remove back: nothing is sent for it', async () => {
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await confirmRemove(container, 'Teapot');
    const cancel = container.querySelector('button[aria-label="Cancel the change to Teapot"]');
    if (!(cancel instanceof HTMLButtonElement)) {
      throw new Error('no cancel');
    }
    await click(cancel);
    expect(rowButton(container, 'Remove', 'Teapot').disabled).toBe(false);
    await held.release();
    await settle(() => text(container).includes('Saved.'));
    expect(sentChanges(api)).toEqual([{ items: ['mug'], hide: [], dryRun: false }]);
  });

  it('a failed Save keeps every field, and Save retries', async () => {
    const api = fakeApi();
    const real = vi.mocked(api.catalog).getMockImplementation();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw new ApiError(400, 'invalid_items', {
        issues: [{ path: [0, 'title'], message: 'too long' }],
      });
    });
    if (real === undefined) {
      throw new Error('no catalog');
    }
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('Some products are not valid'));
    expect(text(container)).toContain('item 1: title: too long');
    expect(byId(container, 'product-title')).toHaveProperty('value', 'Big mug');
    expect(container.querySelector('tbody')?.textContent).not.toContain('Big mug');
    await click(buttonNamed(container, 'Save'));
    await settle(() => text(container).includes('Saved. Big mug is live in the chat.'));
    expect(api.catalog).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new ApiError(0, 'network')],
    [new ApiError(502, 'unexpected')],
    [new ApiError(504, 'unexpected')],
  ])('a write whose answer was lost (%s) says to Refresh and applies nothing', async (lost) => {
    const api = fakeApi({
      catalog: vi.fn(async () => {
        throw lost;
      }),
    });
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('Press Refresh to check.'));
    expect(text(container)).toContain(
      'Sent, but whether it went through could not be read. Press Refresh to check.',
    );
    expect(container.querySelector('tbody')?.textContent).not.toContain('Big mug');
    await click(buttonNamed(container, 'Cancel'));
    await confirmRemove(container, 'Teapot');
    await settle(() => text(container).includes('Sent; press Refresh to check.'));
    expect(container.querySelector('tbody')?.textContent).toContain('Teapot');
  });

  it('a refusal stays a failure with its reason', async () => {
    const api = fakeApi({
      catalog: vi.fn(async () => {
        throw new ApiError(409, 'inactive');
      }),
    });
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    await settle(() => text(container).includes('Your store is not active yet'));
    expect(hasButton(container, 'Retry')).toBe(true);
    expect(text(container)).not.toContain('press Refresh');
  });

  it('refuses a new product whose ID a queued import takes', async () => {
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await click(buttonNamed(container, 'Add a product'));
    await typeInto(byId(container, 'product-d'), 'cup');
    await typeInto(byId(container, 'product-title'), 'Cup');
    await typeInto(byId(container, 'product-price'), '5');
    await click(buttonNamed(container, 'Save'));
    expect(text(container)).toContain('another product already uses "cup"');
    await held.release();
    await settle(() => held.sent() === 2);
    await held.release();
    await settle(() => text(container).includes('Published 1 product'));
  });

  it('an import is worked out against a fresh read, not the list as first shown', async () => {
    const relay = relayOf([listing(MUG)]);
    const api = fakeApi();
    const { container } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Mug'));
    // Elsewhere, the mug changed and a cup was added; the file has the old mug and the cup.
    relay.set([listing({ ...MUG, title: 'Changed mug' }), listing(CUP)]);
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => text(container).includes('Published 1 product'));
    // The cup is already there as in the file except its availability; nothing else is sent.
    expect(
      vi.mocked(api.catalog).mock.calls.map((call) => call[0].items.map((item) => item.d)),
    ).toEqual([['cup']]);
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0].hide).toEqual([]);
  });

  it('a read started before a write went through never overwrites it; the idle read after is shown', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT)]);
    const { container, rerender } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    // A sync from elsewhere ends: its read is slow to answer.
    relay.holdNextRead();
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    await rerender(storeView({ catalogSync: catalogSyncOf('done') }));
    relay.set([listing({ ...MUG, title: 'Big mug' }), listing(TEAPOT), listing(CUP)]);
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('Cup'));
    expect(container.querySelector('tbody')?.textContent).toContain('Big mug');
    await act(async () => {
      relay.releaseRead([listing(MUG), listing(TEAPOT)]);
    });
    expect(container.querySelector('tbody')?.textContent).toContain('Big mug');
    expect(container.querySelector('tbody')?.textContent).toContain('Cup');
  });

  it('a write waiting on a running sync does not stop the first read', async () => {
    const reader = fakeReader([listing(MUG), listing(TEAPOT)]);
    const query = vi.spyOn(reader, 'query');
    const api = fakeApi({
      catalog: vi.fn(async () => {
        throw new ApiError(409, 'sync_running');
      }),
    });
    const queue = new CatalogQueue({
      api,
      reload: async () => undefined,
      readProducts: () => readCatalog(reader, SERVER_KEY, NOW),
      pollMs: 5,
    });
    queues.push(queue);
    queue.enqueue({ kind: 'remove', ids: ['old'], label: 'Old' });
    await settle(() => queue.entries()[0]?.progress.state === 'waiting-sync');
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(api, reader)}
        view={storeView()}
        config={adminConfig()}
        queue={queue}
      />,
    );
    await settle(() => text(mounted?.container ?? document.body).includes('Teapot'));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('the read after a write waits until nothing is queued or waiting', async () => {
    const reader = fakeReader([listing(MUG), listing(TEAPOT)]);
    const query = vi.spyOn(reader, 'query');
    const api = fakeApi();
    const real = vi.mocked(api.catalog).getMockImplementation();
    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
      if (change.hide.includes('teapot')) {
        throw new ApiError(409, 'sync_running');
      }
      await gate;
      if (real === undefined) {
        throw new Error('no catalog');
      }
      return real(change, dryRun);
    });
    const { container } = await mountProducts({ api, reader, pollMs: 5 });
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await confirmRemove(container, 'Teapot');
    await act(async () => {
      letGo();
    });
    await settle(() => text(container).includes('Saved.'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length >= 2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(query).toHaveBeenCalledTimes(1);
    const cancel = container.querySelector('button[aria-label="Cancel the change to Teapot"]');
    if (!(cancel instanceof HTMLButtonElement)) {
      throw new Error('no cancel');
    }
    await click(cancel);
    await settle(() => query.mock.calls.length === 2);
  });
});

describe('replacing every product with a file', () => {
  it('is off while a write is queued and while an editor is open', async () => {
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    expect(buttonNamed(container, 'Replace all with 1 product').disabled).toBe(false);
    await click(rowButton(container, 'Edit', 'Mug'));
    expect(buttonNamed(container, 'Replace all with 1 product').disabled).toBe(true);
    await click(buttonNamed(container, 'Cancel'));
    await confirmRemove(container, 'Teapot');
    expect(buttonNamed(container, 'Replace all with 1 product').disabled).toBe(true);
    await held.release();
    await settle(() => !buttonNamed(container, 'Replace all with 1 product').disabled);
  });

  it('names the count from a fresh read, locks the rest while it asks, then publishes', async () => {
    const relay = relayOf([listing(MUG)]);
    const api = fakeApi();
    const { container } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Mug'));
    relay.set([listing(MUG), listing(TEAPOT)]);
    await chooseFile(container, 'd,title,price\ncup,Cup,5\nbad,Bad,oops\n');
    await settle(() => text(container).includes('1 product read'));
    const storeReads = vi.mocked(api.store).mock.calls.length;
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    expect(vi.mocked(api.store).mock.calls.length).toBe(storeReads + 1);
    expect(text(container)).toContain(
      'Replace all products? 2 products not in this file will be removed from the chat. 1 row with problems is left out.',
    );
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(buttonNamed(container, 'Add a product').disabled).toBe(true);
    expect(rowButton(container, 'Edit', 'Teapot').disabled).toBe(true);
    expect(rowButton(container, 'Remove', 'Mug').disabled).toBe(true);
    expect(buttonNamed(container, 'Import 1 product').disabled).toBe(true);
    relay.holdNextRead();
    await click(buttonNamed(container, 'Replace all'));
    await settle(() => text(container).includes('Published 1 product from the file.'));
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0]).toEqual({
      items: [expect.objectContaining({ d: 'cup' })],
      hide: ['mug', 'teapot'],
    });
    expect(container.querySelector('tbody')?.textContent).toContain('Cup');
    expect(container.querySelector('tbody')?.textContent).not.toContain('Teapot');
  });

  it('waits for a running sync before asking, and asks again when the count changed meanwhile', async () => {
    const relay = relayOf([listing(MUG)]);
    const api = fakeApi();
    const real = vi.mocked(api.catalog).getMockImplementation();
    let refusals = 0;
    vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
      if (refusals === 0) {
        refusals += 1;
        // While the write waits, another write adds a product.
        relay.set([listing(MUG), listing(TEAPOT)]);
        throw new ApiError(409, 'sync_running');
      }
      if (real === undefined) {
        throw new Error('no catalog');
      }
      return real(change, dryRun);
    });
    const { container } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Mug'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('1 product not in this file'));
    await click(buttonNamed(container, 'Replace all'));
    await settle(() => text(container).includes('2 products not in this file'));
    expect(api.catalog).toHaveBeenCalledTimes(1);
    await click(buttonNamed(container, 'Replace all'));
    await settle(() => text(container).includes('Published 1 product from the file.'));
    expect(vi.mocked(api.catalog).mock.calls[1]?.[0].hide).toEqual(['mug', 'teapot']);
  });

  it('waits for a sync shown running before reading, and can be cancelled meanwhile', async () => {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ catalogSync: catalogSyncOf('running') })),
    });
    const { container } = await mountProducts({ api, pollMs: 60_000 });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    expect(hasButton(container, 'Waiting for the running sync')).toBe(true);
    await click(buttonNamed(container, 'Cancel'));
    await settle(() => hasButton(container, 'Replace all with 1 product'));
    expect(text(container)).not.toContain('Replace all products?');
    expect(api.catalog).not.toHaveBeenCalled();
  });
});

describe('a store that cannot publish yet', () => {
  it('without a plan: sent to choose one, and no action that writes', async () => {
    const onChoosePlan = vi.fn();
    const { container } = await mountProducts({
      view: storeView({ status: 'pending', tier: null }),
      onChoosePlan,
    });
    await settle(() => text(container).includes('Teapot'));
    expect(text(container)).toContain('Choose a plan to add products.');
    expect(hasButton(container, 'Add a product')).toBe(false);
    expect(hasButton(container, 'Edit')).toBe(false);
    expect(hasButton(container, 'Remove')).toBe(false);
    expect(container.querySelector('input[type="file"]')).toBeNull();
    await click(buttonNamed(container, 'Choose a plan'));
    expect(onChoosePlan).toHaveBeenCalledTimes(1);
  });

  it.each([[storeView({ status: 'suspended' })], [storeView({ status: 'pending' })]])(
    'suspended, or pending on a plan we manage: the inactive wording',
    async (view) => {
      const { container } = await mountProducts({ view, onChoosePlan: () => undefined });
      await settle(() => text(container).includes('Teapot'));
      expect(text(container)).toContain('Your store is not active yet');
      expect(hasButton(container, 'Choose a plan')).toBe(false);
      expect(hasButton(container, 'Add a product')).toBe(false);
    },
  );
});

describe('the CSV import', () => {
  it('replacing all asks once, naming how many products go and how many rows are left out', async () => {
    const onImport = vi.fn(async (): Promise<Outcome> => ({ kind: 'ok', diff: EMPTY_DIFF }));
    mounted = await mount(
      <CsvImport currency="USD" current={[MUG, TEAPOT, CUP]} onImport={onImport} />,
    );
    const { container } = mounted;
    await chooseFile(container, 'd,title,price\nmug,Mug,1\nb,B,oops\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    expect(text(container)).toContain(
      'Replace all products? 2 products not in this file will be removed from the chat. 1 row with problems is left out.',
    );
    expect(onImport).not.toHaveBeenCalled();
    await click(buttonNamed(container, 'Keep my products'));
    expect(text(container)).not.toContain('Replace all products?');
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await click(buttonNamed(container, 'Replace all'));
    expect(onImport).toHaveBeenCalledWith([expect.objectContaining({ d: 'mug' })], 'replace');
  });

  it('adding the file publishes at once, with no question', async () => {
    const onImport = vi.fn(async (): Promise<Outcome> => ({ kind: 'ok', diff: EMPTY_DIFF }));
    mounted = await mount(<CsvImport currency="USD" current={[]} onImport={onImport} />);
    const { container } = mounted;
    await chooseFile(container, 'd,title,price\na,A,1\nb,B,oops\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    expect(onImport).toHaveBeenCalledWith([expect.objectContaining({ d: 'a' })], 'merge');
    await settle(() => !text(container).includes('1 product read'));
  });

  it('warns before an import drops variants, options or attributes, not when the file carries them', async () => {
    const onImport = vi.fn(async (): Promise<Outcome> => ({ kind: 'ok', diff: EMPTY_DIFF }));
    mounted = await mount(<CsvImport currency="USD" current={[TEAPOT, MUG]} onImport={onImport} />);
    const { container } = mounted;
    await chooseFile(
      container,
      ['d,title,price,option:Size', 'teapot,Teapot,30,S', 'teapot,,,L'].join('\n'),
    );
    await settle(() => text(container).includes('1 product read'));
    expect(text(container)).not.toContain('are lost');
    await chooseFile(container, 'd,title,price\nteapot,Teapot,30\nmug,Mug,12.50');
    await settle(() => text(container).includes('2 products read'));
    expect(text(container)).toContain('are lost: teapot, mug.');
    // A file that carries everything the current product has replaces it without a warning.
    await chooseFile(
      container,
      [
        'd,title,price,url,image,sku,attr:material',
        'mug,Mug,12.50,https://tea.example/mug,https://cdn.example/mug.jpg,SKU-MUG,clay',
      ].join('\n'),
    );
    await settle(() => text(container).includes('1 product read'));
    expect(text(container)).not.toContain('are lost');
    await chooseFile(
      container,
      [
        'd,title,price,url,image,attr:material',
        'mug,Mug,12.50,https://tea.example/mug,https://cdn.example/mug.jpg,clay',
      ].join('\n'),
    );
    await settle(() => text(container).includes('are lost: mug.'));
  });

  it('refuses a file larger than the server takes, without reading it', async () => {
    mounted = await mount(
      <CsvImport
        currency="USD"
        current={[]}
        onImport={() => Promise.resolve({ kind: 'ok', diff: EMPTY_DIFF })}
      />,
    );
    const { container } = mounted;
    await chooseFile(container, 'x'.repeat(MAX_CSV_BYTES + 1));
    await settle(() => text(container).includes('larger than 8 MB'));
  });
});

describe('review round 1', () => {
  it('while the open editor saves, no other product opens; the edited one cannot be removed', async () => {
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await click(rowButton(container, 'Edit', 'Mug'));
    expect(rowButton(container, 'Remove', 'Mug').disabled).toBe(true);
    expect(rowButton(container, 'Edit', 'Teapot').disabled).toBe(false);
    await typeInto(byId(container, 'product-title'), 'Big mug');
    await click(buttonNamed(container, 'Save'));
    await settle(() => held.sent() === 1);
    expect(rowButton(container, 'Edit', 'Teapot').disabled).toBe(true);
    // Remove on another row still queues.
    expect(rowButton(container, 'Remove', 'Teapot').disabled).toBe(false);
    await held.release();
    await settle(() => text(container).includes('Saved.'));
    expect(rowButton(container, 'Edit', 'Teapot').disabled).toBe(false);
  });

  it('a save taken back before it was sent says so, with every edit kept', async () => {
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    await editTitle(container, 'Mug', 'Big mug');
    expect(text(container)).toContain('Waiting for the products being published');
    await click(buttonNamed(container, 'Cancel'));
    expect(text(container)).toContain('Not sent. Your edits are kept.');
    expect(byId(container, 'product-title')).toHaveProperty('value', 'Big mug');
    await held.release();
    await settle(() => text(container).includes('Removed Teapot.'));
    expect(api.catalog).toHaveBeenCalledTimes(1);
  });

  it('nothing else can change while Replace all waits for a running sync, nor confirm once one runs', async () => {
    let syncing = true;
    const api = fakeApi({
      store: vi.fn(async () =>
        storeView({ catalogSync: syncing ? catalogSyncOf('running') : null }),
      ),
    });
    const { container, rerender } = await mountProducts({ api, pollMs: 5 });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    expect(hasButton(container, 'Waiting for the running sync')).toBe(true);
    expect(buttonNamed(container, 'Add a product').disabled).toBe(true);
    expect(rowButton(container, 'Remove', 'Mug').disabled).toBe(true);
    expect(rowButton(container, 'Edit', 'Mug').disabled).toBe(true);
    syncing = false;
    await settle(() => text(container).includes('Replace all products?'));
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    expect(buttonNamed(container, 'Replace all').disabled).toBe(true);
  });

  it('says why Replace all is off', async () => {
    const { container } = await mountProducts();
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    expect(text(container)).not.toContain('Replace all waits');
    await click(rowButton(container, 'Edit', 'Mug'));
    expect(text(container)).toContain('Replace all waits until the product editor is closed.');
  });

  it('waits at most its bound for a running sync before Replace all asks', async () => {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ catalogSync: catalogSyncOf('running') })),
    });
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    const before = vi.mocked(api.store).mock.calls.length;
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('already running'));
    expect(vi.mocked(api.store).mock.calls.length - before).toBe(11);
    expect(text(container)).not.toContain('Replace all products?');
  });

  it('leaving the page ends the wait before Replace all asks: no further store read', async () => {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ catalogSync: catalogSyncOf('running') })),
    });
    const { container } = await mountProducts({ api, pollMs: 20 });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await mounted?.unmount();
    mounted = undefined;
    const reads = vi.mocked(api.store).mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(api.store).toHaveBeenCalledTimes(reads);
  });

  it('unreadable products: a failed removal offers Retry, which shows the new try only', async () => {
    const api = fakeApi();
    const real = vi.mocked(api.catalog).getMockImplementation();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw new ApiError(409, 'inactive');
    });
    if (real === undefined) {
      throw new Error('no catalog');
    }
    const { queue, container } = await mountProducts({
      api,
      reader: fakeReader([listing(MUG), UNREADABLE]),
    });
    await settle(() => text(container).includes('Mug'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => text(container).includes('Your store is not active yet'));
    expect(hasButton(container, 'Remove them')).toBe(false);
    await click(buttonNamed(container, 'Retry'));
    await settle(() => text(container).includes('Removed 1 unreadable product.'));
    expect(text(container)).not.toContain('Your store is not active yet');
    expect(api.catalog).toHaveBeenCalledTimes(2);
    expect(queue.entries()).toEqual([]);
  });

  it('an import whose answer was lost says to Refresh', async () => {
    const api = fakeApi({
      catalog: vi.fn(async () => {
        throw new ApiError(0, 'network');
      }),
    });
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => text(container).includes('Press Refresh to check.'));
    expect(text(container)).toContain(
      'Sent; its result could not be read. Press Refresh to check.',
    );
  });

  it('an import that failed says so once, in its own panel', async () => {
    const api = fakeApi({
      catalog: vi.fn(async () => {
        throw new ApiError(409, 'inactive');
      }),
    });
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => text(container).includes('Your store is not active yet'));
    expect(text(container).split('Your store is not active yet')).toHaveLength(2);
  });

  it('the editor closes when the store stops being active', async () => {
    const { container, rerender } = await mountProducts();
    await settle(() => text(container).includes('Teapot'));
    await click(rowButton(container, 'Edit', 'Mug'));
    expect(container.querySelector('#product-title')).not.toBeNull();
    await rerender(storeView({ status: 'suspended' }));
    expect(container.querySelector('#product-title')).toBeNull();
  });

  it('reads nothing when our own sync ends: the result is applied already', async () => {
    const reader = fakeReader([listing(MUG), listing(TEAPOT)]);
    const query = vi.spyOn(reader, 'query');
    const { container, rerender } = await mountProducts({ reader });
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('Saved.'));
    await settle(() => query.mock.calls.length === 2);
    await rerender(storeView({ catalogSync: catalogSyncOf('running', { syncId: 'sync-1' }) }));
    await rerender(storeView({ catalogSync: catalogSyncOf('done', { syncId: 'sync-1' }) }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('after Replace all the file is the whole list: nothing reads as unreadable', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT)]);
    const { container } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    relay.holdNextRead();
    await click(buttonNamed(container, 'Replace all'));
    await settle(() => text(container).includes('Published 1 product from the file.'));
    expect(text(container)).not.toContain('cannot be read right now');
    expect(text(container)).toContain('1 product of 500');
  });

  it('a replace asked again shows the fresh list it counted', async () => {
    const relay = relayOf([listing(MUG)]);
    const api = fakeApi();
    const real = vi.mocked(api.catalog).getMockImplementation();
    let refused = false;
    vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
      if (!refused) {
        refused = true;
        relay.set([listing(MUG), listing(TEAPOT)]);
        throw new ApiError(409, 'sync_running');
      }
      if (real === undefined) {
        throw new Error('no catalog');
      }
      return real(change, dryRun);
    });
    const { container } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Mug'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    await click(buttonNamed(container, 'Replace all'));
    await settle(() => text(container).includes('2 products not in this file'));
    expect(container.querySelector('tbody')?.textContent).toContain('Teapot');
  });

  it('a replace asked again while the page was away says to choose the file again', async () => {
    const relay = relayOf([listing(MUG)]);
    const api = fakeApi();
    const real = vi.mocked(api.catalog).getMockImplementation();
    let refusing = true;
    let accepted = 0;
    vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
      if (refusing) {
        throw new ApiError(409, 'sync_running');
      }
      accepted += 1;
      if (real === undefined) {
        throw new Error('no catalog');
      }
      return real(change, dryRun);
    });
    const queue = new CatalogQueue({
      api,
      reload: async () => undefined,
      readProducts: () => readCatalog(relay.reader, SERVER_KEY, NOW),
      pollMs: 5,
    });
    queues.push(queue);
    const page = (
      <ProductsSection
        deps={sessionDeps(api, relay.reader)}
        view={storeView()}
        config={adminConfig()}
        queue={queue}
      />
    );
    mounted = await mount(page);
    let { container } = mounted;
    await settle(() => text(container).includes('Mug'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    await click(buttonNamed(container, 'Replace all'));
    await settle(() => queue.entries()[0]?.progress.state === 'waiting-sync');
    await mounted.unmount();
    relay.set([listing(MUG), listing(TEAPOT)]);
    refusing = false;
    await settle(() => queue.entries()[0]?.outcome !== undefined);
    mounted = await mount(page);
    container = mounted.container;
    await settle(() => text(container).includes('choose the file again to confirm the new count'));
    expect(queue.entries()).toEqual([]);
    // The confirmed replace was not sent against the changed catalog.
    expect(accepted).toBe(0);
  });

  it('after a write whose answer was lost, the relay is read again and shown', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT)]);
    const api = fakeApi({
      catalog: vi.fn(async () => {
        relay.set([listing({ ...MUG, title: 'Big mug' }), listing(TEAPOT)]);
        throw new ApiError(502, 'unexpected');
      }),
    });
    const { container } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('Press Refresh to check.'));
    await settle(() => (container.querySelector('tbody')?.textContent ?? '').includes('Big mug'));
  });
});

describe('review round 2', () => {
  /** A products page over a queue the test keeps, so a remount meets the same writes. */
  function pageOver(queue: CatalogQueue, api: AdminClient, reader: RelayReader) {
    return (
      <ProductsSection
        deps={sessionDeps(api, reader)}
        view={storeView()}
        config={adminConfig()}
        queue={queue}
      />
    );
  }

  function sharedQueue(api: AdminClient, reader: RelayReader) {
    const queue = new CatalogQueue({
      api,
      reload: async () => undefined,
      readProducts: () => readCatalog(reader, SERVER_KEY, NOW),
      pollMs: 1,
    });
    queues.push(queue);
    return queue;
  }

  const invalid = () =>
    new ApiError(400, 'invalid_items', { issues: [{ path: [0, 'title'], message: 'too long' }] });

  it('a lost removal of a readable product does not show as the unreadable ones failing', async () => {
    const events: NostrEvent[] = [listing(MUG), listing(TEAPOT), UNREADABLE];
    const reader: RelayReader = {
      query: async (filter: Filter) => events.filter((event) => matchFilter(filter, event)),
    };
    const api = fakeApi({
      catalog: vi.fn(async () => {
        // The removal went through, but its answer was lost.
        events.splice(1, 1);
        throw new ApiError(0, 'network');
      }),
    });
    const { container, queue } = await mountProducts({ api, reader });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    await settle(() => !text(container).includes('Teapot'));
    expect(text(container)).not.toContain('Sent; press Refresh to check.');
    expect(hasButton(container, 'Remove them')).toBe(true);
    // The read showed it gone: nothing is left of that removal.
    expect(queue.entries()).toEqual([]);
  });

  it('a shown failure left for another product does not reopen on return', async () => {
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw invalid();
    });
    const reader = fakeReader([listing(MUG), listing(TEAPOT)]);
    const queue = sharedQueue(api, reader);
    mounted = await mount(pageOver(queue, api, reader));
    let { container } = mounted;
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('too long'));
    await click(rowButton(container, 'Edit', 'Teapot'));
    await click(buttonNamed(container, 'Cancel'));
    await mounted.unmount();
    mounted = await mount(pageOver(queue, api, reader));
    container = mounted.container;
    await settle(() => text(container).includes('Teapot'));
    expect(container.querySelector('#product-title')).toBeNull();
    expect(queue.entries()).toEqual([]);
  });

  it('a failed save retried until it went through leaves nothing to reopen', async () => {
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw invalid();
    });
    const reader = fakeReader([listing(MUG), listing(TEAPOT)]);
    const queue = sharedQueue(api, reader);
    mounted = await mount(pageOver(queue, api, reader));
    let { container } = mounted;
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('too long'));
    await click(buttonNamed(container, 'Save'));
    await settle(() => text(container).includes('Saved.'));
    await mounted.unmount();
    mounted = await mount(pageOver(queue, api, reader));
    container = mounted.container;
    await settle(() => text(container).includes('Teapot'));
    expect(container.querySelector('#product-title')).toBeNull();
    expect(text(container)).not.toContain('too long');
  });

  it('a removal shows at once as gone from the plan count, before any read', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT)]);
    const { container } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    relay.holdNextRead();
    await confirmRemove(container, 'Teapot');
    await settle(() => text(container).includes('Removed Teapot.'));
    expect(text(container)).not.toContain('cannot be read right now');
    expect(text(container)).toContain('1 product of 500');
  });

  it('an import whose panel went away still says how it ended', async () => {
    const api = fakeApi();
    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    vi.mocked(api.catalog).mockImplementation(async () => {
      await gate;
      throw new ApiError(409, 'inactive');
    });
    const { container, rerender } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 1);
    await rerender(storeView({ status: 'suspended' }));
    expect(container.querySelector('input[type="file"]')).toBeNull();
    await act(async () => {
      letGo();
    });
    await settle(() =>
      text(container).includes(
        'Your store is not active yet: products, policies and the connector work once it is.',
      ),
    );
    // Its words twice: the page's own line about the store, and the import's ending.
    expect(text(container).split('Your store is not active yet')).toHaveLength(3);
  });
});

describe('review round 3', () => {
  const UNREADABLE_2 = finalizeEvent(
    { kind: 30402, created_at: NOW - 40, tags: [['d', 'broken2']], content: '' },
    SERVER_KEY_SECRET,
  );

  /** An import held at the server until `fail` refuses it. */
  function heldFailingImport(api: AdminClient) {
    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    vi.mocked(api.catalog).mockImplementation(async () => {
      await gate;
      throw new ApiError(400, 'bad_request');
    });
    return async () => {
      await act(async () => {
        letGo();
      });
    };
  }

  const REFUSED = 'The server could not read the request. Check the fields and retry.';

  async function startImport(container: HTMLElement, api: AdminClient) {
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 1);
  }

  it('an import whose panel came back while it waited still says how it ended', async () => {
    const api = fakeApi();
    const fail = heldFailingImport(api);
    const { container, rerender } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await startImport(container, api);
    await rerender(storeView({ status: 'suspended' }));
    await rerender(storeView());
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
    await fail();
    await settle(() => text(container).includes(REFUSED));
    expect(text(container).split(REFUSED)).toHaveLength(2);
  });

  it('an import whose panel came back after a failed read and Retry still says how it ended', async () => {
    const api = fakeApi();
    const fail = heldFailingImport(api);
    let failing = false;
    const events = [listing(MUG), listing(TEAPOT)];
    const reader: RelayReader = {
      query: async (filter: Filter) => {
        if (failing) {
          throw new Error('relay down');
        }
        return events.filter((event) => matchFilter(filter, event));
      },
    };
    const { container, rerender } = await mountProducts({ api, reader });
    await settle(() => text(container).includes('Teapot'));
    await startImport(container, api);
    // A sync from elsewhere ends and its read fails: the list and the panel go.
    failing = true;
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    await rerender(storeView({ catalogSync: catalogSyncOf('done') }));
    await settle(() => text(container).includes('could not be read'));
    expect(container.querySelector('input[type="file"]')).toBeNull();
    failing = false;
    await click(buttonNamed(container, 'Retry'));
    await settle(() => container.querySelector('input[type="file"]') !== null);
    await fail();
    await settle(() => text(container).includes(REFUSED));
    expect(text(container).split(REFUSED)).toHaveLength(2);
  });

  it('Retry of unreadable removals sends only those it tried that are still listed', async () => {
    const events: NostrEvent[] = [listing(MUG), UNREADABLE];
    const reader: RelayReader = {
      query: async (filter: Filter) => events.filter((event) => matchFilter(filter, event)),
    };
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      // Meanwhile another unreadable listing appears.
      events.push(UNREADABLE_2);
      throw new ApiError(409, 'inactive');
    });
    const { container } = await mountProducts({ api, reader });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => text(container).includes('2 listed products cannot be read'));
    await settle(() => hasButton(container, 'Retry'));
    await click(buttonNamed(container, 'Retry'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 2);
    expect(vi.mocked(api.catalog).mock.calls[1]?.[0].hide).toEqual(['broken']);
  });

  it('a failed removal of several unreadable products, some gone since, keeps its Retry', async () => {
    const events: NostrEvent[] = [listing(MUG), UNREADABLE, UNREADABLE_2];
    const reader: RelayReader = {
      query: async (filter: Filter) => events.filter((event) => matchFilter(filter, event)),
    };
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      events.splice(events.indexOf(UNREADABLE), 1);
      throw new ApiError(409, 'inactive');
    });
    const { container } = await mountProducts({ api, reader });
    await settle(() => text(container).includes('2 listed products cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => text(container).includes('1 listed product cannot be read'));
    expect(text(container)).toContain('Your store is not active yet');
    await click(buttonNamed(container, 'Retry'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 2);
    expect(vi.mocked(api.catalog).mock.calls[1]?.[0].hide).toEqual(['broken2']);
  });

  it('a failed removal of a readable product stays on its row, not in the unreadable notice', async () => {
    const api = fakeApi({
      catalog: vi.fn(async () => {
        throw new ApiError(409, 'inactive');
      }),
    });
    const { container } = await mountProducts({
      api,
      reader: fakeReader([listing(MUG), listing(TEAPOT), UNREADABLE]),
    });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    await settle(() => text(container).includes('Your store is not active yet'));
    const notice = [...container.querySelectorAll('[role="status"]')].find((element) =>
      (element.textContent ?? '').includes('cannot be read right now'),
    );
    expect(notice?.textContent).not.toContain('not active');
    expect(notice?.querySelector('button')?.textContent).toBe('Remove them');
  });

  it('a queued import locks Edit and Remove on the rows its file holds', async () => {
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    await chooseFile(container, 'd,title,price\nmug,Mug,3\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    expect(rowButton(container, 'Edit', 'Mug').disabled).toBe(true);
    expect(rowButton(container, 'Remove', 'Mug').disabled).toBe(true);
    await held.release();
    await settle(() => held.sent() === 2);
    await held.release();
    await settle(() => text(container).includes('Published 1 product'));
  });
});

describe('review round 4', () => {
  const UNREADABLE_2 = finalizeEvent(
    { kind: 30402, created_at: NOW - 40, tags: [['d', 'broken2']], content: '' },
    SERVER_KEY_SECRET,
  );

  it('Retry never deletes an unreadable listing that has become readable; its row stays its own', async () => {
    const events: NostrEvent[] = [listing(MUG), UNREADABLE, UNREADABLE_2];
    const reader: RelayReader = {
      query: async (filter: Filter) => events.filter((event) => matchFilter(filter, event)),
    };
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      // A newer, readable version of one of them is published meanwhile.
      events.splice(
        events.indexOf(UNREADABLE),
        1,
        listing({ ...MUG, d: 'broken', title: 'Fixed' }, NOW - 30),
      );
      throw new ApiError(409, 'inactive');
    });
    const { container } = await mountProducts({ api, reader });
    await settle(() => text(container).includes('2 listed products cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => text(container).includes('1 listed product cannot be read'));
    expect(rowButton(container, 'Edit', 'Fixed').disabled).toBe(false);
    expect(rowButton(container, 'Remove', 'Fixed').disabled).toBe(false);
    expect(container.querySelector('tbody')?.textContent).not.toContain('Retry');
    await click(buttonNamed(container, 'Retry'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 2);
    expect(vi.mocked(api.catalog).mock.calls[1]?.[0].hide).toEqual(['broken2']);
  });

  it('the read before Replace all keeps a failed removal whose products are still listed and unreadable', async () => {
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw new ApiError(409, 'inactive');
    });
    const { container } = await mountProducts({
      api,
      reader: fakeReader([listing(MUG), UNREADABLE]),
    });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => text(container).includes('Your store is not active yet'));
    await chooseFile(container, 'd,title,price\nmug,Mug,12.50\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    expect(text(container)).toContain('Your store is not active yet');
    expect(hasButton(container, 'Retry')).toBe(true);
  });

  it('the read before Replace all asks also forgets a failed removal whose products are gone', async () => {
    const relay = relayOf([listing(MUG), UNREADABLE]);
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      // Gone elsewhere, another unreadable one listed; the read after the failure is slow.
      relay.set([listing(MUG), UNREADABLE_2]);
      relay.holdNextRead();
      throw new ApiError(409, 'inactive');
    });
    const { container, queue } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => text(container).includes('Your store is not active yet'));
    await chooseFile(container, 'd,title,price\nmug,Mug,12.50\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    expect(text(container)).not.toContain('Your store is not active yet');
    expect(hasButton(container, 'Retry')).toBe(false);
    expect(queue.entries()).toEqual([]);
  });
});

describe('review round 5', () => {
  const UNREADABLE_2 = finalizeEvent(
    { kind: 30402, created_at: NOW - 40, tags: [['d', 'broken2']], content: '' },
    SERVER_KEY_SECRET,
  );

  async function failUnreadableRemoval(container: HTMLElement) {
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
  }

  it('a failed try whose products all read now is gone; another unreadable one gets its own Remove them', async () => {
    const relay = relayOf([listing(MUG), UNREADABLE]);
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      relay.set([
        listing(MUG),
        listing({ ...MUG, d: 'broken', title: 'Fixed' }, NOW - 30),
        UNREADABLE_2,
      ]);
      throw new ApiError(409, 'inactive');
    });
    const { container, queue } = await mountProducts({ api, reader: relay.reader });
    await failUnreadableRemoval(container);
    await settle(() => text(container).includes('Fixed'));
    expect(text(container)).toContain('1 listed product cannot be read');
    expect(text(container)).not.toContain('Your store is not active yet');
    expect(hasButton(container, 'Retry')).toBe(false);
    expect(hasButton(container, 'Remove them')).toBe(true);
    expect(queue.entries()).toEqual([]);
  });

  it('while the removal of unreadable products is on its way, a row that became readable shows it, with Cancel', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT), UNREADABLE]);
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container, rerender } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    // A Teapot removal goes first, so the unreadable one waits behind it.
    await confirmRemove(container, 'Teapot');
    await failUnreadableRemoval(container);
    // Meanwhile broken reads: the page is read again by a sync from elsewhere.
    relay.set([
      listing(MUG),
      listing(TEAPOT),
      listing({ ...MUG, d: 'broken', title: 'Fixed' }, NOW - 30),
    ]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    await rerender(storeView({ catalogSync: catalogSyncOf('done') }));
    await settle(() => (container.querySelector('tbody')?.textContent ?? '').includes('Fixed'));
    const fixedRow = [...container.querySelectorAll('tr')].find((row) =>
      (row.textContent ?? '').includes('Fixed'),
    );
    expect(fixedRow?.textContent).toContain('Waiting...');
    expect(
      fixedRow?.querySelector('button[aria-label="Cancel the change to Fixed"]'),
    ).not.toBeNull();
    await held.release();
  });

  it('Retry on the unreadable notice is off while Replace all asks', async () => {
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw new ApiError(409, 'inactive');
    });
    const { container } = await mountProducts({
      api,
      reader: fakeReader([listing(MUG), UNREADABLE]),
    });
    await failUnreadableRemoval(container);
    await settle(() => text(container).includes('Your store is not active yet'));
    expect(buttonNamed(container, 'Retry').disabled).toBe(false);
    await chooseFile(container, 'd,title,price\nmug,Mug,12.50\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    expect(buttonNamed(container, 'Retry').disabled).toBe(true);
  });

  it('Dismiss on the unreadable notice clears the failure and brings Remove them back', async () => {
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw new ApiError(409, 'inactive');
    });
    const { container } = await mountProducts({
      api,
      reader: fakeReader([listing(MUG), UNREADABLE]),
    });
    await failUnreadableRemoval(container);
    await settle(() => text(container).includes('Your store is not active yet'));
    expect(hasButton(container, 'Remove them')).toBe(false);
    await click(buttonNamed(container, 'Dismiss'));
    expect(text(container)).not.toContain('Your store is not active yet');
    expect(hasButton(container, 'Remove them')).toBe(true);
  });
});

describe('review round 6', () => {
  const UNREADABLE_2 = finalizeEvent(
    { kind: 30402, created_at: NOW - 40, tags: [['d', 'broken2']], content: '' },
    SERVER_KEY_SECRET,
  );

  it('a failed try whose product reads now, before any read of the relay, leaves the notice its own Remove them', async () => {
    const relay = relayOf([listing(MUG), UNREADABLE]);
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      relay.set([listing(MUG), UNREADABLE, UNREADABLE_2]);
      throw new ApiError(409, 'inactive');
    });
    const { container, rerender } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(
      () =>
        text(container).includes('2 listed products cannot be read') &&
        hasButton(container, 'Retry'),
    );
    // A sync runs, so the page reads nothing; an import makes broken readable here.
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    await chooseFile(container, 'd,title,price\nbroken,Fixed,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => text(container).includes('Published 1 product'));
    expect(text(container)).not.toContain('Your store is not active yet');
    expect(hasButton(container, 'Retry')).toBe(false);
    expect(hasButton(container, 'Remove them')).toBe(true);
    // The newest try is the one the notice follows, not the stale one before it.
    const held = heldCatalog(api);
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => held.sent() === 3);
    expect(hasButton(container, 'Remove them')).toBe(false);
    expect(text(container)).toContain('Removing...');
    await held.release();
  });

  it('a lost answer for unreadable products that read now never shows on their rows', async () => {
    const events: NostrEvent[] = [listing(MUG), UNREADABLE, UNREADABLE_2];
    const reader: RelayReader = {
      query: async (filter: Filter) => events.filter((event) => matchFilter(filter, event)),
    };
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      events.splice(
        events.indexOf(UNREADABLE),
        1,
        listing({ ...MUG, d: 'broken', title: 'Fixed' }, NOW - 30),
      );
      throw new ApiError(0, 'network');
    });
    const { container } = await mountProducts({ api, reader });
    await settle(() => text(container).includes('2 listed products cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => text(container).includes('1 listed product cannot be read'));
    const fixedRow = [...container.querySelectorAll('tr')].find((row) =>
      (row.textContent ?? '').includes('Fixed'),
    );
    expect(fixedRow?.textContent).not.toContain('Sent; press Refresh to check.');
    expect(rowButton(container, 'Edit', 'Fixed').disabled).toBe(false);
  });

  it('a removal on its way whose product reads now leaves the notice its Remove them; the row keeps Waiting', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT), UNREADABLE]);
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container, rerender } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    relay.set([
      listing(MUG),
      listing(TEAPOT),
      listing({ ...MUG, d: 'broken', title: 'Fixed' }, NOW - 30),
      UNREADABLE_2,
    ]);
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    await rerender(storeView({ catalogSync: catalogSyncOf('done') }));
    await settle(() => (container.querySelector('tbody')?.textContent ?? '').includes('Fixed'));
    const notice = [...container.querySelectorAll('[role="status"]')].find((element) =>
      (element.textContent ?? '').includes('cannot be read right now'),
    );
    expect(notice?.textContent).not.toContain('Waiting...');
    expect(notice?.querySelector('button')?.textContent).toBe('Remove them');
    const fixedRow = [...container.querySelectorAll('tr')].find((row) =>
      (row.textContent ?? '').includes('Fixed'),
    );
    expect(fixedRow?.textContent).toContain('Waiting...');
    await held.release();
  });
});

describe('review round 7', () => {
  const unreadableOf = (d: string, createdAt: number) =>
    finalizeEvent(
      { kind: 30402, created_at: createdAt, tags: [['d', d]], content: '' },
      SERVER_KEY_SECRET,
    );

  function noticeOf(container: HTMLElement): Element | undefined {
    return [...container.querySelectorAll('[role="status"]')].find((element) =>
      (element.textContent ?? '').includes('cannot be read right now'),
    );
  }

  it('while readability flaps, a product is never confirmed or sent twice for removal', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT), unreadableOf('broken', NOW - 40)]);
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container, queue, rerender } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    // Queued behind the Teapot removal.
    expect(noticeOf(container)?.textContent).toContain('Waiting...');
    const readAgain = async () => {
      await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
      await rerender(storeView({ catalogSync: catalogSyncOf('done') }));
    };
    relay.set([
      listing(MUG),
      listing(TEAPOT),
      listing({ ...MUG, d: 'broken', title: 'Fixed' }, NOW - 30),
      unreadableOf('broken2', NOW - 40),
    ]);
    await readAgain();
    await settle(() => (container.querySelector('tbody')?.textContent ?? '').includes('Fixed'));
    await click(buttonNamed(container, 'Remove them'));
    expect(text(container)).toContain('Remove 1 unreadable product?');
    await click(buttonNamed(container, 'Remove'));
    relay.set([
      listing(MUG),
      listing(TEAPOT),
      unreadableOf('broken', NOW - 20),
      listing({ ...MUG, d: 'broken2', title: 'Fixed 2' }, NOW - 30),
    ]);
    await readAgain();
    await settle(() => (container.querySelector('tbody')?.textContent ?? '').includes('Fixed 2'));
    expect(hasButton(container, 'Remove them')).toBe(false);
    expect(noticeOf(container)?.textContent).toContain('Waiting...');
    const removals = queue
      .entries()
      .flatMap((entry) => (entry.op.kind === 'remove' ? [entry.op.ids] : []));
    expect(removals).toEqual([['teapot'], ['broken'], ['broken2']]);
    for (let round = 1; round <= 3; round += 1) {
      await settle(() => held.sent() === round);
      await held.release();
    }
    await settle(() => queue.entries().length === 0);
    expect(vi.mocked(api.catalog).mock.calls.map((call) => call[0].hide)).toEqual([
      ['teapot'],
      ['broken'],
      ['broken2'],
    ]);
  });

  it('a readable removal queued after an unreadable one leaves the notice on that one', async () => {
    const api = fakeApi();
    const held = heldCatalog(api);
    const heldImplementation = vi.mocked(api.catalog).getMockImplementation();
    let answered = 0;
    vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
      if (heldImplementation === undefined) {
        throw new Error('no catalog');
      }
      const answer = heldImplementation(change, dryRun);
      answered += 1;
      if (answered === 1) {
        await answer.catch(() => undefined);
        throw new ApiError(409, 'inactive');
      }
      return answer;
    });
    const { container } = await mountProducts({
      api,
      reader: fakeReader([listing(MUG), listing(TEAPOT), unreadableOf('broken', NOW - 40)]),
    });
    await settle(() => text(container).includes('Teapot'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => held.sent() === 1);
    await confirmRemove(container, 'Mug');
    expect(noticeOf(container)?.textContent).toContain('Removing...');
    expect(hasButton(container, 'Remove them')).toBe(false);
    await held.release();
    await settle(() => (noticeOf(container)?.textContent ?? '').includes('not active'));
    await confirmRemove(container, 'Teapot');
    expect(noticeOf(container)?.querySelector('button')?.textContent).toBe('Retry');
    await held.release();
    await held.release();
  });

  it('a lost answer for unreadable products still unreadable says to Refresh, with Retry and Dismiss', async () => {
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw new ApiError(0, 'network');
    });
    const { container } = await mountProducts({
      api,
      reader: fakeReader([listing(MUG), unreadableOf('broken', NOW - 40)]),
    });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() =>
      (noticeOf(container)?.textContent ?? '').includes('Sent; press Refresh to check.'),
    );
    const labels = [...(noticeOf(container)?.querySelectorAll('button') ?? [])].map(
      (button) => button.textContent,
    );
    expect(labels).toEqual(['Retry', 'Dismiss']);
  });

  it('an open confirmation to remove unreadable products cannot be sent while Replace all asks', async () => {
    const { container } = await mountProducts({
      reader: fakeReader([listing(MUG), unreadableOf('broken', NOW - 40)]),
    });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    const confirmRemoveButton = () =>
      [...(noticeOf(container)?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === 'Remove',
      );
    expect(confirmRemoveButton()?.disabled).toBe(false);
    await chooseFile(container, 'd,title,price\nmug,Mug,12.50\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    expect(confirmRemoveButton()?.disabled).toBe(true);
  });
});

describe('review round 7: a stale confirmation', () => {
  it('closes when the unreadable products it names change, and asks again for the new ones', async () => {
    const broken2 = finalizeEvent(
      { kind: 30402, created_at: NOW - 40, tags: [['d', 'broken2']], content: '' },
      SERVER_KEY_SECRET,
    );
    const relay = relayOf([listing(MUG), UNREADABLE]);
    const { api, container, rerender } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    expect(text(container)).toContain('Remove 1 unreadable product?');
    relay.set([listing(MUG), UNREADABLE, broken2]);
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    await rerender(storeView({ catalogSync: catalogSyncOf('done') }));
    await settle(() => text(container).includes('2 listed products cannot be read'));
    expect(text(container)).not.toContain('unreadable product?');
    await click(buttonNamed(container, 'Remove them'));
    expect(text(container)).toContain('Remove 2 unreadable products?');
    await click(buttonNamed(container, 'Remove'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 1);
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0].hide).toEqual(['broken', 'broken2']);
  });
});

describe('review round 8', () => {
  const unreadableOf = (d: string, createdAt = NOW - 40) =>
    finalizeEvent(
      { kind: 30402, created_at: createdAt, tags: [['d', d]], content: '' },
      SERVER_KEY_SECRET,
    );
  const readAgain = async (rerender: (view: StoreView) => Promise<void>) => {
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    await rerender(storeView({ catalogSync: catalogSyncOf('done') }));
  };
  function noticeOf(container: HTMLElement): Element | undefined {
    return [...container.querySelectorAll('[role="status"]')].find((element) =>
      (element.textContent ?? '').includes('cannot be read right now'),
    );
  }
  const NOT_ACTIVE = 'Your store is not active yet';
  const BAD_REQUEST = 'The server could not read the request.';

  /** Real writes held, and the first `refusals` refused with these errors once let go. */
  function heldRefusing(api: AdminClient, refusals: ApiError[]) {
    const held = heldCatalog(api);
    const heldImplementation = vi.mocked(api.catalog).getMockImplementation();
    let answered = 0;
    vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
      if (heldImplementation === undefined) {
        throw new Error('no catalog');
      }
      const answer = heldImplementation(change, dryRun);
      const refusal = refusals[answered];
      answered += 1;
      if (refusal !== undefined) {
        await answer.catch(() => undefined);
        throw refusal;
      }
      return answer;
    });
    return held;
  }

  it('a row removal whose product turns unreadable meanwhile is not offered again', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT)]);
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container, queue, rerender } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    relay.set([listing(MUG), unreadableOf('teapot', NOW - 20)]);
    await readAgain(rerender);
    await settle(() => text(container).includes('1 listed product cannot be read'));
    expect(hasButton(container, 'Remove them')).toBe(false);
    expect(noticeOf(container)?.textContent).toMatch(/Removing\.\.\.|Waiting\.\.\./u);
    expect(
      queue.entries().flatMap((entry) => (entry.op.kind === 'remove' ? [entry.op.ids] : [])),
    ).toEqual([['teapot']]);
    await held.release();
  });

  it('a confirmation closed because its products changed does not reopen when they change back', async () => {
    const relay = relayOf([listing(MUG), UNREADABLE]);
    const { container, rerender } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    expect(text(container)).toContain('Remove 1 unreadable product?');
    relay.set([listing(MUG), UNREADABLE, unreadableOf('broken2')]);
    await readAgain(rerender);
    await settle(() => text(container).includes('2 listed products cannot be read'));
    expect(text(container)).not.toContain('unreadable product?');
    relay.set([listing(MUG), UNREADABLE]);
    await readAgain(rerender);
    await settle(() => text(container).includes('1 listed product cannot be read'));
    expect(text(container)).not.toContain('unreadable product?');
  });

  it('a confirmation closed because its product read does not reopen when it is unreadable again', async () => {
    const relay = relayOf([listing(MUG), UNREADABLE]);
    const { container, rerender } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    relay.set([listing(MUG), listing({ ...MUG, d: 'broken', title: 'Fixed' }, NOW - 30)]);
    await readAgain(rerender);
    await settle(() => text(container).includes('Fixed'));
    expect(text(container)).not.toContain('cannot be read');
    relay.set([listing(MUG), UNREADABLE]);
    await readAgain(rerender);
    await settle(() => text(container).includes('1 listed product cannot be read'));
    expect(text(container)).not.toContain('unreadable product?');
  });

  it.each([
    ['shrinks', [UNREADABLE, unreadableOf('broken2')], [UNREADABLE], 2],
    ['swaps for another of the same size', [UNREADABLE], [unreadableOf('broken2')], 1],
  ])('a confirmation closes when its set %s', async (_change, before, after, count) => {
    const relay = relayOf([listing(MUG), ...before]);
    const { api, container, rerender } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('cannot be read right now'));
    await click(buttonNamed(container, 'Remove them'));
    expect(text(container)).toContain(`Remove ${count} unreadable product`);
    relay.set([listing(MUG), ...after]);
    await readAgain(rerender);
    await settle(() => !text(container).includes(`Remove ${count} unreadable product`));
    expect(text(container)).not.toContain('unreadable product?');
    expect(hasButton(container, 'Remove them')).toBe(true);
    expect(api.catalog).not.toHaveBeenCalled();
  });

  it('Keep closes the confirmation and sends nothing', async () => {
    const { api, container } = await mountProducts({
      reader: fakeReader([listing(MUG), UNREADABLE]),
    });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Keep'));
    expect(text(container)).not.toContain('unreadable product?');
    expect(hasButton(container, 'Remove them')).toBe(true);
    expect(api.catalog).not.toHaveBeenCalled();
  });

  it('of two tries on their way for products still unreadable, the newest shows', async () => {
    const relay = relayOf([listing(MUG), UNREADABLE]);
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container, rerender } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => held.sent() === 1);
    expect(noticeOf(container)?.textContent).toContain('Removing...');
    relay.set([
      listing(MUG),
      listing({ ...MUG, d: 'broken', title: 'Fixed' }, NOW - 30),
      unreadableOf('broken2'),
    ]);
    await readAgain(rerender);
    await settle(() => (container.querySelector('tbody')?.textContent ?? '').includes('Fixed'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    relay.set([listing(MUG), unreadableOf('broken', NOW - 20), unreadableOf('broken2')]);
    await readAgain(rerender);
    await settle(() => text(container).includes('2 listed products cannot be read'));
    // The first is being sent, the second waits behind it: the second is the one shown.
    expect(noticeOf(container)?.textContent).toContain('Waiting...');
    await held.release();
    await settle(() => held.sent() === 2);
    await held.release();
  });

  it('of two failed tries for products still unreadable, the newest one says why', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT), UNREADABLE]);
    const api = fakeApi();
    const held = heldRefusing(api, [
      new ApiError(409, 'inactive'),
      new ApiError(400, 'bad_request'),
    ]);
    const { container, rerender } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => held.sent() === 1);
    await held.release();
    await settle(() => (noticeOf(container)?.textContent ?? '').includes(NOT_ACTIVE));
    await confirmRemove(container, 'Teapot');
    await settle(() => held.sent() === 2);
    await held.release();
    await settle(() => text(container).includes(BAD_REQUEST));
    relay.set([listing(MUG), unreadableOf('teapot', NOW - 20), UNREADABLE]);
    await readAgain(rerender);
    await settle(() => text(container).includes('2 listed products cannot be read'));
    expect(noticeOf(container)?.textContent).toContain(BAD_REQUEST);
    expect(noticeOf(container)?.textContent).not.toContain(NOT_ACTIVE);
  });

  it('while a newer try is on its way, an older failure is not shown on the notice', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT), UNREADABLE]);
    const api = fakeApi();
    const held = heldRefusing(api, [new ApiError(409, 'inactive')]);
    const { container, rerender } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => held.sent() === 1);
    await held.release();
    await settle(() => (noticeOf(container)?.textContent ?? '').includes(NOT_ACTIVE));
    await confirmRemove(container, 'Teapot');
    await settle(() => held.sent() === 2);
    relay.set([listing(MUG), unreadableOf('teapot', NOW - 20), UNREADABLE]);
    await readAgain(rerender);
    await settle(() => text(container).includes('2 listed products cannot be read'));
    expect(noticeOf(container)?.textContent).toContain('Removing...');
    expect(noticeOf(container)?.textContent).not.toContain(NOT_ACTIVE);
    expect(hasButton(container, 'Retry')).toBe(false);
    await held.release();
  });

  it('a confirmation a try on its way took the notice from does not come back after it', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT), UNREADABLE]);
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container, rerender } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    await click(buttonNamed(container, 'Remove them'));
    expect(text(container)).toContain('Remove 1 unreadable product?');
    // Teapot turns unreadable while its removal is on its way: that try takes the notice.
    relay.set([listing(MUG), unreadableOf('teapot', NOW - 20), UNREADABLE]);
    await readAgain(rerender);
    await settle(() => text(container).includes('2 listed products cannot be read'));
    expect(noticeOf(container)?.textContent).toContain('Removing...');
    relay.holdNextRead();
    await held.release();
    await settle(() => text(container).includes('1 listed product cannot be read'));
    expect(text(container)).not.toContain('unreadable product?');
    expect(hasButton(container, 'Remove them')).toBe(true);
  });

  it('Remove them is off while Replace all asks', async () => {
    const { container } = await mountProducts({ reader: fakeReader([listing(MUG), UNREADABLE]) });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    expect(buttonNamed(container, 'Remove them').disabled).toBe(false);
    await chooseFile(container, 'd,title,price\nmug,Mug,12.50\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    expect(buttonNamed(container, 'Remove them').disabled).toBe(true);
  });
});

describe('review round 9', () => {
  const readAgain = async (rerender: (view: StoreView) => Promise<void>) => {
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    await rerender(storeView({ catalogSync: catalogSyncOf('done') }));
  };
  function flaky(initial: readonly NostrEvent[]) {
    let failing = false;
    const reader: RelayReader = {
      query: vi.fn(async (filter: Filter) => {
        if (failing) {
          throw new Error('down');
        }
        return initial.filter((event) => matchFilter(filter, event));
      }),
    };
    return {
      reader,
      fail: (next: boolean) => {
        failing = next;
      },
    };
  }

  it('an import of an unreadable product on its way is never followed by its removal', async () => {
    const relay = relayOf([listing(MUG), UNREADABLE]);
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    expect(text(container)).toContain('Remove 1 unreadable product?');
    await chooseFile(container, 'd,title,price\nbroken,Fixed,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => held.sent() === 1);
    // The open confirmation closes and none is offered while the import waits.
    expect(text(container)).not.toContain('unreadable product?');
    expect(hasButton(container, 'Remove them')).toBe(false);
    await held.release();
    await settle(() => text(container).includes('Published 1 product'));
    expect(sentChanges(api).some((change) => change.hide.includes('broken'))).toBe(false);
  });

  it('Retry of a failed removal whose product an import now covers sends nothing', async () => {
    const api = fakeApi();
    const held = heldCatalog(api);
    const heldImplementation = vi.mocked(api.catalog).getMockImplementation();
    let calls = 0;
    vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
      calls += 1;
      if (heldImplementation === undefined) {
        throw new Error('no catalog');
      }
      if (calls === 1) {
        throw new ApiError(409, 'inactive');
      }
      return heldImplementation(change, dryRun);
    });
    const { container, queue } = await mountProducts({
      api,
      reader: fakeReader([listing(MUG), UNREADABLE]),
    });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    await click(buttonNamed(container, 'Remove'));
    await settle(() => hasButton(container, 'Retry'));
    await chooseFile(container, 'd,title,price\nbroken,Fixed,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 2);
    await click(buttonNamed(container, 'Retry'));
    expect(queue.entries().filter((entry) => entry.op.kind === 'remove')).toEqual([]);
    await held.release();
    await settle(() => text(container).includes('Published 1 product'));
    expect(api.catalog).toHaveBeenCalledTimes(2);
  });

  it('a failed re-read shows no unreadable notice', async () => {
    const relay = flaky([listing(MUG), UNREADABLE]);
    const { container, rerender } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    relay.fail(true);
    await readAgain(rerender);
    await settle(() => text(container).includes('could not be read'));
    expect(text(container)).not.toContain('cannot be read right now');
  });

  it('a confirmation over a failed read does not come back after Retry', async () => {
    const relay = flaky([UNREADABLE]);
    const { container, rerender } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Remove them'));
    expect(text(container)).toContain('Remove 1 unreadable product?');
    relay.fail(true);
    await readAgain(rerender);
    await settle(() => text(container).includes('could not be read'));
    relay.fail(false);
    await click(buttonNamed(container, 'Retry'));
    await settle(() => text(container).includes('1 listed product cannot be read'));
    expect(text(container)).not.toContain('unreadable product?');
  });
});

describe('review round 10', () => {
  const BROKEN2 = finalizeEvent(
    { kind: 30402, created_at: NOW - 41, tags: [['d', 'broken2']], content: '' },
    SERVER_KEY_SECRET,
  );
  const MUG_UNREADABLE = finalizeEvent(
    { kind: 30402, created_at: NOW - 10, tags: [['d', 'mug']], content: '' },
    SERVER_KEY_SECRET,
  );
  const readAgain = async (rerender: (view: StoreView) => Promise<void>) => {
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    await rerender(storeView({ catalogSync: catalogSyncOf('done') }));
  };

  it('with one unreadable product covered by an import, Remove them offers and sends only the other', async () => {
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container } = await mountProducts({
      api,
      reader: fakeReader([listing(MUG), UNREADABLE, BROKEN2]),
    });
    await settle(() => text(container).includes('2 listed products cannot be read'));
    await chooseFile(container, 'd,title,price\nbroken,Fixed,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => held.sent() === 1);
    await click(buttonNamed(container, 'Remove them'));
    expect(text(container)).toContain('Remove 1 unreadable product?');
    await click(buttonNamed(container, 'Remove'));
    await held.release();
    await settle(() => held.sent() === 2);
    await held.release();
    await settle(() => text(container).includes('Removed'));
    expect(sentChanges(api).map((change) => change.hide)).toEqual([[], ['broken2']]);
  });

  it('a save on its way covers its product turned unreadable: no Remove them', async () => {
    const api = fakeApi();
    const held = heldCatalog(api);
    const relay = relayOf([listing(MUG), listing(TEAPOT)]);
    const { container, rerender } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => held.sent() === 1);
    relay.set([MUG_UNREADABLE, listing(TEAPOT)]);
    await readAgain(rerender);
    await settle(() => text(container).includes('1 listed product cannot be read'));
    expect(hasButton(container, 'Remove them')).toBe(false);
    await held.release();
  });

  it('a save that failed no longer covers its product: Remove them comes back', async () => {
    const api = fakeApi();
    heldCatalog(api);
    vi.mocked(api.catalog).mockRejectedValueOnce(new ApiError(400, 'bad_request'));
    const relay = relayOf([listing(MUG), listing(TEAPOT)]);
    const { container, rerender } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('The server could not read the request.'));
    relay.set([MUG_UNREADABLE, listing(TEAPOT)]);
    await readAgain(rerender);
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await settle(() => hasButton(container, 'Remove them'));
  });
});

describe('review round 11', () => {
  it('while a confirmed Replace all is on its way, Add, Edit and Remove stay off', async () => {
    const api = fakeApi();
    const held = heldCatalog(api);
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    await click(buttonNamed(container, 'Replace all'));
    await settle(() => held.sent() === 1);
    expect(buttonNamed(container, 'Add a product').disabled).toBe(true);
    expect(rowButton(container, 'Edit', 'Mug').disabled).toBe(true);
    expect(rowButton(container, 'Remove', 'Teapot').disabled).toBe(true);
    await held.release();
    await settle(() => text(container).includes('Published 1 product'));
  });

  it('an older read that fails after a write went through leaves the list and says nothing', async () => {
    let fail: (error: Error) => void = () => undefined;
    let holdNext = false;
    const events = [listing(MUG), listing(TEAPOT)];
    const reader: RelayReader = {
      query: async (filter: Filter) => {
        if (holdNext) {
          holdNext = false;
          await new Promise<void>((_resolve, reject) => {
            fail = reject;
          });
        }
        return events.filter((event) => matchFilter(filter, event));
      },
    };
    const { container, rerender } = await mountProducts({ reader });
    await settle(() => text(container).includes('Teapot'));
    holdNext = true;
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    await rerender(storeView({ catalogSync: catalogSyncOf('done') }));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('Saved.'));
    await act(async () => {
      fail(new Error('relay down'));
    });
    expect(text(container)).not.toContain('could not be read');
    expect(container.querySelector('tbody')?.textContent).toContain('Teapot');
  });
});

describe('the sweep', () => {
  const fileInput = (container: HTMLElement) => {
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('no file input');
    }
    return input;
  };
  const rowsInOrder = (container: HTMLElement) =>
    [...container.querySelectorAll('tbody tr')].map(
      (row) => row.querySelector('.font-mono')?.textContent,
    );
  function flakyReader(initial: readonly NostrEvent[]) {
    let failing = true;
    const reader: RelayReader = {
      query: async (filter: Filter) => {
        if (failing) {
          throw new Error('down');
        }
        return initial.filter((event) => matchFilter(filter, event));
      },
    };
    return { reader, heal: () => (failing = false) };
  }

  it('Nothing changed after a failed save closes it for good', async () => {
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw new ApiError(400, 'invalid_items', {
        issues: [{ path: [0, 'title'], message: 'too long' }],
      });
    });
    const reader = fakeReader([listing(MUG), listing(TEAPOT)]);
    const queue = new CatalogQueue({
      api,
      reload: async () => undefined,
      readProducts: () => readCatalog(reader, SERVER_KEY, NOW),
      pollMs: 1,
    });
    queues.push(queue);
    const page = (
      <ProductsSection
        deps={sessionDeps(api, reader)}
        view={storeView()}
        config={adminConfig()}
        queue={queue}
      />
    );
    mounted = await mount(page);
    let { container } = mounted;
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('too long'));
    await typeInto(byId(container, 'product-title'), 'Mug');
    await click(buttonNamed(container, 'Save'));
    expect(text(container)).toContain('Nothing changed in Mug.');
    expect(container.querySelector('#product-title')).toBeNull();
    await mounted.unmount();
    mounted = await mount(page);
    container = mounted.container;
    await settle(() => text(container).includes('Teapot'));
    expect(container.querySelector('#product-title')).toBeNull();
    expect(text(container)).not.toContain('too long');
  });

  it('a save waiting for a running sync says so', async () => {
    const api = fakeApi({
      catalog: vi.fn(async () => {
        throw new ApiError(409, 'sync_running');
      }),
    });
    const { container } = await mountProducts({ api, pollMs: 60_000 });
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('Waiting for the products being published'));
  });

  it('a save waiting while the store is set up says so', async () => {
    const api = fakeApi({
      catalog: vi.fn(async () => {
        throw new ApiError(409, 'sync_refused', { message: 'not yet' });
      }),
      store: vi.fn(async () => storeView({ events: { pending: 1, failing: [] } })),
    });
    const { container } = await mountProducts({ api, pollMs: 60_000 });
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() =>
      text(container).includes('Your store is being set up, your change goes out in a moment'),
    );
  });

  it('a row removal accepted and publishing says Removing...', async () => {
    const api = fakeApi({
      store: vi.fn(async () =>
        storeView({ catalogSync: catalogSyncOf('running', { syncId: 'sync-1' }) }),
      ),
    });
    const { container } = await mountProducts({ api, pollMs: 60_000 });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    await settle(() => vi.mocked(api.store).mock.calls.length >= 1);
    const teapotRow = [...container.querySelectorAll('tr')].find((row) =>
      (row.textContent ?? '').includes('Teapot'),
    );
    expect(teapotRow?.textContent).toContain('Removing...');
  });

  it('a new product shows in ID order at once, and so does the list a Replace all read', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT)]);
    const { container } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    relay.holdNextRead();
    await click(buttonNamed(container, 'Add a product'));
    await typeInto(byId(container, 'product-d'), 'apple');
    await typeInto(byId(container, 'product-title'), 'Apple');
    await typeInto(byId(container, 'product-price'), '2');
    await click(buttonNamed(container, 'Save'));
    await settle(() => text(container).includes('Saved. Apple'));
    expect(rowsInOrder(container)).toEqual(['apple', 'mug', 'teapot']);
    relay.releaseRead([listing(TEAPOT), listing(CUP), listing(MUG)]);
    relay.set([listing(TEAPOT), listing(CUP), listing(MUG)]);
    await chooseFile(container, 'd,title,price\nmug,Mug,12.50\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    expect(rowsInOrder(container)).toEqual(['cup', 'mug', 'teapot']);
  });

  it('a failed read says the products are not read yet; Retry that works clears it', async () => {
    const relay = flakyReader([listing(MUG), listing(TEAPOT)]);
    const { container } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('Your products are not read yet.'));
    relay.heal();
    await click(buttonNamed(container, 'Retry'));
    await settle(() => text(container).includes('Teapot'));
    expect(text(container)).not.toContain('could not be read');
    expect(text(container)).not.toContain('not read yet');
  });

  it('without a queue nothing can be written', async () => {
    mounted = await mount(
      <ProductsSection
        deps={sessionDeps(fakeApi(), fakeReader([listing(MUG), listing(TEAPOT)]))}
        view={storeView()}
        config={adminConfig()}
      />,
    );
    const { container } = mounted;
    await settle(() => text(container).includes('Teapot'));
    expect(buttonNamed(container, 'Add a product').disabled).toBe(true);
    expect(rowButton(container, 'Edit', 'Mug').disabled).toBe(true);
    expect(rowButton(container, 'Remove', 'Mug').disabled).toBe(true);
    expect(fileInput(container).disabled).toBe(true);
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    expect(buttonNamed(container, 'Import 1 product').disabled).toBe(true);
    expect(buttonNamed(container, 'Replace all with 1 product').disabled).toBe(true);
  });

  it.each([[storeView({ status: 'pending' })], [storeView({ status: 'suspended' })]])(
    'a store that cannot publish shows its unreadable products with no Remove them',
    async (view) => {
      const { container } = await mountProducts({
        view,
        reader: fakeReader([listing(MUG), UNREADABLE]),
      });
      await settle(() => text(container).includes('1 listed product cannot be read'));
      expect(hasButton(container, 'Remove them')).toBe(false);
    },
  );

  it('a suspended store with no plan keeps the inactive wording', async () => {
    const { container } = await mountProducts({
      view: storeView({ status: 'suspended', tier: null }),
      onChoosePlan: () => undefined,
    });
    await settle(() => text(container).includes('Teapot'));
    expect(text(container)).toContain('Your store is not active yet');
    expect(hasButton(container, 'Choose a plan')).toBe(false);
  });

  it('a new product cannot take the ID of a listing the editor cannot read', async () => {
    const { api, container } = await mountProducts({
      reader: fakeReader([listing(MUG), UNREADABLE]),
    });
    await settle(() => text(container).includes('1 listed product cannot be read'));
    await click(buttonNamed(container, 'Add a product'));
    await typeInto(byId(container, 'product-d'), 'broken');
    await typeInto(byId(container, 'product-title'), 'Broken');
    await typeInto(byId(container, 'product-price'), '1');
    await click(buttonNamed(container, 'Save'));
    expect(text(container)).toContain('another product already uses "broken"');
    expect(api.catalog).not.toHaveBeenCalled();
  });

  it('the page line of the last write goes when the next one starts', async () => {
    const api = fakeApi();
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await editTitle(container, 'Mug', 'Big mug');
    await settle(() => text(container).includes('Saved. Big mug'));
    heldCatalog(api);
    await confirmRemove(container, 'Teapot');
    expect(text(container)).not.toContain('Saved. Big mug');
  });

  it('the page error of an import goes when the next write starts', async () => {
    const api = fakeApi();
    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      await gate;
      throw new ApiError(400, 'bad_request');
    });
    const { container, rerender } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 1);
    await rerender(storeView({ status: 'suspended' }));
    await rerender(storeView());
    await act(async () => {
      letGo();
    });
    await settle(() => text(container).includes('The server could not read the request'));
    heldCatalog(api);
    await confirmRemove(container, 'Teapot');
    expect(text(container)).not.toContain('The server could not read the request');
  });

  it('a waiting save taken back, then saved again and failing, no longer says it was not sent', async () => {
    const api = fakeApi();
    const real = vi.mocked(api.catalog).getMockImplementation();
    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let calls = 0;
    vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
      calls += 1;
      if (calls === 1) {
        await gate;
      }
      if (calls === 2) {
        throw new ApiError(400, 'bad_request');
      }
      if (real === undefined) {
        throw new Error('no catalog');
      }
      return real(change, dryRun);
    });
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    await editTitle(container, 'Mug', 'Big mug');
    await click(buttonNamed(container, 'Cancel'));
    expect(text(container)).toContain('Not sent. Your edits are kept.');
    await click(buttonNamed(container, 'Save'));
    await act(async () => {
      letGo();
    });
    await settle(() => text(container).includes('The server could not read the request'));
    expect(text(container)).not.toContain('Not sent. Your edits are kept.');
  });

  it('Retry on a failed row removal sends the same removal again', async () => {
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw new ApiError(409, 'inactive');
    });
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await confirmRemove(container, 'Teapot');
    await settle(() => hasButton(container, 'Retry'));
    await click(rowButton(container, 'Retry', 'Teapot'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 2);
    expect(vi.mocked(api.catalog).mock.calls[1]?.[0]).toEqual({ items: [], hide: ['teapot'] });
  });

  it('editing another product while one editor is open shows that product', async () => {
    const { container } = await mountProducts();
    await settle(() => text(container).includes('Teapot'));
    await click(rowButton(container, 'Edit', 'Mug'));
    expect(byId(container, 'product-title')).toHaveProperty('value', 'Mug');
    await click(rowButton(container, 'Edit', 'Teapot'));
    expect(byId(container, 'product-title')).toHaveProperty('value', 'Teapot');
  });

  it('Add a product is not offered while an editor is open, saving or not', async () => {
    const api = fakeApi();
    heldCatalog(api);
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await click(rowButton(container, 'Edit', 'Mug'));
    expect(hasButton(container, 'Add a product')).toBe(false);
    await typeInto(byId(container, 'product-title'), 'Big mug');
    await click(buttonNamed(container, 'Save'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 1);
    expect(hasButton(container, 'Add a product')).toBe(false);
  });

  it('an import in flight offers no Cancel', async () => {
    const api = fakeApi();
    heldCatalog(api);
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 1);
    expect(text(container)).toContain('Publishing...');
    expect(hasButton(container, 'Cancel')).toBe(false);
  });

  it('says why Replace all waits: changes publishing, or products being published', async () => {
    const api = fakeApi();
    heldCatalog(api);
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await confirmRemove(container, 'Teapot');
    expect(text(container)).toContain('Replace all waits until your changes are published.');
    await mounted?.unmount();
    const second = await mountProducts();
    await settle(() => text(second.container).includes('Teapot'));
    await chooseFile(second.container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(second.container).includes('1 product read'));
    await second.rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    expect(text(second.container)).toContain(
      'Replace all waits until the products being published are done.',
    );
  });

  it('Cancel while Replace all waits for a running sync reads the store no more', async () => {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ catalogSync: catalogSyncOf('running') })),
    });
    const { container } = await mountProducts({ api, pollMs: 20 });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => vi.mocked(api.store).mock.calls.length === 1);
    await click(buttonNamed(container, 'Cancel'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(api.store).toHaveBeenCalledTimes(1);
    expect(text(container)).not.toContain('already running');
  });

  it('Replace all waits the queue poll between store reads', async () => {
    let running = true;
    const api = fakeApi({
      store: vi.fn(async () =>
        storeView({ catalogSync: running ? catalogSyncOf('running') : null }),
      ),
    });
    const { container } = await mountProducts({ api, pollMs: 60_000 });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(api.store).toHaveBeenCalledTimes(1);
    expect(text(container)).not.toContain('already running');
    running = false;
  });

  it('Cancel during the read before Replace all asks: the question never opens', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT)]);
    const { container } = await mountProducts({ reader: relay.reader });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    relay.holdNextRead();
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await click(buttonNamed(container, 'Cancel'));
    await act(async () => {
      relay.releaseRead([listing(MUG), listing(TEAPOT)]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(text(container)).not.toContain('Replace all products?');
  });

  it('a failing store read or relay read before Replace all asks says why', async () => {
    const api = fakeApi({
      store: vi.fn(async () => {
        throw new ApiError(0, 'network');
      }),
    });
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('The server could not be reached'));
    expect(text(container)).not.toContain('Replace all products?');
  });

  it('after a recount kept, Replace all again counts a product added since and reads it into the footer', async () => {
    const relay = relayOf([listing(MUG)]);
    const api = fakeApi();
    const real = vi.mocked(api.catalog).getMockImplementation();
    let refused = false;
    vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
      if (!refused) {
        refused = true;
        relay.set([listing(MUG), listing(TEAPOT)]);
        throw new ApiError(409, 'sync_running');
      }
      if (real === undefined) {
        throw new Error('no catalog');
      }
      return real(change, dryRun);
    });
    const { container } = await mountProducts({ api, reader: relay.reader });
    await settle(() => text(container).includes('Mug'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    await click(buttonNamed(container, 'Replace all'));
    await settle(() => text(container).includes('2 products not in this file'));
    await click(buttonNamed(container, 'Keep my products'));
    relay.set([listing(MUG), listing(TEAPOT), UNREADABLE]);
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('3 products not in this file'));
    expect(text(container)).toContain('(1 unreadable)');
    relay.holdNextRead();
    await click(buttonNamed(container, 'Replace all'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 2);
    expect(vi.mocked(api.catalog).mock.calls[1]?.[0].hide).toEqual(['mug', 'teapot', 'broken']);
  });

  it('the file field is off while Replace all prepares and while it asks', async () => {
    let running = true;
    const api = fakeApi({
      store: vi.fn(async () =>
        storeView({ catalogSync: running ? catalogSyncOf('running') : null }),
      ),
    });
    const { container } = await mountProducts({ api, pollMs: 10 });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    expect(fileInput(container).disabled).toBe(true);
    running = false;
    await settle(() => text(container).includes('Replace all products?'));
    expect(fileInput(container).disabled).toBe(true);
  });

  it('a file with no readable product publishes nothing either way', async () => {
    const { container } = await mountProducts();
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\nb,B,oops\n');
    await settle(() => text(container).includes('0 products read'));
    expect(buttonNamed(container, 'Import 0 products').disabled).toBe(true);
    expect(buttonNamed(container, 'Replace all with 0 products').disabled).toBe(true);
  });

  it('a new file, Replace all, or an import starting clears the panel error of a failed import', async () => {
    const api = fakeApi();
    const real = vi.mocked(api.catalog).getMockImplementation();
    let refuse = true;
    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
      if (refuse) {
        throw new ApiError(400, 'bad_request');
      }
      await gate;
      if (real === undefined) {
        throw new Error('no catalog');
      }
      return real(change, dryRun);
    });
    const REFUSED = 'The server could not read the request';
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    const failImport = async () => {
      await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
      await settle(() => text(container).includes('1 product read'));
      await click(buttonNamed(container, 'Import 1 product'));
      await settle(() => text(container).includes(REFUSED));
    };
    await failImport();
    await chooseFile(container, 'd,title,price\ncup,Cup,6\n');
    await settle(() => !text(container).includes(REFUSED));
    await failImport();
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    expect(text(container)).not.toContain(REFUSED);
    await click(buttonNamed(container, 'Keep my products'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => text(container).includes(REFUSED));
    refuse = false;
    await click(buttonNamed(container, 'Import 1 product'));
    expect(text(container)).not.toContain(REFUSED);
    await act(async () => {
      letGo();
    });
  });

  it('says Replacing... while a replace is sent', async () => {
    const api = fakeApi();
    heldCatalog(api);
    const { container } = await mountProducts({ api });
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    await click(buttonNamed(container, 'Replace all'));
    expect(hasButton(container, 'Replacing...')).toBe(true);
  });

  it('a Replace all question whose panel goes away leaves the page free again', async () => {
    const { container, rerender } = await mountProducts();
    await settle(() => text(container).includes('Teapot'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    expect(buttonNamed(container, 'Add a product').disabled).toBe(true);
    await rerender(storeView({ status: 'suspended' }));
    await rerender(storeView());
    expect(buttonNamed(container, 'Add a product').disabled).toBe(false);
    expect(rowButton(container, 'Edit', 'Mug').disabled).toBe(false);
  });
});

describe('confirmation round: reads that answer late', () => {
  const readAgain = async (rerender: (view: StoreView) => Promise<void>) => {
    await rerender(storeView({ catalogSync: catalogSyncOf('running') }));
    await rerender(storeView({ catalogSync: catalogSyncOf('done') }));
  };
  const tbody = (container: HTMLElement) => container.querySelector('tbody')?.textContent ?? '';

  it('the first read answering after the read of a later sync never overwrites it', async () => {
    let answerFirst: (events: readonly NostrEvent[]) => void = () => undefined;
    let reads = 0;
    const reader: RelayReader = {
      query: async (filter: Filter) => {
        reads += 1;
        const events =
          reads === 1
            ? await new Promise<readonly NostrEvent[]>((resolve) => {
                answerFirst = resolve;
              })
            : [listing(MUG), listing(TEAPOT)];
        return events.filter((event) => matchFilter(filter, event));
      },
    };
    const { container, rerender } = await mountProducts({ reader });
    await readAgain(rerender);
    await settle(() => tbody(container).includes('Teapot'));
    await act(async () => {
      answerFirst([listing(MUG)]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(tbody(container)).toContain('Teapot');
  });

  it('a read started before Replace all read the catalog never overwrites that list', async () => {
    const relay = relayOf([listing(MUG), listing(TEAPOT)]);
    const { container, rerender } = await mountProducts({ reader: relay.reader });
    await settle(() => tbody(container).includes('Teapot'));
    relay.holdNextRead();
    await readAgain(rerender);
    relay.set([listing(MUG), listing(TEAPOT), listing(CUP)]);
    await chooseFile(container, 'd,title,price\nmug,Mug,12.50\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    expect(tbody(container)).toContain('Cup');
    await act(async () => {
      relay.releaseRead([listing(MUG)]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(tbody(container)).toContain('Cup');
    expect(tbody(container)).toContain('Teapot');
  });

  it('a read started before a replace was asked again never overwrites the list it counted', async () => {
    const relay = relayOf([listing(MUG)]);
    const api = fakeApi();
    const real = vi.mocked(api.catalog).getMockImplementation();
    let refused = false;
    vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
      if (!refused) {
        refused = true;
        relay.set([listing(MUG), listing(TEAPOT)]);
        throw new ApiError(409, 'sync_running');
      }
      if (real === undefined) {
        throw new Error('no catalog');
      }
      return real(change, dryRun);
    });
    const { container, rerender } = await mountProducts({ api, reader: relay.reader });
    await settle(() => tbody(container).includes('Mug'));
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    // A sync from elsewhere ends while the question is open: its read is slow.
    relay.holdNextRead();
    await readAgain(rerender);
    await click(buttonNamed(container, 'Replace all'));
    await settle(() => text(container).includes('2 products not in this file'));
    expect(tbody(container)).toContain('Teapot');
    await act(async () => {
      relay.releaseRead([listing(MUG)]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(tbody(container)).toContain('Teapot');
  });
});

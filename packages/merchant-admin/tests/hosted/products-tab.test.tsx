import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAP_STOP, CSV_NOTHING_SENT } from '../../src/hosted/components/CsvImport';
import { ID_TAKEN } from '../../src/hosted/components/ProductEditor';
import { DELETE_EXPLAINED } from '../../src/hosted/components/ProductItem';
import {
  NO_PRODUCTS,
  PRODUCT_DELETED,
  PRODUCT_REMOVED,
  PRODUCT_SAVED,
  PRODUCT_STOPPED,
  ProductsTab,
} from '../../src/hosted/components/ProductsTab';
import { ApiError } from '../../src/hosted/lib/api';
import { errorMessage } from '../../src/hosted/lib/errors';
import { FIELD_PROBLEMS } from '../../src/hosted/lib/product-fields';
import { CSV_ON_SALE, CSV_TOO_LARGE, MAX_CSV_BYTES } from '../../src/hosted/lib/products-csv';
import type { StoreApi } from '../../src/hosted/lib/store-session';
import type { ProductInput, ProductRecord, StoreView } from '../../src/hosted/lib/types';
import { type Mounted, buttonNamed, click, inputById, mount, settle, turns } from '../mount';
import { storeView } from './fakes';
import { LEAK, NOW, fakeSession, storeConfig } from './store-fakes';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

const TEA: ProductRecord = {
  d: 'tea',
  title: 'Green tea',
  description: 'Leaves',
  summary: 'Fresh',
  url: 'https://shop.example.com/tea',
  priceUsd: '49',
  onSale: true,
  updatedAt: NOW,
};
const MUG: ProductRecord = {
  d: 'mug',
  title: 'Mug',
  description: '',
  priceUsd: '12.5',
  onSale: false,
  updatedAt: NOW,
};

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function textarea(container: HTMLElement, id: string): HTMLTextAreaElement {
  const found = container.querySelector(`#${id}`);
  if (!(found instanceof HTMLTextAreaElement)) {
    throw new Error(`no textarea #${id}`);
  }
  return found;
}

async function chooseFile(container: HTMLElement, file: File) {
  const input = inputById(container, 'csv-file');
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

interface Opened {
  container: HTMLElement;
  api: StoreApi;
  onChanged: ReturnType<typeof vi.fn>;
}

/** The tab over a store holding `products`, which the fake API's writes change. */
async function open(
  products: ProductRecord[],
  overrides: Partial<StoreApi> = {},
  view: StoreView = storeView({ status: 'active', maxProducts: 3, config: storeConfig() }),
): Promise<Opened> {
  const stored = new Map(products.map((product) => [product.d, product]));
  const fake = fakeSession({
    products: async () => ({ products: [...stored.values()] }),
    putProduct: async (d: string, input: ProductInput) => {
      const product = { ...input, d, onSale: input.onSale ?? true, updatedAt: NOW };
      stored.set(d, product);
      return { product, requestId: null };
    },
    ...overrides,
  });
  const onChanged = vi.fn();
  mounted = await mount(<ProductsTab session={fake.session} view={view} onChanged={onChanged} />);
  await settle(() => !text(mounted?.container ?? document.body).includes('Loading'));
  return { container: mounted.container, api: fake.api, onChanged };
}

describe('the products list', () => {
  it('lists each product with its id, price and state, and the on-sale count of the cap', async () => {
    const { container } = await open([TEA, MUG]);
    expect(text(container)).toContain('On sale: 1 of the 3 your plan allows.');
    const items = [...container.querySelectorAll('#product-list li')].map(
      (item) => item.textContent,
    );
    expect(items[0]).toContain('Green tea');
    expect(items[0]).toContain('tea - $49 - on sale');
    expect(items[1]).toContain('mug - $12.5 - off sale');
  });

  it('shows the pending cap from /v1/meta when the view names none', async () => {
    const { container } = await open(
      [TEA],
      {},
      storeView({ maxProducts: null, config: storeConfig() }),
    );
    expect(text(container)).toContain('On sale: 1 of the 20 your plan allows.');
  });

  it('applies only the newest read: a slow earlier answer does not overwrite it', async () => {
    let release: (() => void) | undefined;
    let reads = 0;
    const { container } = await open([], {
      products: async () => {
        reads += 1;
        if (reads === 1) {
          return { products: [] };
        }
        if (reads === 2) {
          return new Promise((resolve) => {
            release = () => resolve({ products: [TEA] });
          });
        }
        return { products: [MUG] };
      },
    });
    for (const d of ['one', 'two']) {
      await click(buttonNamed(container, 'Add product'));
      await type(inputById(container, 'product-d'), d);
      await type(inputById(container, 'product-title'), 'Mug');
      await type(inputById(container, 'product-price'), '1');
      await click(buttonNamed(container, 'Save product'));
      await settle(() => container.querySelector('#product-d') === null);
    }
    await settle(() => text(container).includes('mug - $12.5'));
    await act(async () => release?.());
    await turns(3);
    expect(text(container)).toContain('mug - $12.5');
    expect(text(container)).not.toContain('Green tea');
  });

  it('holds Add product until the list is read, so a new id cannot replace a product unseen', async () => {
    let release: (() => void) | undefined;
    const fake = fakeSession({
      products: () =>
        new Promise((resolve) => {
          release = () => resolve({ products: [TEA] });
        }),
    });
    mounted = await mount(
      <ProductsTab
        session={fake.session}
        view={storeView({ maxProducts: 3, config: storeConfig() })}
        onChanged={() => undefined}
      />,
    );
    const { container } = mounted;
    expect(buttonNamed(container, 'Add product').disabled).toBe(true);
    await act(async () => release?.());
    await settle(() => !buttonNamed(container, 'Add product').disabled);
  });

  it('says when there are none', async () => {
    const { container } = await open([]);
    expect(text(container)).toContain(NO_PRODUCTS);
    expect(text(container)).toContain('On sale: 0 of the 3');
  });

  it('shows a failed read in its fixed sentence, never the server text', async () => {
    const { container } = await open([], {
      products: async () => {
        throw new ApiError(500, 'internal', { error: 'internal', problem: LEAK });
      },
    });
    expect(text(container)).toContain(errorMessage(new ApiError(500, 'internal')));
    expect(text(container)).not.toContain('SECRET');
  });
});

describe('the product editor', () => {
  it('checks every field with the shared rules before sending, each in its fixed sentence', async () => {
    const putProduct = vi.fn();
    const { container } = await open([], { putProduct });
    await click(buttonNamed(container, 'Add product'));
    await type(inputById(container, 'product-d'), '../x');
    await type(inputById(container, 'product-price'), '0');
    await type(inputById(container, 'product-url'), 'http://shop.example.com');
    await type(inputById(container, 'product-summary'), 's'.repeat(1025));
    await type(textarea(container, 'product-description'), 'x'.repeat(65_537));
    await click(buttonNamed(container, 'Save product'));
    for (const field of ['d', 'title', 'priceUsd', 'url', 'summary', 'description'] as const) {
      expect(text(container), field).toContain(FIELD_PROBLEMS[field]);
    }
    expect(putProduct).not.toHaveBeenCalled();
  });

  it('refuses a new product whose id is taken, then saves a new one trimmed, and reads again', async () => {
    const putProduct = vi.fn(async (d: string, input: ProductInput) => ({
      product: { ...input, d, onSale: true, updatedAt: NOW },
      requestId: null,
    }));
    let reads = 0;
    const { container, onChanged } = await open([TEA], {
      putProduct,
      products: async () => {
        reads += 1;
        return { products: [TEA] };
      },
    });
    await click(buttonNamed(container, 'Add product'));
    await type(inputById(container, 'product-d'), ' tea ');
    await type(inputById(container, 'product-title'), ' Black tea ');
    await type(inputById(container, 'product-price'), ' 7.50 ');
    await click(buttonNamed(container, 'Save product'));
    expect(text(container)).toContain(ID_TAKEN);
    expect(putProduct).not.toHaveBeenCalled();

    await type(inputById(container, 'product-d'), ' black ');
    await type(inputById(container, 'product-summary'), '  ');
    await type(inputById(container, 'product-url'), ' https://shop.example.com/black ');
    await click(inputById(container, 'product-on-sale'));
    await click(buttonNamed(container, 'Save product'));
    await settle(() => text(container).includes(PRODUCT_SAVED));
    expect(putProduct).toHaveBeenCalledWith('black', {
      title: 'Black tea',
      description: '',
      url: 'https://shop.example.com/black',
      priceUsd: '7.50',
      onSale: false,
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    await settle(() => reads === 2);
    expect(container.querySelector('#product-d')).toBeNull();
  });

  it('edits a product with its id fixed, its fields filled, and an emptied field left out', async () => {
    const putProduct = vi.fn(async (d: string, input: ProductInput) => ({
      product: { ...input, d, onSale: true, updatedAt: NOW },
      requestId: null,
    }));
    const { container } = await open([TEA, MUG], { putProduct });
    await click(buttonNamed(container, 'Edit'));
    expect(inputById(container, 'product-d').disabled).toBe(true);
    expect(inputById(container, 'product-d').value).toBe('tea');
    expect(inputById(container, 'product-title').value).toBe('Green tea');
    expect(inputById(container, 'product-on-sale').checked).toBe(true);
    expect(textarea(container, 'product-description').value).toBe('Leaves');
    // One change at a time: the other rows and Add wait.
    expect(buttonNamed(container, 'Add product').disabled).toBe(true);
    expect(inputById(container, 'product-summary').value).toBe('Fresh');
    expect(inputById(container, 'product-url').value).toBe(TEA.url);
    expect(inputById(container, 'product-price').value).toBe('49');
    expect(
      [...container.querySelectorAll('#product-list button')].every((button) =>
        button instanceof HTMLButtonElement ? button.disabled : false,
      ),
    ).toBe(true);
    await type(inputById(container, 'product-summary'), '');
    await type(inputById(container, 'product-price'), '50');
    await click(buttonNamed(container, 'Save product'));
    await settle(() => text(container).includes(PRODUCT_SAVED));
    expect(putProduct).toHaveBeenCalledWith('tea', {
      title: 'Green tea',
      description: 'Leaves',
      url: 'https://shop.example.com/tea',
      priceUsd: '50',
      onSale: true,
    });
  });

  it('cancels without sending', async () => {
    const putProduct = vi.fn();
    const { container } = await open([TEA], { putProduct });
    await click(buttonNamed(container, 'Edit'));
    await click(buttonNamed(container, 'Cancel'));
    expect(container.querySelector('#product-d')).toBeNull();
    expect(putProduct).not.toHaveBeenCalled();
  });

  it('shows a refusal (the cap) in its fixed sentence and keeps the editor open', async () => {
    const { container, onChanged } = await open([MUG], {
      putProduct: async () => {
        throw new ApiError(409, 'product_cap', { error: 'product_cap', problems: [LEAK] });
      },
    });
    await click(buttonNamed(container, 'Edit'));
    expect(inputById(container, 'product-on-sale').checked).toBe(false);
    await click(inputById(container, 'product-on-sale'));
    await click(buttonNamed(container, 'Save product'));
    await settle(() => text(container).includes(errorMessage(new ApiError(409, 'product_cap'))));
    expect(text(container)).not.toContain('SECRET');
    expect(inputById(container, 'product-d').value).toBe('mug');
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('deleting a product', () => {
  async function remove(outcome: string) {
    const deleteProduct = vi.fn(async () => ({ outcome, requestId: null }));
    const opened = await open([TEA], { deleteProduct });
    await click(buttonNamed(opened.container, 'Delete'));
    expect(text(opened.container)).toContain(DELETE_EXPLAINED);
    await click(buttonNamed(opened.container, 'Confirm delete'));
    return { ...opened, deleteProduct };
  }

  it('says the product was removed', async () => {
    const { container, deleteProduct, onChanged } = await remove('removed');
    await settle(() => text(container).includes(PRODUCT_REMOVED));
    expect(deleteProduct).toHaveBeenCalledWith('tea');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('says the product stays, off sale, because its terms stand', async () => {
    const { container } = await remove('stopped');
    await settle(() => text(container).includes(PRODUCT_STOPPED));
  });

  it('says a plain sentence for an outcome it does not know, inherited names included', async () => {
    for (const outcome of ['gone', 'constructor', '__proto__']) {
      const { container } = await remove(outcome);
      await settle(() => text(container).includes(PRODUCT_DELETED));
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('sends nothing when kept, and shows a refusal in its fixed sentence', async () => {
    const deleteProduct = vi.fn(async () => {
      throw new ApiError(409, 'suspended', { error: 'suspended', problem: LEAK });
    });
    const { container } = await open([TEA], { deleteProduct });
    await click(buttonNamed(container, 'Delete'));
    await click(buttonNamed(container, 'Keep it'));
    expect(text(container)).not.toContain(DELETE_EXPLAINED);
    expect(deleteProduct).not.toHaveBeenCalled();
    await click(buttonNamed(container, 'Delete'));
    await click(buttonNamed(container, 'Confirm delete'));
    await settle(() => text(container).includes(errorMessage(new ApiError(409, 'suspended'))));
    expect(text(container)).not.toContain('SECRET');
  });
});

describe('the CSV import', () => {
  const HEADER = 'd,title,priceUsd,onSale,summary,url,description';

  it('checks the file, then writes each line in order and reads the list again', async () => {
    const puts: string[] = [];
    const { container, onChanged, api } = await open([TEA], {
      putProduct: async (d: string, input: ProductInput) => {
        puts.push(d);
        return { product: { ...input, d, onSale: true, updatedAt: NOW }, requestId: null };
      },
    });
    const products = vi.spyOn(api, 'products');
    await chooseFile(
      container,
      new File([`﻿${HEADER}\r\nb,Bee,1,,,,\r\na,"Ant, red",2,false,,,`], 'p.csv'),
    );
    await settle(() => text(container).includes('2 products are ready'));
    expect(puts).toEqual([]);
    const chosen = inputById(container, 'csv-file');
    await click(buttonNamed(container, 'Import products'));
    await settle(() => text(container).includes('Imported 2 products.'));
    // The file input is a fresh one: the same file can be chosen again.
    expect(inputById(container, 'csv-file')).not.toBe(chosen);
    expect(puts).toEqual(['b', 'a']);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(products).toHaveBeenCalled();
  });

  it('lists every invalid line and writes nothing', async () => {
    const putProduct = vi.fn();
    const { container } = await open([], { putProduct });
    await chooseFile(container, new File([`${HEADER}\nok,Ok,1,,,,\nbad,,0,maybe,,,`], 'p.csv'));
    await settle(() => text(container).includes(CSV_NOTHING_SENT));
    const problems = [...container.querySelectorAll('#csv-problems li')].map(
      (item) => item.textContent,
    );
    expect(problems).toEqual([
      `Line 3: title: ${FIELD_PROBLEMS.title}`,
      `Line 3: priceUsd: ${FIELD_PROBLEMS.priceUsd}`,
      `Line 3: onSale: ${CSV_ON_SALE}`,
    ]);
    expect(container.querySelector('#csv-problems')?.parentElement?.getAttribute('role')).toBe(
      'alert',
    );
    expect(() => buttonNamed(container, 'Import products')).toThrow();
    expect(putProduct).not.toHaveBeenCalled();
  });

  it('refuses a file over the size cap without reading it', async () => {
    const { container } = await open([]);
    const file = new File(['x'], 'big.csv');
    Object.defineProperty(file, 'size', { value: MAX_CSV_BYTES + 1 });
    const read = vi.spyOn(file, 'text');
    await chooseFile(container, file);
    await settle(() => text(container).includes(CSV_TOO_LARGE));
    expect(read).not.toHaveBeenCalled();
  });

  it('stops at the cap and says how far it got', async () => {
    const puts: string[] = [];
    const { container, onChanged } = await open([], {
      putProduct: async (d: string, input: ProductInput) => {
        puts.push(d);
        if (d === 'c') {
          throw new ApiError(409, 'product_cap', { error: 'product_cap', problems: [LEAK] });
        }
        return { product: { ...input, d, onSale: true, updatedAt: NOW }, requestId: null };
      },
    });
    await chooseFile(
      container,
      new File([`${HEADER}\na,A,1,,,,\nb,B,1,,,,\nc,C,1,,,,\nd,D,1,,,,`], 'p.csv'),
    );
    await settle(() => text(container).includes('4 products are ready'));
    await click(buttonNamed(container, 'Import products'));
    await settle(() => text(container).includes('Imported 2 of 4.'));
    expect(text(container)).toContain(
      `Imported 2 of 4. Line 4 (c) was not saved: ${CAP_STOP} Lines after it were not sent.`,
    );
    expect(text(container)).not.toContain('SECRET');
    expect(puts).toEqual(['a', 'b', 'c']);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('stops at any other refusal with its fixed sentence; nothing written reads nothing again', async () => {
    const { container, onChanged } = await open([], {
      putProduct: async () => {
        throw new ApiError(400, 'bad_price', { error: 'bad_price', problems: [LEAK] });
      },
    });
    await chooseFile(container, new File([`${HEADER}\na,A,1,,,,\nb,B,1,,,,`], 'p.csv'));
    await settle(() => text(container).includes('2 products are ready'));
    await click(buttonNamed(container, 'Import products'));
    await settle(() => text(container).includes('Imported 0 of 2.'));
    expect(text(container)).toContain(
      `Line 2 (a) was not saved: ${errorMessage(new ApiError(400, 'bad_price'))}`,
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('stops sending when the tab is left mid-import, and reads nothing again after', async () => {
    const puts: string[] = [];
    let release: (() => void) | undefined;
    const products = vi.fn(async () => ({ products: [] }));
    const { container, onChanged } = await open([], {
      products,
      putProduct: (d: string, input: ProductInput) => {
        puts.push(d);
        return new Promise((resolve) => {
          release = () =>
            resolve({ product: { ...input, d, onSale: true, updatedAt: NOW }, requestId: null });
        });
      },
    });
    await chooseFile(container, new File([`${HEADER}\na,A,1,,,,\nb,B,1,,,,`], 'p.csv'));
    await settle(() => text(container).includes('2 products are ready'));
    await click(buttonNamed(container, 'Import products'));
    await settle(() => puts.length === 1);
    const reads = products.mock.calls.length;
    await mounted?.unmount();
    mounted = undefined;
    await act(async () => release?.());
    await turns(5);
    expect(puts).toEqual(['a']);
    // The one product written is not reported: the tab is gone, so no store or products read follows.
    expect(onChanged).not.toHaveBeenCalled();
    expect(products).toHaveBeenCalledTimes(reads);
  });

  it('is held while a product is being edited', async () => {
    const { container } = await open([TEA]);
    await click(buttonNamed(container, 'Edit'));
    expect(inputById(container, 'csv-file').disabled).toBe(true);
    await click(buttonNamed(container, 'Cancel'));
    expect(inputById(container, 'csv-file').disabled).toBe(false);
    await turns(1);
  });
});

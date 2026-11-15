import type { CatalogItemInput } from '@elisym/askr';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductEditor } from '../src/components/ProductEditor';
import { type Mounted, buttonNamed, byId, click, mount, typeInto } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function labelled(container: HTMLElement, label: string): HTMLInputElement {
  const found = container.querySelector(`[aria-label="${label}"]`);
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`no field "${label}"`);
  }
  return found;
}

async function choose(field: HTMLElement, value: string): Promise<void> {
  if (!(field instanceof HTMLSelectElement)) {
    throw new Error('not a select');
  }
  await act(async () => {
    field.value = value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function editor(initial?: CatalogItemInput) {
  const onSave = vi.fn();
  mounted = await mount(
    <ProductEditor
      initial={initial}
      currency="USD"
      takenIds={[]}
      onSave={onSave}
      onCancel={() => undefined}
    />,
  );
  return { container: mounted.container, onSave };
}

function saved(onSave: ReturnType<typeof vi.fn>): CatalogItemInput {
  const [call] = onSave.mock.calls;
  if (call === undefined) {
    throw new Error('nothing saved');
  }
  return call[0];
}

describe('the product editor fields', () => {
  it('saves topics, SKU, billing period and attributes', async () => {
    const { container, onSave } = await editor();
    await typeInto(byId(container, 'product-d'), 'box');
    await typeInto(byId(container, 'product-title'), 'Coffee box');
    await typeInto(byId(container, 'product-price'), '15');
    await choose(byId(container, 'product-frequency'), 'month');
    await typeInto(byId(container, 'product-topics'), 'coffee, gifts, ');
    await typeInto(byId(container, 'product-sku'), ' BOX-1 ');
    await click(buttonNamed(container, 'Add an attribute'));
    await typeInto(labelled(container, 'Attribute 1 name'), 'Roast');
    await typeInto(labelled(container, 'Attribute 1 value'), 'Medium');
    await click(buttonNamed(container, 'Add an attribute'));
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({
      d: 'box',
      price: { amount: '15', currency: 'USD', frequency: 'month' },
      topics: ['coffee', 'gifts'],
      sku: 'BOX-1',
      // The second attribute row was left empty, so it is dropped.
      attrs: [{ name: 'Roast', value: 'Medium' }],
      options: [],
      variants: [],
    });
  });

  it('turns options into variants with their own price and stock, the listing at the lowest in stock', async () => {
    const { container, onSave } = await editor();
    await typeInto(byId(container, 'product-d'), 'tee');
    await typeInto(byId(container, 'product-title'), 'Tee');
    await typeInto(byId(container, 'product-price'), '20');
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 1 name'), 'Size');
    await typeInto(labelled(container, 'Option 1 values'), 'S, M, L');
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 2 name'), 'Color');
    await typeInto(labelled(container, 'Option 2 values'), 'Black');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    await typeInto(labelled(container, 'Price of S / Black'), '18');
    await click(labelled(container, 'S / Black in stock'));
    await typeInto(labelled(container, 'Price of L / Black'), '25');
    // The price follows the variants and is no longer typed.
    const price = byId(container, 'product-price');
    expect(price instanceof HTMLInputElement && price.readOnly && price.value).toBe('20');
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({
      price: { amount: '20' },
      options: [
        { name: 'Size', values: ['S', 'M', 'L'] },
        { name: 'Color', values: ['Black'] },
      ],
      variants: [
        { price: '18', available: false, values: ['S', 'Black'] },
        { price: '20', available: true, values: ['M', 'Black'] },
        { price: '25', available: true, values: ['L', 'Black'] },
      ],
    });
  });

  it('keeps an edited variant when another value is added, and drops it when its value goes', async () => {
    const { container } = await editor({
      d: 'tee',
      title: 'Tee',
      price: { amount: '20', currency: 'USD' },
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { id: 'tee-s', price: '20', available: true, values: ['S'] },
        { id: 'tee-m', price: '24', available: false, values: ['M'] },
      ],
    });
    await typeInto(labelled(container, 'Option 1 values'), 'S, M, L');
    expect(labelled(container, 'Price of M').value).toBe('24');
    expect(labelled(container, 'M in stock').checked).toBe(false);
    expect(labelled(container, 'Price of L').value).toBe('20');
    await typeInto(labelled(container, 'Option 1 values'), 'S, L');
    expect(container.querySelector('[aria-label="Price of M"]')).toBeNull();
    const remove = container.querySelector('[aria-label="Remove option 1"]');
    if (!(remove instanceof HTMLButtonElement)) {
      throw new Error('no remove button');
    }
    await click(remove);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
    const price = byId(container, 'product-price');
    expect(price instanceof HTMLInputElement && !price.readOnly && price.value).toBe('20');
  });

  it('says why options with too many combinations are not saved', async () => {
    const { container, onSave } = await editor({
      d: 'x',
      title: 'X',
      price: { amount: '1', currency: 'USD' },
    });
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 1 name'), 'A');
    await typeInto(labelled(container, 'Option 1 values'), '1,2,3,4,5,6,7,8,9,10');
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 2 name'), 'B');
    await typeInto(labelled(container, 'Option 2 values'), '1,2,3,4,5,6,7,8,9,10');
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 3 name'), 'C');
    await typeInto(labelled(container, 'Option 3 values'), 'x, y');
    expect(container.textContent).toContain('These options make 200 combinations');
    await click(buttonNamed(container, 'Keep this product'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('refuses a product whose variants are all out of stock while it says on sale', async () => {
    const { container, onSave } = await editor({
      d: 'cap',
      title: 'Cap',
      price: { amount: '10', currency: 'USD' },
      options: [{ name: 'Color', values: ['Red'] }],
      variants: [{ id: '1', price: '10', available: true, values: ['Red'] }],
    });
    await click(labelled(container, 'Red in stock'));
    await click(buttonNamed(container, 'Keep this product'));
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain('a listing with no available variant is sold-out');
    await choose(byId(container, 'product-visibility'), 'sold-out');
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({ visibility: 'sold-out', price: { amount: '10' } });
  });

  it('keeps what the form does not show: the connector source id and a variant with any value', async () => {
    const { container, onSave } = await editor({
      d: 'shopify:1',
      title: 'Imported',
      price: { amount: '5', currency: 'USD' },
      sourceId: '1',
      options: [
        { name: 'Size', values: ['S'] },
        { name: 'Color', values: ['Red'] },
      ],
      variants: [{ id: 'v1', price: '5', available: true, values: ['S', '*'] }],
    });
    await typeInto(byId(container, 'product-title'), 'Imported tee');
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({
      title: 'Imported tee',
      sourceId: '1',
      variants: [{ id: 'v1', values: ['S', '*'] }],
    });
  });

  it('keeps option values and topics with a comma whole while their rows are untouched', async () => {
    const { container, onSave } = await editor({
      d: 'flag',
      title: 'Flag',
      price: { amount: '9', currency: 'USD' },
      topics: ['salt, pepper', 'flags'],
      options: [{ name: 'Color', values: ['Red, White', 'Blue'] }],
      variants: [
        { id: 'a', price: '9', available: true, values: ['Red, White'] },
        { id: 'b', price: '9', available: true, values: ['Blue'] },
      ],
    });
    await typeInto(byId(container, 'product-title'), 'Big flag');
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({
      topics: ['salt, pepper', 'flags'],
      options: [{ name: 'Color', values: ['Red, White', 'Blue'] }],
      variants: [{ values: ['Red, White'] }, { values: ['Blue'] }],
    });
  });

  it('the listing price follows a variant price edit', async () => {
    const { container, onSave } = await editor({
      d: 'tee',
      title: 'Tee',
      price: { amount: '20', currency: 'USD' },
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { id: '1', price: '20', available: true, values: ['S'] },
        { id: '2', price: '24', available: true, values: ['M'] },
      ],
    });
    await typeInto(labelled(container, 'Price of S'), '30');
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({ price: { amount: '24' } });
  });

  it('sets one price for every variant at once', async () => {
    const { container, onSave } = await editor();
    await typeInto(byId(container, 'product-d'), 'tee');
    await typeInto(byId(container, 'product-title'), 'Tee');
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 1 name'), 'Size');
    await typeInto(labelled(container, 'Option 1 values'), 'S, M');
    expect(labelled(container, 'Price of S').value).toBe('');
    await typeInto(byId(container, 'variants-same-price'), ' 15 ');
    await click(buttonNamed(container, 'Set for all'));
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({
      price: { amount: '15' },
      variants: [{ price: '15' }, { price: '15' }],
    });
  });

  it('with options that make no variants, says only that and saves nothing', async () => {
    const { container, onSave } = await editor({
      d: 'x',
      title: 'X',
      price: { amount: '1', currency: 'USD' },
      options: [{ name: 'A', values: ['1'] }],
      variants: [{ id: '1', price: '1', available: true, values: ['1'] }],
    });
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 2 name'), 'B');
    await typeInto(
      labelled(container, 'Option 2 values'),
      Array.from({ length: 101 }, (_value, index) => String(index)).join(','),
    );
    await click(buttonNamed(container, 'Keep this product'));
    expect(onSave).not.toHaveBeenCalled();
    const items = [...container.querySelectorAll('li')].map((item) => item.textContent);
    expect(items).toEqual([
      'options: These options make 101 combinations; a product holds at most 100 variants.',
    ]);
  });

  it('never gives a published variant id to another combination', async () => {
    const { container, onSave } = await editor({
      d: 'tee',
      title: 'Tee',
      price: { amount: '20', currency: 'USD' },
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { id: '1', price: '20', available: true, values: ['S'] },
        { id: '2', price: '20', available: true, values: ['M'] },
      ],
    });
    await typeInto(labelled(container, 'Option 1 values'), 'S');
    await typeInto(labelled(container, 'Option 1 values'), 'S, XL');
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave).variants?.map((variant) => [variant.id, variant.values[0]])).toEqual([
      ['1', 'S'],
      ['3', 'XL'],
    ]);
  });

  it('renaming an option keeps a sparse grid and a * variant exactly', async () => {
    const variants = [
      { id: 'a', price: '20', available: true, values: ['S', 'Red'] },
      { id: 'b', price: '30', available: false, values: ['M', '*'] },
    ];
    const { container, onSave } = await editor({
      d: 'tee',
      title: 'Tee',
      price: { amount: '20', currency: 'USD' },
      options: [
        { name: 'Size', values: ['S', 'M'] },
        { name: 'Color', values: ['Red', 'Blue'] },
      ],
      variants,
    });
    await typeInto(labelled(container, 'Option 2 name'), 'Colour');
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({
      options: [
        { name: 'Size', values: ['S', 'M'] },
        { name: 'Colour', values: ['Red', 'Blue'] },
      ],
      variants,
    });
  });

  it('clearing an option name to retype it, or a value passing through, loses nothing', async () => {
    const variants = [
      { id: 'tee-s', price: '20', available: true, values: ['S'] },
      { id: 'tee-m', price: '24', available: false, values: ['M'] },
      { id: 'tee-l', price: '26', available: true, values: ['L'] },
    ];
    const { container, onSave } = await editor({
      d: 'tee',
      title: 'Tee',
      price: { amount: '20', currency: 'USD' },
      options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
      variants,
    });
    await typeInto(labelled(container, 'Option 1 name'), '');
    await typeInto(labelled(container, 'Option 1 name'), 'Sizes');
    await typeInto(labelled(container, 'Option 1 values'), 'S, M, ');
    await typeInto(labelled(container, 'Option 1 values'), 'S, M, L');
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({
      options: [{ name: 'Sizes', values: ['S', 'M', 'L'] }],
      variants,
    });
  });

  it('refuses to save while an option has a name and no values', async () => {
    const { container, onSave } = await editor({
      d: 'x',
      title: 'X',
      price: { amount: '1', currency: 'USD' },
    });
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 1 name'), 'Size');
    await click(buttonNamed(container, 'Keep this product'));
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain('each option needs a name and at least one value');
  });

  it('a new value starts at the listing price, and * is never a value', async () => {
    const { container, onSave } = await editor({
      d: 'tee',
      title: 'Tee',
      price: { amount: '18', currency: 'USD' },
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { id: '1', price: '18', available: true, values: ['S'] },
        { id: '2', price: '25', available: true, values: ['M'] },
      ],
    });
    await typeInto(labelled(container, 'Price of S'), '22');
    await typeInto(labelled(container, 'Option 1 values'), 'S, M, L, *');
    expect(labelled(container, 'Price of L').value).toBe('22');
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave).options).toEqual([{ name: 'Size', values: ['S', 'M', 'L'] }]);
  });

  it('an untouched equal listing price keeps its spelling, and removing every option keeps the price shown', async () => {
    const { container, onSave } = await editor({
      d: 'tee',
      title: 'Tee',
      price: { amount: '20.0', currency: 'USD' },
      options: [{ name: 'Size', values: ['S'] }],
      variants: [{ id: '1', price: '20', available: true, values: ['S'] }],
    });
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave).price.amount).toBe('20.0');
    await typeInto(labelled(container, 'Price of S'), '27');
    const remove = container.querySelector('[aria-label="Remove option 1"]');
    if (!(remove instanceof HTMLButtonElement)) {
      throw new Error('no remove button');
    }
    await click(remove);
    const price = byId(container, 'product-price');
    expect(price instanceof HTMLInputElement && !price.readOnly && price.value).toBe('27');
  });
});

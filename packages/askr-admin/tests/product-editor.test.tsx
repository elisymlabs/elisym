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

/** A button or select by its aria-label. */
function control(container: HTMLElement, label: string): HTMLElement {
  const found = container.querySelector(`[aria-label="${label}"]`);
  if (!(found instanceof HTMLButtonElement || found instanceof HTMLSelectElement)) {
    throw new Error(`no control "${label}"`);
  }
  return found;
}

async function enter(field: HTMLElement): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
}

async function leave(field: HTMLElement): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

/** Enter a field, type each text in turn as keystrokes would leave it, and leave it. */
async function typeAll(field: HTMLElement, texts: readonly string[]): Promise<void> {
  await enter(field);
  for (const text of texts) {
    await typeInto(field, text);
  }
  await leave(field);
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

  it('refuses a product whose variants are all out of stock while it says on sale', async () => {
    const { container, onSave } = await editor({
      d: 'cap',
      title: 'Cap',
      price: { amount: '10', currency: 'USD' },
      options: [{ name: 'Color', values: ['Red'] }],
      variants: [{ id: '1', price: '10', available: true, values: ['Red'] }],
    });
    await click(labelled(container, 'Variant 1 in stock'));
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
    await typeInto(labelled(container, 'Price of variant 1'), '30');
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({ price: { amount: '24' } });
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

  it('a product whose connector cut its variants keeps none when an option is renamed', async () => {
    const { container, onSave } = await editor({
      d: 'shopify:9',
      title: 'Cut',
      price: { amount: '5', currency: 'USD' },
      sourceId: '9',
      options: [{ name: 'Color', values: ['Red', 'Blue'] }],
      variants: [],
    });
    await typeInto(labelled(container, 'Option 1 name'), 'Colour');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({
      options: [{ name: 'Colour', values: ['Red', 'Blue'] }],
      variants: [],
      price: { amount: '5' },
    });
  });

  it('makes variants only on request: every missing combination at the price, then each its own', async () => {
    const { container, onSave } = await editor();
    await typeInto(byId(container, 'product-d'), 'tee');
    await typeInto(byId(container, 'product-title'), 'Tee');
    await typeInto(byId(container, 'product-price'), '20');
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 1 name'), 'Size');
    await typeInto(labelled(container, 'Option 1 values'), 'S, M, L, *');
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 2 name'), 'Color');
    await typeInto(labelled(container, 'Option 2 values'), 'Black');
    // Typing options made nothing.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
    await click(buttonNamed(container, 'Add every missing combination'));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    await typeInto(labelled(container, 'Price of variant 1'), '18');
    await click(labelled(container, 'Variant 1 in stock'));
    await typeInto(labelled(container, 'Price of variant 3'), '25');
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
        { id: '1', price: '18', available: false, values: ['S', 'Black'] },
        { id: '2', price: '20', available: true, values: ['M', 'Black'] },
        { id: '3', price: '25', available: true, values: ['L', 'Black'] },
      ],
    });
  });

  const SPARSE: CatalogItemInput = {
    d: 'tee',
    title: 'Tee',
    price: { amount: '20', currency: 'USD' },
    options: [
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Color', values: ['Red', 'Blue'] },
    ],
    variants: [
      { id: 'a', price: '20', available: true, values: ['S', 'Red'] },
      { id: 'b', price: '30', available: false, values: ['M', 'Blue'] },
    ],
  };

  it('editing option names and values never makes or drops a variant', async () => {
    const { container, onSave } = await editor(SPARSE);
    // A backspace and the letter typed again: renamed in the variant and back.
    await typeAll(labelled(container, 'Option 2 values'), ['Red, Blu', 'Red, Blue']);
    await typeAll(labelled(container, 'Option 2 values'), ['Red, Blue, Green']);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    await typeAll(labelled(container, 'Option 2 values'), ['Red, Blue']);
    await typeInto(labelled(container, 'Option 2 name'), '');
    await typeInto(labelled(container, 'Option 2 name'), 'Colour');
    await typeAll(labelled(container, 'Option 1 values'), ['', 'S, M']);
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({
      options: [
        { name: 'Size', values: ['S', 'M'] },
        { name: 'Colour', values: ['Red', 'Blue'] },
      ],
      variants: SPARSE.variants,
    });
  });

  it('a value renamed in place, letter by letter, is renamed in the variants too', async () => {
    const { container, onSave } = await editor({
      ...SPARSE,
      options: [
        { name: 'Size', values: ['S', 'M'] },
        { name: 'Color', values: ['Red', 'Blak'] },
      ],
      variants: [
        { id: 'a', price: '20', available: true, values: ['S', 'Red'] },
        { id: 'b', price: '30', available: false, values: ['M', 'Blak'] },
      ],
    });
    await typeAll(labelled(container, 'Option 2 values'), ['Red, Bla', 'Red, Blac', 'Red, Black']);
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave).variants).toEqual([
      { id: 'a', price: '20', available: true, values: ['S', 'Red'] },
      { id: 'b', price: '30', available: false, values: ['M', 'Black'] },
    ]);
  });

  it('a removed value leaves its variant to fix or remove, and says so', async () => {
    const { container, onSave } = await editor(SPARSE);
    await typeInto(labelled(container, 'Option 2 values'), 'Red');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    await click(buttonNamed(container, 'Keep this product'));
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Variant 2 (M / Blue) uses Blue, which Color no longer has: pick another value or remove the variant.',
    );
    await click(control(container, 'Remove variant 2'));
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave).variants).toEqual([SPARSE.variants?.[0]]);
  });

  it('a removed option takes its value out of every variant, and an overlap is named', async () => {
    const { container, onSave } = await editor({
      ...SPARSE,
      variants: [
        { id: 'a', price: '20', available: true, values: ['S', 'Red'] },
        { id: 'b', price: '22', available: true, values: ['S', 'Blue'] },
        { id: 'c', price: '30', available: false, values: ['M', 'Blue'] },
      ],
    });
    await click(control(container, 'Remove option 2'));
    await click(buttonNamed(container, 'Keep this product'));
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Variant 1 (S) and Variant 2 (S) are the same choice for a shopper',
    );
    await click(control(container, 'Remove variant 1'));
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { id: 'b', price: '22', available: true, values: ['S'] },
        { id: 'c', price: '30', available: false, values: ['M'] },
      ],
    });
  });

  it('a new option asks each variant to pick a value, keeping its id, price and stock', async () => {
    const { container, onSave } = await editor({
      d: 'tee',
      title: 'Tee',
      price: { amount: '20', currency: 'USD' },
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { id: 'tee-s', price: '20', available: true, values: ['S'] },
        { id: 'tee-m', price: '24', available: false, values: ['M'] },
      ],
    });
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 2 name'), 'Fit');
    await typeInto(labelled(container, 'Option 2 values'), 'Slim, Wide');
    await click(buttonNamed(container, 'Keep this product'));
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Variant 1 (S / ?): pick its Fit.');
    await choose(control(container, 'Fit of variant 1'), 'Slim');
    await choose(control(container, 'Fit of variant 2'), '*');
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave).variants).toEqual([
      { id: 'tee-s', price: '20', available: true, values: ['S', 'Slim'] },
      { id: 'tee-m', price: '24', available: false, values: ['M', '*'] },
    ]);
  });

  it('a new variant never gets an id a variant of the edit has had', async () => {
    const { container, onSave } = await editor({
      d: 'tee',
      title: 'Tee',
      price: { amount: '20', currency: 'USD' },
      options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
      variants: [
        { id: '1', price: '20', available: true, values: ['S'] },
        { id: '2', price: '20', available: true, values: ['M'] },
      ],
    });
    await click(control(container, 'Remove variant 2'));
    await click(buttonNamed(container, 'Add a variant'));
    await choose(control(container, 'Size of variant 2'), 'L');
    await click(buttonNamed(container, 'Add every missing combination'));
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave).variants?.map((variant) => [variant.id, variant.values[0]])).toEqual([
      ['1', 'S'],
      ['3', 'L'],
      ['4', 'M'],
    ]);
  });

  it('says why too many combinations are not added, and saves nothing new', async () => {
    const { container } = await editor({
      d: 'x',
      title: 'X',
      price: { amount: '1', currency: 'USD' },
    });
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 1 name'), 'A');
    await typeInto(
      labelled(container, 'Option 1 values'),
      Array.from({ length: 101 }, (_value, index) => String(index)).join(','),
    );
    await click(buttonNamed(container, 'Add every missing combination'));
    expect(container.textContent).toContain(
      'These options make 101 combinations; a product holds at most 100 variants.',
    );
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
  });

  it('sets one price for every variant at once', async () => {
    const { container, onSave } = await editor();
    await typeInto(byId(container, 'product-d'), 'tee');
    await typeInto(byId(container, 'product-title'), 'Tee');
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 1 name'), 'Size');
    await typeInto(labelled(container, 'Option 1 values'), 'S, M');
    await click(buttonNamed(container, 'Add every missing combination'));
    expect(labelled(container, 'Price of variant 1').value).toBe('');
    await typeInto(byId(container, 'variants-same-price'), ' 15 ');
    await click(buttonNamed(container, 'Set for all'));
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({
      price: { amount: '15' },
      variants: [{ price: '15' }, { price: '15' }],
    });
  });

  it('refuses to save an option without values or without a name', async () => {
    const { container, onSave } = await editor({
      d: 'x',
      title: 'X',
      price: { amount: '1', currency: 'USD' },
    });
    await click(buttonNamed(container, 'Add an option'));
    await typeInto(labelled(container, 'Option 1 name'), 'Size');
    await click(buttonNamed(container, 'Add an option'));
    await click(buttonNamed(container, 'Keep this product'));
    expect(onSave).not.toHaveBeenCalled();
    const items = [...container.querySelectorAll('li')].map((item) => item.textContent);
    expect(items).toEqual([
      'Option 1 needs a name and at least one value, or remove it.',
      'Option 2 needs a name and at least one value, or remove it.',
    ]);
  });

  it('an untouched equal listing price keeps its spelling, and removing every variant keeps the price shown', async () => {
    const { container, onSave } = await editor({
      d: 'tee',
      title: 'Tee',
      price: { amount: '20.0', currency: 'USD' },
      options: [{ name: 'Size', values: ['S'] }],
      variants: [{ id: '1', price: '20', available: true, values: ['S'] }],
    });
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave).price.amount).toBe('20.0');
    await typeInto(labelled(container, 'Price of variant 1'), '27');
    await click(control(container, 'Remove variant 1'));
    const price = byId(container, 'product-price');
    expect(price instanceof HTMLInputElement && !price.readOnly && price.value).toBe('27');
  });

  const TWO_SIZES: CatalogItemInput = {
    d: 'tee',
    title: 'Tee',
    price: { amount: '20', currency: 'USD' },
    options: [{ name: 'Size', values: ['S', 'L'] }],
    variants: [
      { id: 's', price: '20', available: true, values: ['S'] },
      { id: 'l', price: '30', available: true, values: ['L'] },
    ],
  };

  it('typing a new value anywhere in the list renames nothing, keystroke by keystroke', async () => {
    for (const keystrokes of [
      ['S, ML', 'S, M,L', 'S, M, L'],
      ['XS, L', 'X, S, L'],
      ['S, M L', 'S, M, L'],
      ['S, XL', 'S, X,L', 'S, X,L, XL'],
    ]) {
      const { container, onSave } = await editor(TWO_SIZES);
      await typeAll(labelled(container, 'Option 1 values'), keystrokes);
      await click(buttonNamed(container, 'Keep this product'));
      expect(saved(onSave).variants).toEqual(TWO_SIZES.variants);
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('a value cleared and typed again in one visit to the field is a rename', async () => {
    const { container, onSave } = await editor(TWO_SIZES);
    await typeAll(labelled(container, 'Option 1 values'), ['S, ', 'S, X', 'S, XL']);
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave).variants).toEqual([
      { id: 's', price: '20', available: true, values: ['S'] },
      { id: 'l', price: '30', available: true, values: ['XL'] },
    ]);
  });

  it('saves a connector product with one variant and no options, untouched', async () => {
    const jacket: CatalogItemInput = {
      d: 'shopify:1001',
      title: 'Jacket',
      price: { amount: '120.00', currency: 'USD' },
      sourceId: '1001',
      options: [],
      variants: [{ id: 'v1', price: '120.00', available: true, values: [] }],
    };
    const { container, onSave } = await editor(jacket);
    await typeInto(byId(container, 'product-title'), 'Warm jacket');
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({ ...jacket, title: 'Warm jacket' });
  });

  it('keeps overlapping variants the product came with, refuses one the edit makes', async () => {
    const woo: CatalogItemInput = {
      d: 'woocommerce:7',
      title: 'Cap',
      price: { amount: '10', currency: 'USD' },
      sourceId: '7',
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { id: '11', price: '10', available: true, values: ['*'] },
        { id: '12', price: '12', available: true, values: ['S'] },
      ],
    };
    const { container, onSave } = await editor(woo);
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave).variants).toEqual(woo.variants);
    await click(buttonNamed(container, 'Add a variant'));
    await choose(control(container, 'Size of variant 3'), 'M');
    onSave.mockClear();
    await click(buttonNamed(container, 'Keep this product'));
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Variant 1 (Any) and Variant 3 (M) are the same choice for a shopper',
    );
  });

  it('removing the first option keeps every variant on its own row', async () => {
    const { container, onSave } = await editor({
      ...SPARSE,
      variants: [
        { id: 'a', price: '20', available: true, values: ['S', 'Red'] },
        { id: 'b', price: '30', available: false, values: ['M', 'Blue'] },
      ],
    });
    await click(control(container, 'Remove option 1'));
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave)).toMatchObject({
      options: [{ name: 'Color', values: ['Red', 'Blue'] }],
      variants: [
        { id: 'a', values: ['Red'] },
        { id: 'b', values: ['Blue'] },
      ],
    });
  });

  it('new variants start unpicked or as the missing combination, at the listing price, never with an id given out before', async () => {
    const { container, onSave } = await editor({
      d: 'tee',
      title: 'Tee',
      price: { amount: '18', currency: 'USD' },
      options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
      variants: [{ id: '1', price: '18', available: true, values: ['S'] }],
    });
    await click(buttonNamed(container, 'Add a variant'));
    const pick = control(container, 'Size of variant 2');
    expect(pick instanceof HTMLSelectElement && pick.value).toBe('');
    expect(labelled(container, 'Price of variant 2').value).toBe('18');
    await click(control(container, 'Remove variant 2'));
    await click(buttonNamed(container, 'Add every missing combination'));
    await click(buttonNamed(container, 'Keep this product'));
    expect(saved(onSave).variants).toEqual([
      { id: '1', price: '18', available: true, values: ['S'] },
      { id: '3', price: '18', available: true, values: ['M'] },
      { id: '4', price: '18', available: true, values: ['L'] },
    ]);
  });

  it('shows a value an option no longer has as such, and a price that is not a number plainly', async () => {
    const { container, onSave } = await editor(TWO_SIZES);
    await typeAll(labelled(container, 'Option 1 values'), ['S']);
    const pick = control(container, 'Size of variant 2');
    expect(pick.textContent).toContain('L (not a value any more)');
    await typeInto(labelled(container, 'Price of variant 1'), '1.');
    await click(buttonNamed(container, 'Keep this product'));
    expect(onSave).not.toHaveBeenCalled();
    const items = [...container.querySelectorAll('li')].map((item) => item.textContent);
    expect(items).toEqual([
      'Variant 1 (S): the price is not a number like 19.90.',
      'Variant 2 (L) uses L, which Size no longer has: pick another value or remove the variant.',
    ]);
    // Removing every variant then starts the single price from the last one shown.
    await click(control(container, 'Remove variant 2'));
    await click(control(container, 'Remove variant 1'));
    const price = byId(container, 'product-price');
    expect(price instanceof HTMLInputElement && price.value).toBe('20');
  });
});

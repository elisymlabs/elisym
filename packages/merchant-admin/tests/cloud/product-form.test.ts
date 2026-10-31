import { describe, expect, it } from 'vitest';
import {
  MAX_PRODUCT_BYTES,
  changedCount,
  draftOf,
  draftSet,
  fieldProblems,
  freeSlug,
  priceProblem,
  productBytes,
  productFields,
  productText,
  slugOf,
} from '../../src/cloud/lib/product-form';

const FIELDS = {
  title: 'Deposit "10" USD',
  priceUsd: '10',
  summary: 'Credits your account',
  description: 'Adds 10 USD.\n\nOnce paid.',
  onSale: true,
};

describe('a product as fields', () => {
  it('writes a PRODUCT.md, and reads it back the same', () => {
    const text = productText(FIELDS);
    expect(text).toBe(
      '---\ntitle: "Deposit \\"10\\" USD"\npriceUsd: "10"\nsummary: "Credits your account"\n---\n\nAdds 10 USD.\n\nOnce paid.\n',
    );
    // That cloud-api takes it as the node would is a contract test in the cloud repo.
    expect(productFields(text)).toEqual(FIELDS);
    const off = productText({ ...FIELDS, summary: '', onSale: false });
    expect(off).toContain('onSale: false');
    expect(off).not.toContain('summary');
    expect(productFields(off)).toEqual({ ...FIELDS, summary: '', onSale: false });
  });

  it('writes the title, summary, price and description trimmed', () => {
    const text = productText({
      title: '  Course  ',
      priceUsd: ' 10 ',
      summary: '  Short  ',
      description: '\n  A course.  \n\n',
      onSale: true,
    });
    expect(text).toBe('---\ntitle: "Course"\npriceUsd: "10"\nsummary: "Short"\n---\n\nA course.\n');
  });

  it('reads only what it writes: anything else is edited as text', () => {
    for (const text of [
      'title: x',
      '---\ntitle: "x"\npriceUsd: "1"\n',
      '---\ntitle: x\npriceUsd: "1"\n---\n',
      '---\ntitle: "x"\n---\n',
      '---\ntitle: "x"\npriceUsd: "1"\ntitle: "y"\n---\n',
      '---\ntitle: "x"\npriceUsd: "1"\nonSale: no\n---\n',
      '---\ntitle: "x"\npriceUsd: "1"\ndelivery: "a"\n---\n',
    ]) {
      expect(productFields(text)).toBeUndefined();
    }
    // A hand-written text the form would rewrite stays text, unchanged.
    const hand = '---\ntitle: "x"\npriceUsd: "1"\n---\nbody';
    expect(productFields(hand)).toBeDefined();
    expect(draftOf('x', hand).fields).toBeUndefined();
    expect(draftSet([draftOf('x', hand)])).toEqual({ x: hand });
    expect(draftOf('d', productText(FIELDS)).fields).toEqual(FIELDS);
  });

  it('checks the price, title and summary as the node would', () => {
    expect(priceProblem('49')).toBeUndefined();
    expect(priceProblem(' 0.50 ')).toBeUndefined();
    expect(priceProblem('0.000001')).toBeUndefined();
    for (const price of ['0', '0.0', '', '-1', '1e3', '1.1234567', '01', '1234567890', 'abc']) {
      expect(priceProblem(price)).toBeDefined();
    }
    expect(fieldProblems(FIELDS)).toEqual([]);
    expect(fieldProblems({ ...FIELDS, title: ' ' })).toEqual(['Give the product a title.']);
    expect(fieldProblems({ ...FIELDS, title: 'x'.repeat(201) })).toHaveLength(1);
    expect(fieldProblems({ ...FIELDS, summary: 'x'.repeat(1025) })).toHaveLength(1);
  });

  it('weighs a product as cloud-api does: its text as a JSON string', () => {
    expect(productBytes('a"b')).toBe(6);
    expect(productBytes('é')).toBe(4);
    expect(MAX_PRODUCT_BYTES).toBe(4096);
  });
});

describe('a product id from its title', () => {
  it('is lowercase letters, digits and dashes, and never taken twice', () => {
    expect(slugOf('  Deposit 10 USD!  ')).toBe('deposit-10-usd');
    expect(slugOf('Café crème')).toBe('cafe-creme');
    expect(slugOf('x'.repeat(80))).toHaveLength(63);
    expect(freeSlug('', new Set())).toBe('product');
    expect(freeSlug('A', new Set(['a', 'a-2']))).toBe('a-3');
    expect(freeSlug('x'.repeat(80), new Set(['x'.repeat(63)]))).toBe(`${'x'.repeat(61)}-2`);
  });
});

describe('changes in a draft', () => {
  it('counts each product added, removed or changed', () => {
    expect(changedCount({ a: '1', b: '2' }, { a: '1', b: '2' })).toBe(0);
    expect(changedCount({ a: '1', b: '2' }, { a: '9', c: '3' })).toBe(3);
  });
});

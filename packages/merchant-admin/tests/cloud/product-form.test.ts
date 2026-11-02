import { describe, expect, it } from 'vitest';
import {
  type ProductDraft,
  MAX_PRODUCT_BYTES,
  changedCount,
  draftOf,
  draftSet,
  fieldErrors,
  fieldProblems,
  charactersLeft,
  imageProblem,
  freeSlug,
  productIssues,
  roomLeft,
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
  image: '',
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

  it('writes a picture link after the summary, trimmed, and reads it back; none when empty', () => {
    const picture = 'https://shop.example/a "b".png';
    const text = productText({ ...FIELDS, image: `  ${picture}  ` });
    expect(text).toBe(
      `---\ntitle: "Deposit \\"10\\" USD"\npriceUsd: "10"\nsummary: "Credits your account"\nimage: ${JSON.stringify(picture)}\n---\n\nAdds 10 USD.\n\nOnce paid.\n`,
    );
    expect(productFields(text)).toEqual({ ...FIELDS, image: picture });
    expect(draftOf('d', text).fields).toEqual({ ...FIELDS, image: picture });
    expect(productText(FIELDS)).not.toContain('image');
    // A second image line is not one the form writes: edited as text.
    expect(
      productFields(text.replace('image:', 'image: "https://x.example/1.png"\nimage:')),
    ).toBeUndefined();
  });

  it('checks a picture link as the node would: optional, https only, in words at its field', () => {
    expect(imageProblem('')).toBeUndefined();
    expect(imageProblem('   ')).toBeUndefined();
    expect(imageProblem('https://shop.example/a.png')).toBeUndefined();
    for (const link of [
      'http://shop.example/a.png',
      'shop.example/a.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'https://',
      `https://shop.example/${'a'.repeat(1024)}.png`,
    ]) {
      expect(imageProblem(link), link).toBeDefined();
    }
    const errors = fieldErrors({ ...FIELDS, image: 'http://shop.example/a.png' });
    expect(errors.image).toBe(
      'A link to a picture that starts with https://, such as https://example.com/photo.jpg.',
    );
    expect(fieldProblems({ ...FIELDS, image: 'http://shop.example/a.png' })).toEqual([
      errors.image,
    ]);
  });

  it('writes the title, summary, price and description trimmed', () => {
    const text = productText({
      title: '  Course  ',
      priceUsd: ' 10 ',
      summary: '  Short  ',
      image: '',
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
    expect(freeSlug('', new Set())).toBe('product-1');
    // A title with no Latin letter or digit: the first free product-N.
    expect(freeSlug('Кофе', new Set(['product-1']))).toBe('product-2');
    expect(freeSlug('🎁', new Set(['product-1', 'product-3']))).toBe('product-2');
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

describe('the room left in a product', () => {
  it('is said only past 90% of the limit, in bytes left', () => {
    // A text of n characters weighs n + 2 bytes as a JSON string.
    expect(roomLeft('x'.repeat(3684))).toBeUndefined();
    expect(roomLeft('x'.repeat(3685))).toBe(4096 - 3687);
    expect(roomLeft('x'.repeat(5000))).toBeLessThan(0);
  });

  it('counts characters like the ones the text has: two-byte letters fit half as many', () => {
    expect(charactersLeft('x'.repeat(3685))).toBe(Math.floor((409 * 3685) / 3687));
    const cyrillic = 'ж'.repeat(1900);
    const bytes = new TextEncoder().encode(JSON.stringify(cyrillic)).length;
    expect(charactersLeft(cyrillic)).toBe(Math.floor(((4096 - bytes) * 1900) / bytes));
    expect(charactersLeft(cyrillic)).toBeLessThan(4096 - bytes);
    expect(charactersLeft('x'.repeat(5000))).toBe(0);
  });
});

describe("a product's issues before a save", () => {
  const product = (key: string, name: string): ProductDraft => ({
    key,
    name,
    nameTouched: true,
    fields: { title: 'T', priceUsd: '1', summary: '', image: '', description: '', onSale: true },
    text: '',
  });

  it('names a clash of ids against any other product of the draft, unless its own id is fixed', () => {
    const mug = product('new-1', 'mug');
    const cup = product('new-2', 'mug');
    expect(productIssues(cup, [mug, cup], false)).toEqual([
      'Another product has the button id mug.',
    ]);
    expect(productIssues(cup, [mug, cup], true)).toEqual([]);
    expect(productIssues(product('new-3', 'Bad Id'), [], false)).toEqual([
      'Its button id is lowercase letters, digits and dashes.',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { configTemplate } from '../src/config';
import { productTemplateText } from '../src/products';
import { configProblems, priceProblems, productSetProblems } from '../src/validate';
import { PAYOUT, USDC_DEVNET_CAIP19 } from './fixtures';

describe('the checks a control plane runs before writing a home', () => {
  it('a config: the node words each problem; a usable one has none', () => {
    const usable = {
      ...configTemplate('devnet'),
      name: 'Shop',
      payouts: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }],
    };
    expect(configProblems(usable)).toEqual([]);
    expect(configProblems({ ...usable, name: '' })).toEqual([expect.stringContaining('name')]);
    expect(configProblems({ ...usable, extra: 1 }).length).toBeGreaterThan(0);
    expect(typeof priceProblems).toBe('function');
  });

  it('a product set: as setup takes it, every problem named by its product', () => {
    const edited = '---\ntitle: Course\npriceUsd: "10"\n---\nA course.\n';
    expect(productSetProblems({ course: edited })).toEqual([]);
    expect(productSetProblems({})).toEqual(['no products: a store sells at least one']);
    expect(
      productSetProblems({
        course: edited,
        example: productTemplateText(),
        broken: 'no fence',
        open: '---\ntitle: x\n',
        old: '---\ndelivery: x\ntitle: T\npriceUsd: "1"\n---\n',
      }),
    ).toEqual([
      'products/broken: must start with a --- line, the frontmatter fence',
      'products/open: has no closing --- line after the frontmatter',
      expect.stringContaining('products/old: '),
      'products/example: is still the init example: set its title and description',
    ]);
    for (const name of ['a/b', '.hidden', '-dash', 'x'.repeat(65)]) {
      expect(productSetProblems({ [name]: edited }), name).toEqual([
        `products/${name}: a product directory is named 1-64 letters, digits, dots, dashes or underscores, starting with a letter or digit`,
      ]);
    }
    expect(productSetProblems({ 'A.b_c-1': edited, ['x'.repeat(64)]: edited })).toEqual([]);
    // A name the node refuses is all that is said of it, whatever its text.
    expect(productSetProblems({ 'a/b': 'no fence' })).toHaveLength(1);
  });
});

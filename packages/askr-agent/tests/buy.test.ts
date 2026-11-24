import type { CatalogItem } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { lintCases, parseStore } from '../evals/cases';
import { buildCatalog } from '../evals/harness';
import { StoreCatalog, hasBuyButton } from '../src/catalog/store-catalog';
import { globalBlock, storeBlock } from '../src/prompt';
import { executeTool, newTurnState } from '../src/tools';
import { CONFIG, ITEMS, NOW, POLICIES, toolCall } from './fixtures';

const PAYABLE = { naddr: 'naddr1test', network: 'devnet' as const };

function withPayable(ids: readonly string[], visibility?: CatalogItem['visibility']) {
  return ITEMS.map((entry) =>
    ids.includes(entry.d)
      ? { ...entry, payable: PAYABLE, ...(visibility === undefined ? {} : { visibility }) }
      : entry,
  );
}

function shopOf(items: CatalogItem[]): StoreCatalog {
  return new StoreCatalog(CONFIG, undefined, items, POLICIES);
}

function catalogLine(text: string, productId: string): string | undefined {
  return text.split('\n').find((line) => line.startsWith(`${productId} |`));
}

describe('the Buy marker (C8)', () => {
  it('hasBuyButton: payable and on sale only', () => {
    const [first] = ITEMS;
    if (first === undefined) {
      throw new Error('no items');
    }
    expect(hasBuyButton(first)).toBe(false);
    expect(hasBuyButton({ ...first, payable: PAYABLE })).toBe(true);
    expect(hasBuyButton({ ...first, payable: PAYABLE, visibility: 'sold-out' })).toBe(false);
    expect(hasBuyButton({ ...first, payable: PAYABLE, visibility: 'pre-order' })).toBe(false);
  });

  it('the catalog line ends with buy for a payable on-sale product, never for the others', () => {
    const text = storeBlock(shopOf(withPayable(['jacket-wool']))).block.text;
    expect(catalogLine(text, 'jacket-wool')?.endsWith(' | buy')).toBe(true);
    expect(catalogLine(text, 'jacket-rain')?.endsWith(' | buy')).toBe(false);
    expect(text).toContain('then "buy" when its card has a Buy button');
    const long = storeBlock(
      shopOf(
        withPayable(['jacket-wool']).map((entry) =>
          entry.d === 'jacket-wool' ? { ...entry, title: 'W'.repeat(500) } : entry,
        ),
      ),
    ).block.text;
    const longLine = catalogLine(long, 'jacket-wool');
    expect(longLine?.endsWith(' | buy')).toBe(true);
    // Cut to fit, the marker kept after the cut (the fence spells the ellipsis as three dots).
    expect(longLine).toMatch(/^jacket-wool \| W+\.\.\. \| buy$/);
    const soldOut = storeBlock(shopOf(withPayable(['jacket-wool'], 'sold-out'))).block.text;
    expect(catalogLine(soldOut, 'jacket-wool')?.endsWith(' | buy')).toBe(false);
  });

  it('search and details results carry buy_button only for a payable on-sale product', () => {
    const shop = shopOf(withPayable(['jacket-wool']));
    const state = newTurnState(new Set(), [], []);
    const search = JSON.parse(
      executeTool(shop, state, toolCall('search_products', { query: 'jacket' })).content,
    ) as { results: { id: string; buy_button?: boolean }[] };
    expect(search.results.find((result) => result.id === 'jacket-wool')?.buy_button).toBe(true);
    expect(
      search.results.find((result) => result.id === 'jacket-rain')?.buy_button,
    ).toBeUndefined();
    const details = JSON.parse(
      executeTool(shop, state, toolCall('get_product_details', { id: 'jacket-wool' })).content,
    ) as { buy_button?: boolean };
    expect(details.buy_button).toBe(true);
  });

  it('the global rules tell the agent how Buy works and never to take payment details', () => {
    const { text } = globalBlock();
    expect(text).toContain('Buy button on its card');
    expect(text).toContain('Never ask for, accept or repeat payment details');
    expect(text).not.toContain('The cards show the price, image and link');
  });

  it("the eval harness marks the store's payable products, and the lint names unknown ones", () => {
    const store = parseStore({
      config: {
        origins: ['https://shop.example.com'],
        name: 'Shop',
        language: 'en',
        currency: 'USD',
        source: { kind: 'admin' },
      },
      items: [
        { d: 'a', title: 'A', price: { amount: '1', currency: 'USD' } },
        { d: 'b', title: 'B', price: { amount: '2', currency: 'USD' } },
      ],
      payable: ['b'],
      policies: [],
    });
    const { catalog } = buildCatalog(store, NOW);
    expect(catalog.items.get('a')?.payable).toBeUndefined();
    expect(catalog.items.get('b')?.payable?.network).toBe('devnet');
    expect(lintCases([], { ...store, payable: ['zzz'] })).toContain(
      'store: payable names unknown product zzz',
    );
    expect(lintCases([], store)).toEqual([]);
  });
});

import type { Answer } from '@elisym/comcore';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts } from '../src/price-check';
import { CONFIG, item } from './fixtures';

const answer = (text: string): Answer => ({
  type: 'answer',
  ask_id: '0'.repeat(32),
  session_end: 1,
  text,
  components: [],
  chips: [],
});

interface Options {
  visitor?: string[];
  policies?: string[];
}

function violationsIn(currency: string, language: string, text: string, options: Options = {}) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency } });
  const store = new StoreCatalog({ ...CONFIG, currency, language }, undefined, [jacket], []);
  return checkPrices(answer(text), {
    storeCurrency: currency,
    items: store.items,
    visitorMessages: options.visitor ?? [],
    policyPassages: options.policies ?? [],
    locales: [language, language],
  }).length;
}

function twoProducts(currency: string, text: string) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency } });
  const gloves = item({ d: 'gloves', title: 'Gloves', price: { amount: '30', currency } });
  const store = new StoreCatalog(
    { ...CONFIG, currency, language: 'en' },
    undefined,
    [jacket, gloves],
    [],
  );
  return checkPrices(answer(text), {
    storeCurrency: currency,
    items: store.items,
    visitorMessages: [],
    policyPassages: [],
    locales: ['en', 'en'],
  }).length;
}

describe('A1-A2. "U.S." after a number merges only before a dollar word', () => {
  it.each([
    ['USD', 'The Jacket is $1200 U.S. The Gloves are $1200.'],
    ['CAD', 'The Jacket is $1,200 U.S. The Gloves are $1,200 too.'],
    ['USD', 'The Jacket costs 1,200 U.S. Gloves are $1200 too.'],
    ['CAD', 'The Jacket is 1200 U.S. The Gloves are 1200 dollars.'],
    ['USD', 'The Jacket ships across the U.S. e-Bike Gloves cost $1200.'],
    ['USD', 'The Jacket ships across the U.S. x-Gloves cost $1200.'],
  ])('%s: "%s" is caught', (currency, text) => {
    expect(twoProducts(currency, text)).toBe(1);
  });

  it('"999 U.S. Dollars and ships free" is still one amount', () => {
    expect(violationsIn('USD', 'en', 'The Jacket costs 999 U.S. Dollars and ships free.')).toBe(1);
  });
});

describe('A3. one number read two ways keeps only the shared currencies', () => {
  it('"$1200 CAD" in a USD store is caught', () => {
    expect(violationsIn('USD', 'en', 'The Jacket costs $1200 CAD.')).toBe(1);
  });

  it('"$1200 USD" in a USD store passes', () => {
    expect(violationsIn('USD', 'en', 'The Jacket costs $1200 USD.')).toBe(0);
  });
});

describe('B1. pinned codes, ranges and word boundaries', () => {
  it('a range after a pinned code keeps its upper bound', () => {
    expect(violationsIn('USD', 'en', 'The Jacket costs 1200 dollars USD to 1500.')).toBe(1);
  });

  it.each([
    ['CAD', 'The Jacket is 1200 dollars USDC friendly.'],
    ['USD', 'The Jacket is 1200 dollars CADENCE style.'],
  ])('%s: a code that starts a longer word pins nothing: "%s"', (currency, text) => {
    expect(violationsIn(currency, 'en', text)).toBe(0);
  });
});

describe('B2. a code unlocks a noun that is money only for it', () => {
  it.each([
    ['EUR', 'The Jacket costs 1200 pounds GBP.'],
    ['EUR', 'The Jacket costs 1200 won KRW.'],
  ])('%s: "%s" is caught', (currency, text) => {
    expect(violationsIn(currency, 'en', text)).toBe(1);
  });
});

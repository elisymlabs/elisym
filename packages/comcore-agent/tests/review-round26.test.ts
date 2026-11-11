import type { Answer } from '@elisym/comcore';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts, stripViolations } from '../src/price-check';
import { runTurn } from '../src/turn';
import { CONFIG, NOW, item, scripted } from './fixtures';

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

function inrStore() {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency: 'INR' } });
  return new StoreCatalog({ ...CONFIG, currency: 'INR', language: 'en' }, undefined, [jacket], []);
}

const inrContext = () => ({
  storeCurrency: 'INR',
  items: inrStore().items,
  visitorMessages: [],
  policyPassages: [],
  locales: ['en', 'en'],
});

describe('stripping takes the lent symbol with the removed sentence', () => {
  it.each([
    'The Jacket costs Rs. 1500 today. 999 people bought it.',
    'The Jacket costs Rs. 1500. 3 colours are available.',
  ])('"%s" strips clean', (text) => {
    const first = answer(text);
    const violations = checkPrices(first, inrContext());
    expect(violations.length).toBeGreaterThan(0);
    const cleaned = stripViolations(first, violations, 'en');
    expect(cleaned.text).not.toContain('Rs.');
    expect(checkPrices(cleaned, inrContext())).toHaveLength(0);
  });

  it('runTurn ends with an answer that passes its own check', async () => {
    const { provider } = scripted([
      { text: 'The Jacket costs Rs. 1500 today. 999 people bought it.' },
    ]);
    const output = await runTurn({
      catalog: inrStore(),
      provider,
      history: [],
      askId: 'a'.repeat(32),
      text: 'price?',
      locale: 'en',
      sessionEnd: NOW + 3_600,
      now: NOW,
      earlierVisitorMessages: [],
      earlierPolicyPassages: [],
    });
    expect(checkPrices(output.answer, inrContext())).toHaveLength(0);
    expect(output.answer.text).not.toContain('Rs.');
  });
});

describe('a CHF lent symbol', () => {
  it('"kostet Fr. 1500. 900 Stück" strips clean', () => {
    const jacket = item({
      d: 'jacket',
      title: 'Jacket',
      price: { amount: '1200', currency: 'CHF' },
    });
    const store = new StoreCatalog(
      { ...CONFIG, currency: 'CHF', language: 'de' },
      undefined,
      [jacket],
      [],
    );
    const context = {
      storeCurrency: 'CHF',
      items: store.items,
      visitorMessages: [],
      policyPassages: [],
      locales: ['de', 'de'],
    };
    const first = answer('Die Jacket kostet Fr. 1500. 900 Stück sind auf Lager.');
    const cleaned = stripViolations(first, checkPrices(first, context), 'de');
    expect(checkPrices(cleaned, context)).toHaveLength(0);
    expect(extractAmounts(cleaned.text, ['de'], 'CHF')).toHaveLength(0);
  });
});

import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts, stripViolations } from '../src/price-check';
import { runTurn } from '../src/turn';
import { CONFIG, NOW, catalog, item, scripted, toolCall } from './fixtures';

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

function contextOf(currency: string, language: string) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency } });
  const store = new StoreCatalog({ ...CONFIG, currency, language }, undefined, [jacket], []);
  return {
    storeCurrency: currency,
    items: store.items,
    visitorMessages: [],
    policyPassages: [],
    locales: [language, language],
  };
}

describe('A1. names and codes get no dotted form', () => {
  it.each([
    ['USD', 'en', 'All prices are in US dollars. 3 colors are available.'],
    ['USD', 'en', 'Prices are in dollars.\n1. Pick a size.\n2. Pick a color.'],
    ['EUR', 'de', 'Alle Preise in Euro. 3 Farben sind verfügbar.'],
    ['EUR', 'en', 'Prices are in euros. 2 colors left.'],
    ['CHF', 'en', 'Prices are in CHF. 3 sizes in stock.'],
    ['EUR', 'it', 'Grazie a lei. 3 giorni lavorativi per la consegna.'],
  ])('%s %s: "%s" has no violation', (currency, language, text) => {
    expect(checkPrices(answer(text), contextOf(currency, language))).toHaveLength(0);
  });

  it('the listed abbreviations still read with a dot', () => {
    expect(extractAmounts('Rp. 15.000', ['id'], 'IDR')).toHaveLength(1);
  });
});

describe('A2-A3. the final answer always passes its own check', () => {
  it('a component chain is stripped until clean', async () => {
    const calls = () => [
      toolCall('present_plan', {
        title: 'Step one',
        steps: [
          { label: 'Add a belt for $999', ids: ['jacket-wool'] },
          { label: 'Done', ids: [] },
        ],
      }),
      toolCall('present_plan', {
        title: 'Pairs with the $120 pick',
        steps: [{ label: 'Get it', ids: ['jacket-rain'] }],
      }),
      toolCall('present_plan', {
        title: 'All under $79.90',
        steps: [{ label: 'Add', ids: ['scarf'] }],
      }),
      toolCall('present_suggestions', { chips: ['Extras at $25'] }),
    ];
    const store = catalog();
    const { provider } = scripted([
      { calls: calls() },
      { text: 'Here you go.' },
      { calls: calls() },
      { text: 'Here you go.' },
    ]);
    const output = await runTurn({
      catalog: store,
      provider,
      history: [],
      askId: '0'.repeat(32),
      text: 'hi',
      locale: 'en',
      sessionEnd: NOW + 600,
      now: NOW,
      earlierVisitorMessages: [],
      earlierPolicyPassages: [],
    });
    expect(
      checkPrices(output.answer, {
        storeCurrency: 'USD',
        items: store.items,
        visitorMessages: ['hi'],
        policyPassages: [],
        locales: ['en', 'en'],
      }),
    ).toHaveLength(0);
    // Stripping keeps the true text; it never falls back to the pointer alone here.
    expect(output.answer.text).toContain('Here you go.');
  });

  it('a three-level text cascade ends clean', async () => {
    const text =
      'Prices are in Rs. We also take Rs. The bag costs $999. 5 colors. 7 sizes. Thanks!';
    const { provider } = scripted([{ text }]);
    const store = new StoreCatalog(
      { ...CONFIG, currency: 'INR', language: 'en' },
      undefined,
      [item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency: 'INR' } })],
      [],
    );
    const output = await runTurn({
      catalog: store,
      provider,
      history: [],
      askId: '0'.repeat(32),
      text: 'price?',
      locale: 'en',
      sessionEnd: NOW + 600,
      now: NOW,
      earlierVisitorMessages: [],
      earlierPolicyPassages: [],
    });
    expect(checkPrices(output.answer, contextOf('INR', 'en'))).toHaveLength(0);
    expect(stripViolations(output.answer, [], 'en').text).toBe(output.answer.text);
  });
});

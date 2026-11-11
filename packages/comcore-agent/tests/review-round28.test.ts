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

function strip(currency: string, language: string, text: string) {
  const first = answer(text);
  return stripViolations(first, checkPrices(first, contextOf(currency, language)), language).text;
}

describe('A1. dotted multi-letter symbols', () => {
  it.each([
    ['IDR', 'id', 'Ongkir Rp. 15.000 saja.'],
    ['IDR', 'en', 'Shipping is Rp. 15000 only.'],
    ['MYR', 'en', 'Shipping costs RM. 15.'],
    ['PEN', 'es', 'El envío cuesta S/. 15.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(checkPrices(answer(text), contextOf(currency, language)).length).toBeGreaterThan(0);
  });

  it.each([
    ['IDR', 'id', 'Jacket Rp. 1.200 saja.'],
    ['PEN', 'es', 'La Jacket cuesta S/. 1200.'],
  ])('%s %s: the real price in "%s" passes', (currency, language, text) => {
    expect(checkPrices(answer(text), contextOf(currency, language))).toHaveLength(0);
  });
});

describe('A2. only a borrowing sentence takes its lender', () => {
  it.each([
    [
      'EUR',
      'de',
      'Der Kundenservice ist erreichbar Mo. bis Fr. Versand in die USA kostet 15 $. Abholung ist gratis.',
      'Mo. bis Fr.',
    ],
    ['CHF', 'de', 'Geöffnet Mo. bis Fr. Versand kostet 15 $. Samstag geschlossen.', 'Mo. bis Fr.'],
    [
      'INR',
      'en',
      'All our prices are in Rs. Shipping to the US costs $15.',
      'All our prices are in Rs.',
    ],
    ['SEK', 'sv', 'Alla priser anges i kr. Frakt kostar 15 $.', 'Alla priser anges i kr.'],
    ['INR', 'en', 'All prices are in Rs. Delivery costs Rs. 50 extra.', 'All prices are in Rs.'],
  ])('%s %s: "%s" keeps "%s"', (currency, language, text, kept) => {
    expect(strip(currency, language, text)).toContain(kept);
  });

  it('a borrowing sentence still takes its lender', () => {
    expect(strip('INR', 'en', 'Delivery costs Rs. 50 extra. 3 colours.')).not.toContain('costs');
  });
});

describe('A3. a second strip pass keeps true text', () => {
  it('"1200 Rs. Shipping costs $15. 999 people" keeps the true price', async () => {
    const { provider } = scripted([
      { text: 'The Jacket costs 1200 Rs. Shipping costs $15. 999 people love it.' },
    ]);
    const output = await runTurn({
      catalog: new StoreCatalog(
        { ...CONFIG, currency: 'INR', language: 'en' },
        undefined,
        [item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency: 'INR' } })],
        [],
      ),
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
    expect(output.answer.text).toContain('The Jacket costs 1200 Rs.');
    expect(checkPrices(output.answer, contextOf('INR', 'en'))).toHaveLength(0);
    expect(output.stripped.length).toBeGreaterThan(1);
  });
});

describe('weekday ranges', () => {
  it('"Mo. bis Fr. 2 Tage" in a CHF store is no money', () => {
    expect(extractAmounts('Der Versand dauert Mo. bis Fr. 2 Tage.', ['de'], 'CHF')).toHaveLength(0);
  });
});

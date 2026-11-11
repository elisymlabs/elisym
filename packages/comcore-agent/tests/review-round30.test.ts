import type { Answer } from '@elisym/comcore';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { cardsPointer, checkPrices, extractAmounts, stripViolations } from '../src/price-check';
import { runTurn } from '../src/turn';
import { CONFIG, NOW, item, scripted, toolCall } from './fixtures';

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

function storeOf(currency: string, language: string) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency } });
  return new StoreCatalog({ ...CONFIG, currency, language }, undefined, [jacket], []);
}

function contextOf(currency: string, language: string) {
  return {
    storeCurrency: currency,
    items: storeOf(currency, language).items,
    visitorMessages: [],
    policyPassages: [],
    locales: [language, language],
  };
}

describe('A1. a list marker on a new line borrows no symbol', () => {
  it.each([
    ['INR', 'en', 'All prices are in Rs.\n1. Pick a size.\n2. Pick a color.'],
    ['SEK', 'sv', 'Alla priser i kr.\n1. Välj storlek.\n2. Välj färg.'],
    ['CHF', 'de', 'Alle Preise in Fr.\n1. Größe wählen.\n2. Farbe wählen.'],
    ['IDR', 'id', 'Semua harga dalam Rp.\n1. Pilih ukuran.\n2. Pilih warna.'],
    ['MYR', 'en', 'All prices in RM.\n1. Pick a size.\n2. Pick a color.'],
  ])('%s %s: "%s" has no violation', (currency, language, text) => {
    expect(checkPrices(answer(text), contextOf(currency, language))).toHaveLength(0);
  });

  it('a price on its own new line still borrows', () => {
    expect(
      checkPrices(answer('The Jacket costs Rs.\n999.'), contextOf('INR', 'en')).length,
    ).toBeGreaterThan(0);
  });
});

describe('A2. the pointer is never cut', () => {
  it('a long answer keeps the whole pointer once', () => {
    const text = `${'The wool jacket is warm and soft. '.repeat(117)}Only $5.`;
    const first = answer(text);
    const cleaned = stripViolations(first, checkPrices(first, contextOf('USD', 'en')), 'en');
    const pointer = cardsPointer('en');
    expect(cleaned.text.endsWith(pointer)).toBe(true);
    expect(cleaned.text.length).toBeLessThanOrEqual(4_000);
    expect(cleaned.text.split(pointer).length - 1).toBe(1);
  });
});

describe('A3. the strip bound fails closed', () => {
  it('a cascade past the bound leaves the pointer alone, no chips, no components', async () => {
    const text = `${'We also take Rs. '.repeat(33)}The bag costs $999. ${'5 colors. '.repeat(33)}Thanks!`;
    const { provider } = scripted([
      { text, calls: [toolCall('present_suggestions', { chips: ['Show jackets'] })] },
      { text },
    ]);
    const output = await runTurn({
      catalog: storeOf('INR', 'en'),
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
    expect(output.answer.text).toBe(cardsPointer('en'));
    expect(output.answer.chips).toEqual([]);
    expect(output.answer.components).toEqual([]);
    expect(output.stripped.length).toBeGreaterThan(0);
    expect(extractAmounts(output.answer.text, ['en'], 'INR')).toHaveLength(0);
  });
});

describe('security review: every static abbreviation also reads with a dot', () => {
  it.each([
    ['PLN', 'pl', 'Wysyłka zł. 15 tylko.'],
    ['CZK', 'cs', 'Doprava Kč. 15 navíc.'],
    ['BGN', 'bg', 'Доставка лв. 15 отделно.'],
    ['TRY', 'tr', 'Kargo TL. 50 ek ücret.'],
    ['IDR', 'id', 'Ongkir Rp. 15.000 saja.'],
    ['MYR', 'en', 'Shipping costs RM. 15.'],
    ['PEN', 'es', 'El envío cuesta S/. 15.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(checkPrices(answer(text), contextOf(currency, language)).length).toBeGreaterThan(0);
  });

  it('a store name or code never gets a dotted form, nor the word "lei"', () => {
    expect(
      checkPrices(answer('Prices are in CHF. 3 sizes in stock.'), contextOf('CHF', 'en')),
    ).toHaveLength(0);
    expect(
      checkPrices(answer('Grazie a lei. 3 giorni lavorativi.'), contextOf('EUR', 'it')),
    ).toHaveLength(0);
  });
});

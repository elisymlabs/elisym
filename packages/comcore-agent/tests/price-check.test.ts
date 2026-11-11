import type { Answer } from '@elisym/comcore';
import { describe, expect, it } from 'vitest';
import { checkPrices, extractAmounts, stripViolations } from '../src/price-check';
import { CATALOG_KEY, catalog } from './fixtures';

const address = (d: string) => `30402:${CATALOG_KEY}:${d}`;

function answer(text: string, overrides: Partial<Answer> = {}): Answer {
  return {
    type: 'answer',
    ask_id: '0'.repeat(32),
    session_end: 1,
    text,
    components: [
      {
        type: 'products',
        picks: [{ address: address('jacket-wool') }, { address: address('jacket-rain') }],
      },
    ],
    chips: [],
    ...overrides,
  };
}

const store = catalog();
const context = (
  visitorMessages: string[] = [],
  policyPassages: string[] = [],
  locales = ['en'],
) => ({
  storeCurrency: 'USD',
  items: store.items,
  visitorMessages,
  policyPassages,
  locales,
});

describe('extractAmounts', () => {
  it('reads symbols and codes on either side with locale grammars', () => {
    const [euro] = extractAmounts('costs 1.299,00 € today', ['de']);
    expect(euro?.currencies).toEqual(['EUR']);
    expect(euro?.values.map((value) => value.toString())).toContain('1299');
    expect(extractAmounts('USD 79.90 and $120', ['en']).map((amount) => amount.raw)).toEqual([
      'USD 79.90',
      '$120',
    ]);
    expect(extractAmounts('version 2 has 30 pockets', ['en'])).toEqual([]);
  });
});

describe('checkPrices', () => {
  it('passes cited prices, a sum over one component and a comparison difference', () => {
    expect(checkPrices(answer('The wool one is $120 and the rain one $79.90.'), context())).toEqual(
      [],
    );
    expect(checkPrices(answer('Both together come to $199.90.'), context())).toEqual([]);
    const comparison = answer('The rain jacket is $40.10 cheaper.', {
      components: [
        {
          type: 'comparison',
          addresses: [address('jacket-wool'), address('jacket-rain')],
          rows: [{ dimension: 'Price', cells: ['120 USD', '79.9 USD'] }],
        },
      ],
    });
    expect(checkPrices(comparison, context())).toEqual([]);
  });

  it('flags an invented price', () => {
    expect(checkPrices(answer('The wool one is on sale for $99.'), context())).toHaveLength(1);
  });

  it('allows the visitor budget only where no product is named', () => {
    expect(
      checkPrices(answer('Both stay under your $150.'), context(['under $150 please'])),
    ).toEqual([]);
    expect(
      checkPrices(answer('The Wool jacket costs $150.'), context(['under $150 please'])),
    ).toHaveLength(1);
  });

  it('allows a policy fee in another currency, never a converted price', () => {
    const policy = ['EU shipping €15.'];
    expect(checkPrices(answer('Shipping to the EU is €15.'), context([], policy))).toEqual([]);
    expect(checkPrices(answer('That is about €110.'), context([], policy))).toHaveLength(1);
  });

  it('checks component strings too, and strips what still fails', () => {
    const bad = answer('Here you go.', {
      components: [
        { type: 'products', picks: [{ address: address('scarf'), reason: 'only $5 today' }] },
      ],
      chips: ['Show me ones under $3'],
    });
    const violations = checkPrices(bad, context());
    expect(violations.map((violation) => violation.where)).toEqual([
      'component#0.pick#0',
      'chip#0',
    ]);
    const stripped = stripViolations(bad, violations);
    const component = stripped.components[0];
    expect(component?.type === 'products' && component.picks[0]).toEqual({
      address: address('scarf'),
    });
    expect(stripped.chips).toEqual([]);
  });
});

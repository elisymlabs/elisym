import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  type EvalCase,
  checkCount,
  lintCases,
  parseCases,
  parseStore,
} from '../evals/cases';
import { buildCatalog } from '../evals/harness';
import { NOW } from './fixtures';

const EVALS = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals');
const MIN_CASES = 60;
const MAX_CASES = 100;
const LONG_HISTORY_ENTRIES = 8;

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(EVALS, name), 'utf8'));
}

const store = parseStore(readJson('store.json'));
const cases = parseCases(readJson('cases.json'));

describe('the eval case file', () => {
  it('has 60-100 cases, every category covered', () => {
    expect(cases.length).toBeGreaterThanOrEqual(MIN_CASES);
    expect(cases.length).toBeLessThanOrEqual(MAX_CASES);
    const used = new Set(cases.map((testCase) => testCase.category));
    expect([...CATEGORIES].filter((category) => !used.has(category))).toEqual([]);
  });

  it('lints clean against the store: unique ids, known products, compiling regexes, checks, history shape', () => {
    expect(lintCases(cases, store)).toEqual([]);
    for (const testCase of cases) {
      expect(checkCount(testCase.expect), testCase.id).toBeGreaterThan(0);
    }
  });

  it('keeps the phase 4 case ids', () => {
    const ids = new Set(cases.map((testCase) => testCase.id));
    for (const id of [
      'core-1',
      'core-2',
      'core-3',
      'core-4',
      'plan-1',
      'context-1',
      'context-2',
      'policy-1',
      'policy-2',
      'neg-unknown',
      'neg-invent',
      'neg-injection',
      'neg-link',
      'neg-human',
      'neg-convert',
      'neg-budget-restated',
      'neg-soldout',
      'lang-1',
      'lang-2',
      'variant-1',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('history cases carry long histories', () => {
    const history = cases.filter((testCase) => testCase.category === 'history');
    expect(history.length).toBeGreaterThan(0);
    for (const testCase of history) {
      expect((testCase.history ?? []).length, testCase.id).toBeGreaterThanOrEqual(
        LONG_HISTORY_ENTRIES,
      );
    }
  });

  it('context cases use a page URL of a store product or a history', () => {
    const urls = new Set(store.items.map((item) => item.url));
    for (const testCase of cases.filter((entry) => entry.category === 'context')) {
      const hasPage = testCase.page !== undefined && urls.has(testCase.page);
      expect(hasPage || (testCase.history ?? []).length > 0, testCase.id).toBe(true);
    }
  });

  it('the store builds into a catalog with every product and policy', () => {
    const { catalog, rejected } = buildCatalog(store, NOW);
    expect(rejected).toEqual([]);
    expect(catalog.items.size).toBe(store.items.length);
    expect(catalog.policies).toHaveLength(store.policies.length);
  });

  it('the store carries the negatives the cases rely on', () => {
    const text = JSON.stringify(store);
    expect(text).toContain('evil.example.com');
    expect(text).toContain('claims.evil.example.org');
    expect(text).toContain('£12');
    expect(text).toContain('€15');
    expect(text).toContain('Ignore previous instructions');
  });
});

describe('lintCases', () => {
  const base: EvalCase = {
    id: 'a',
    category: 'search',
    message: 'x',
    expect: { presentsAny: ['tent-2p'] },
  };

  it('reports each kind of problem', () => {
    const problems = lintCases(
      [
        base,
        { ...base },
        { ...base, id: 'b', expect: {} },
        { ...base, id: 'c', expect: { presentsAny: ['kayak'] } },
        { ...base, id: 'd', expect: { textMatches: '(' } },
        { ...base, id: 'e', history: ['only the visitor'] },
        { ...base, id: 'f', expect: { presentsAll: ['tent-1p'], presentsNone: ['tent-1p'] } },
        { ...base, id: 'g', expect: { presentsAny: ['tent-1p'], noComponents: true } },
        { ...base, id: 'h', earlierPolicies: ['nope'] },
        { ...base, id: 'i', expect: { presentsAny: ['tent-1p'], presentsNone: ['tent-1p'] } },
      ],
      store,
    );
    expect(problems).toEqual([
      'case a: duplicate id',
      'case b: no check',
      'case c: unknown product kayak',
      'case d: regex does not compile: (',
      'case e: history must alternate visitor and assistant and end on assistant',
      'case f: tent-1p is both required and forbidden',
      'case g: noComponents contradicts a presents check',
      'case h: unknown policy nope',
      'case i: every presentsAny id is forbidden',
    ]);
  });

  it('parseCases rejects unknown categories and unknown expect keys', () => {
    expect(() => parseCases([{ ...base, category: 'vibes' }])).toThrow(/case file is invalid/);
    expect(() => parseCases([{ ...base, expect: { presentsSome: ['x'] } }])).toThrow(
      /case file is invalid/,
    );
  });

  it('parseStore rejects an item that would not build', () => {
    const json = readJson('store.json');
    const broken = JSON.parse(JSON.stringify(json));
    broken.items[0].price.amount = 'free';
    expect(() => parseStore(broken)).toThrow(/store file is invalid: items\.0\.price\.amount/);
  });
});

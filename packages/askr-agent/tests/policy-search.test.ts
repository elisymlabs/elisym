import type { Policy } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import {
  MAX_POLICY_RESULTS,
  PASSAGE_GAP,
  POLICY_RESULT_CHARS,
  policyPassage,
  rankPolicies,
  wordsMatch,
} from '../src/policy-search';
import { executeTool, newTurnState } from '../src/tools';
import { CATALOG_KEY, CONFIG, ITEMS, NOW, toolCall } from './fixtures';

function policy(slug: string, title: string, body: string): Policy {
  return { author: CATALOG_KEY, slug, title, body, createdAt: NOW };
}

const FILLER = 'Our team packs every order with care and checks it twice. '.repeat(40).trim();

/** A long returns policy whose answer sits at its very end. */
const LONG_RETURNS = [
  '# Returns',
  FILLER,
  '## Damaged parcels',
  FILLER,
  '## Gift cards',
  FILLER,
  '## Final sale',
  'Swimwear and earrings are final sale and cannot be refunded.',
].join('\n\n');

const POLICIES = [
  policy('shipping', 'Shipping', 'Free shipping in the US over $50. EU shipping €15.'),
  policy('returns', 'Returns and refunds', LONG_RETURNS),
  policy('sizing', 'Size guide', 'Our jackets run small: order one size up.'),
  policy('faq', 'FAQ', 'Do you ship to Canada? Yes, in five to seven days.'),
];

function storeCatalog(policies: readonly Policy[] = POLICIES): StoreCatalog {
  return new StoreCatalog(CONFIG, { voice: 'friendly', instructions: '', notes: '' }, ITEMS, [
    ...policies,
  ]);
}

interface Result {
  slug: string;
  title: string;
  passage: string;
}

function search(input: Record<string, unknown>, policies?: readonly Policy[]) {
  const state = newTurnState(new Set(), []);
  const outcome = executeTool(storeCatalog(policies), state, toolCall('search_policies', input));
  const json: { results: Result[]; unknown_slugs?: string[]; note?: string } = JSON.parse(
    outcome.content,
  );
  return { json, state };
}

describe('wordsMatch', () => {
  it.each([
    ['return', 'returns'],
    ['refund', 'refunded'],
    ['ship', 'shipping'],
    ['доставка', 'доставки'],
    ['exchange', 'exchanging'],
  ])('%s matches %s', (left, right) => {
    expect(wordsMatch(left, right)).toBe(true);
    expect(wordsMatch(right, left)).toBe(true);
  });

  it.each([
    ['car', 'card'],
    ['return', 'retail'],
    ['size', 'sizing'],
  ])('%s does not match %s', (left, right) => {
    expect(wordsMatch(left, right)).toBe(false);
  });
});

describe('rankPolicies', () => {
  it('finds a policy by another form of its words, the title first on a tie', () => {
    const ranked = rankPolicies(POLICIES, ['refunds'], MAX_POLICY_RESULTS);
    expect(ranked.map((entry) => entry.slug)).toEqual(['returns']);
    const shipped = rankPolicies(POLICIES, ['ship'], MAX_POLICY_RESULTS);
    expect(shipped.map((entry) => entry.slug)).toEqual(['shipping', 'faq']);
  });

  it('leaves out a policy with none of the words, and returns at most the limit', () => {
    expect(rankPolicies(POLICIES, ['unicorn'], MAX_POLICY_RESULTS)).toEqual([]);
    expect(rankPolicies(POLICIES, [], MAX_POLICY_RESULTS)).toEqual([]);
    expect(rankPolicies(POLICIES, ['our'], 2)).toHaveLength(2);
  });
});

describe('policyPassage', () => {
  it('returns a policy within the budget whole', () => {
    expect(policyPassage('Short.', ['anything'], 100)).toBe('Short.');
  });

  it('keeps the paragraphs the query points at, with their heading, and marks the gaps', () => {
    const passage = policyPassage(LONG_RETURNS, ['swimwear'], 1_000);
    expect(passage.length).toBeLessThanOrEqual(1_000);
    expect(passage).toContain('## Final sale\nSwimwear and earrings are final sale');
    expect(passage.startsWith(PASSAGE_GAP)).toBe(true);
  });

  it('keeps the start of a long policy for no query, ending in a gap', () => {
    const passage = policyPassage(LONG_RETURNS, [], 3_000);
    expect(passage.startsWith('# Returns')).toBe(true);
    expect(passage.endsWith(PASSAGE_GAP)).toBe(true);
    expect(passage).not.toContain('Swimwear');
  });

  it('cuts one paragraph over the budget rather than return nothing', () => {
    const passage = policyPassage('word '.repeat(500), [], 100);
    expect(passage.length).toBe(100);
  });
});

describe('search_policies', () => {
  it('reads the policies the model picked by slug, in any order, the unknown ones named', () => {
    const { json, state } = search({ slugs: ['sizing', 'nope', 'shipping'] });
    expect(json.results.map((result) => result.slug)).toEqual(['sizing', 'shipping']);
    expect(json.unknown_slugs).toEqual(['nope']);
    expect(state.policyPassages).toHaveLength(2);
  });

  it('gives a long policy picked by slug the passage its query points at', () => {
    const { json } = search({ slugs: ['returns', 'shipping', 'sizing'], query: 'swimwear' });
    const returns = json.results.find((result) => result.slug === 'returns');
    expect(returns?.passage).toContain('Swimwear and earrings are final sale');
    const total = json.results.reduce((sum, result) => sum + result.passage.length, 0);
    // The fence lines are the only text over the shared budget.
    expect(total).toBeLessThan(POLICY_RESULT_CHARS + 200);
  });

  it('reads a policy picked alone whole up to the budget', () => {
    const { json } = search({ slugs: ['returns'] });
    expect(LONG_RETURNS.length).toBeLessThan(POLICY_RESULT_CHARS);
    expect(json.results[0]?.passage).toContain('Swimwear and earrings are final sale');
  });

  it('falls back to the query when no picked slug exists', () => {
    const { json } = search({ slugs: ['nope'], query: 'refunded' });
    expect(json.results.map((result) => result.slug)).toEqual(['returns']);
  });

  it('takes at most three slugs, whatever the model sends', () => {
    const many = Array.from({ length: 10 }, (_unused, index) =>
      policy(`p${index}`, `Policy ${index}`, 'Text.'),
    );
    const { json } = search({ slugs: many.map((entry) => entry.slug).concat(['x1', 'x2']) }, many);
    expect(json.results).toHaveLength(MAX_POLICY_RESULTS);
    expect(json.unknown_slugs).toBeUndefined();
  });

  it('says so when nothing matched', () => {
    const { json } = search({ query: 'unicorn' });
    expect(json.results).toEqual([]);
    expect(json.note).toContain('slugs');
  });
});

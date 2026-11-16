import type { Policy } from '@elisym/askr';
import { tokenize } from './catalog/store-catalog';

/** Policies one search returns at most. */
export const MAX_POLICY_RESULTS = 3;
/** Policy text one search returns at most, shared by its results. */
export const POLICY_RESULT_CHARS = 12_000;
/** Two words of at least this many characters match when one starts the other. */
const STEM_MIN_CHARS = 4;
/** Characters a matching word may differ by at its end: return / returns / returned. */
const STEM_SLACK_CHARS = 2;
/** What stands between two passages of a policy that were not next to each other. */
export const PASSAGE_GAP = '[...]';
const PASSAGE_SEPARATOR = '\n\n';

/**
 * Whether two words are the same word for policy search: equal, or one a
 * form of the other (`return`, `returns`, `returned`; the same in any language).
 * Words shorter than four characters match only exactly.
 */
export function wordsMatch(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const shorter = Math.min(left.length, right.length);
  if (shorter < STEM_MIN_CHARS) {
    return false;
  }
  let shared = 0;
  while (shared < shorter && left[shared] === right[shared]) {
    shared += 1;
  }
  return shared >= Math.max(STEM_MIN_CHARS, shorter - STEM_SLACK_CHARS);
}

/** How many of the query's words the text has, each counted once. */
function matchedWords(query: readonly string[], text: string): number {
  const words = [...new Set(tokenize(text))];
  return query.filter((term) => words.some((word) => wordsMatch(term, word))).length;
}

/**
 * The policies that answer a query best, at most `limit`: by how many query
 * words each one's slug, title and text has; title words break a tie. A policy
 * with none of them is left out.
 */
export function rankPolicies(
  policies: readonly Policy[],
  query: readonly string[],
  limit: number,
): Policy[] {
  return policies
    .map((policy, index) => ({
      policy,
      index,
      score: matchedWords(query, `${policy.slug} ${policy.title} ${policy.body}`),
      titleScore: matchedWords(query, `${policy.slug} ${policy.title}`),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || right.titleScore - left.titleScore || left.index - right.index,
    )
    .slice(0, limit)
    .map((entry) => entry.policy);
}

/** A policy's paragraphs; a heading stays with the paragraph under it. */
function paragraphsOf(body: string): string[] {
  const paragraphs: string[] = [];
  let heading = '';
  for (const block of body.split(/\n[ \t]*\n/)) {
    const text = block.trim();
    if (text === '') {
      continue;
    }
    if (/^#{1,6}\s/.test(text) && !text.includes('\n')) {
      heading = heading === '' ? text : `${heading}\n${text}`;
      continue;
    }
    paragraphs.push(heading === '' ? text : `${heading}\n${text}`);
    heading = '';
  }
  if (heading !== '') {
    paragraphs.push(heading);
  }
  return paragraphs;
}

/**
 * A policy's text within `maxChars`. A longer policy keeps the paragraphs with
 * the most query words, then the ones from its start that still fit, in their
 * own order, with `[...]` where it skips; with no query it keeps the start.
 * Never cut mid-paragraph unless one paragraph alone is over the budget.
 */
export function policyPassage(body: string, query: readonly string[], maxChars: number): string {
  if (body.length <= maxChars) {
    return body;
  }
  const paragraphs = paragraphsOf(body);
  const ranked = paragraphs
    .map((text, index) => ({ index, score: matchedWords(query, text) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const kept = new Set<number>();
  // The gap markers and separators count against the budget too.
  const reserve = PASSAGE_GAP.length + PASSAGE_SEPARATOR.length * 2;
  let used = 0;
  for (const entry of ranked) {
    const length = (paragraphs[entry.index] ?? '').length + reserve;
    if (used + length <= maxChars) {
      kept.add(entry.index);
      used += length;
    } else if (entry.score === 0) {
      // The rest match nothing: they fill in from the start and stop at the first that does
      // not fit, so the text read is one piece, not scraps from all over the policy.
      break;
    }
  }
  if (kept.size === 0) {
    const first = ranked[0];
    return first === undefined ? '' : (paragraphs[first.index] ?? '').slice(0, maxChars);
  }
  const parts: string[] = [];
  let previous = -1;
  for (const [index, text] of paragraphs.entries()) {
    if (!kept.has(index)) {
      continue;
    }
    if (index !== previous + 1) {
      parts.push(PASSAGE_GAP);
    }
    parts.push(text);
    previous = index;
  }
  if (previous !== paragraphs.length - 1) {
    parts.push(PASSAGE_GAP);
  }
  return parts.join(PASSAGE_SEPARATOR);
}

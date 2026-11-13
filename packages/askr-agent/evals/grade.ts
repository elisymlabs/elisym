/**
 * The deterministic layer of grading: component checks (which products were
 * presented), hard-token regexes on what the model wrote (the text and every
 * component string and chip), and the price check, which must not have had to
 * strip anything. Semantic checks are the judge's (`judge.ts`).
 */
import { type EvalCase, graderRegex, patternsOf } from './cases';
import type { CaseOutcome, WrittenString } from './harness';

const QUOTE_CHARS = 80;

function quote(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS)}...` : flat;
}

/** Why the answer fails the case; empty when it passes. */
export function grade(testCase: EvalCase, outcome: CaseOutcome): string[] {
  if (outcome.error !== undefined) {
    return [`turn error: ${outcome.error}`];
  }
  const { expect: expectation } = testCase;
  const { presented, text } = outcome;
  const shown = presented.length > 0 ? presented.join(', ') : 'nothing';
  const failures: string[] = [];
  if (
    expectation.presentsAny &&
    !expectation.presentsAny.some((productId) => presented.includes(productId))
  ) {
    failures.push(`expected one of ${expectation.presentsAny.join(', ')}, presented ${shown}`);
  }
  const missing = (expectation.presentsAll ?? []).filter(
    (productId) => !presented.includes(productId),
  );
  if (missing.length > 0) {
    failures.push(`expected all of ${missing.join(', ')} too, presented ${shown}`);
  }
  if (expectation.presentsFirst !== undefined && presented[0] !== expectation.presentsFirst) {
    failures.push(`expected ${expectation.presentsFirst} first, presented ${shown}`);
  }
  for (const productId of expectation.presentsNone ?? []) {
    if (presented.includes(productId)) {
      failures.push(`presented forbidden ${productId}`);
    }
  }
  if (expectation.maxPresented !== undefined && presented.length > expectation.maxPresented) {
    failures.push(`presented ${presented.length} products, at most ${expectation.maxPresented}`);
  }
  if (expectation.hasComponents && outcome.componentCount === 0) {
    failures.push('expected a component');
  }
  if (expectation.noComponents && outcome.componentCount > 0) {
    failures.push('expected no components');
  }
  // A pattern anchored at the start reads the answer text only: a chip ("Yes, show me tents")
  // is the visitor's reply, not the answer's first words.
  const readBy = (pattern: string): WrittenString[] =>
    pattern.startsWith('^')
      ? [{ label: 'text', text }]
      : [{ label: 'text', text }, ...outcome.strings];
  for (const pattern of patternsOf(expectation.textMatches)) {
    const regex = graderRegex(pattern);
    if (!readBy(pattern).some((entry) => regex.test(entry.text))) {
      failures.push(`text does not match /${pattern}/`);
    }
  }
  for (const pattern of patternsOf(expectation.textNotMatches)) {
    const regex = graderRegex(pattern);
    const hit = readBy(pattern).find((entry) => regex.test(entry.text));
    if (hit !== undefined) {
      failures.push(
        hit.label === 'text'
          ? `text matches forbidden /${pattern}/`
          : `${hit.label} "${quote(hit.text)}" matches forbidden /${pattern}/`,
      );
    }
  }
  if (outcome.strippedCount > 0) {
    failures.push(`price check stripped ${outcome.strippedCount} string(s) after the re-run`);
  }
  return failures;
}

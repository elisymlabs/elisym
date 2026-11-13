/**
 * Deterministic grading of one answer against a case's `expect`: component
 * checks first (which products were presented), loose regexes on the text,
 * and the price check, which must not have had to strip anything.
 */
import { type EvalCase, graderRegex, patternsOf } from './cases';
import type { CaseOutcome } from './harness';

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
  for (const pattern of patternsOf(expectation.textMatches)) {
    if (!graderRegex(pattern).test(text)) {
      failures.push(`text does not match /${pattern}/`);
    }
  }
  for (const pattern of patternsOf(expectation.textNotMatches)) {
    if (graderRegex(pattern).test(text)) {
      failures.push(`text matches forbidden /${pattern}/`);
    }
  }
  if (outcome.strippedCount > 0) {
    failures.push(`price check stripped ${outcome.strippedCount} string(s) after the re-run`);
  }
  return failures;
}

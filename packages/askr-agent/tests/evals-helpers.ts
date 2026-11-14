import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EvalCase, type EvalStore, type Expectation, parseStore } from '../evals/cases';
import { type CaseOutcome, buildCatalog } from '../evals/harness';
import { type JudgeClient, PREFLIGHT_CASE } from '../evals/judge';
import type { ResolvedJudge } from '../evals/models';
import type { ModelPrice } from '../src/llm/types';
import { NOW } from './fixtures';

export const EVALS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals');

export function evalStore(): EvalStore {
  return parseStore(JSON.parse(readFileSync(join(EVALS_DIR, 'store.json'), 'utf8')));
}

export function evalCatalog() {
  const { catalog, rejected } = buildCatalog(evalStore(), NOW);
  if (rejected.length > 0) {
    throw new Error(`eval store products did not build: ${rejected.join(', ')}`);
  }
  return catalog;
}

export function caseOf(expectation: Expectation, extra: Partial<EvalCase> = {}): EvalCase {
  return { id: 'case-1', category: 'search', message: 'a tent', ...extra, expect: expectation };
}

export function outcomeOf(extra: Partial<CaseOutcome> = {}): CaseOutcome {
  return {
    caseId: 'case-1',
    category: 'search',
    repeat: 1,
    text: 'Here is a tent.',
    strings: [],
    presented: [],
    componentCount: 0,
    strippedCount: 0,
    usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    modelCalls: 1,
    latencyMs: 100,
    ...extra,
  };
}

/** Round numbers so expected costs are easy to state exactly. */
export const PRICE: ModelPrice = {
  input: '3',
  cachedInput: '0.3',
  cacheWrite: '3.75',
  output: '15',
};

/** A judge that answers only the sweep's preflight: the cases it is given have no rubric. */
export function idleJudge(): ResolvedJudge {
  const client: JudgeClient = {
    model: 'judge-1',
    complete: (call) =>
      call.user.includes(PREFLIGHT_CASE.message)
        ? passingJudge().complete(call)
        : Promise.reject(new Error('the judge was not expected to run')),
  };
  return { label: 'Judge', model: 'judge-1', price: PRICE, client };
}

/** A judge that passes every criterion it is asked, reading the ids from the prompt. */
export function passingJudge(calls: string[] = []): JudgeClient {
  return {
    model: 'judge-1',
    complete: async (call) => {
      calls.push(call.user);
      const ids = [...call.user.matchAll(/^(c\d+): /gm)].map((match) => match[1]);
      return {
        text: JSON.stringify({
          criteria: ids.map((id) => ({ id, pass: true, reason: 'meets it' })),
        }),
        usage: { inputTokens: 2_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 50 },
      };
    },
  };
}

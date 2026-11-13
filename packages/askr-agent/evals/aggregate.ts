/**
 * Per-model metrics over graded runs (spec 8): strict pass counts with
 * repeats, per-category rates, exact costs (decimal.js-light), cost per
 * passing conversation, latency percentiles, calls and tokens.
 */
import Decimal from 'decimal.js-light';
import { type ModelPrice, type Usage, ZERO_USAGE, addUsage, costOf } from '../src/llm/types';
import type { CaseOutcome } from './harness';
import type { CriterionResult, JudgeResult } from './judge';

/** Rates are in basis points: 10000 bps = 100%. */
export const FULL_RATE_BPS = 10_000;
export const DEFAULT_BAR_BPS = 9_000;

export interface GradedRun extends CaseOutcome {
  failures: string[];
  passed: boolean;
  /** The model's cost, USD, exact, in plain notation (the judge's is apart). */
  cost: string;
  /** Model call attempts that failed (timed out, 429, 5xx...): their usage is unknown. */
  failedAttempts: number;
  /** The judge's verdict per rubric criterion, when it judged. */
  criteria?: CriterionResult[];
  /** The judge gave no valid verdict after retries: the run leaves the pass rate. */
  judgeError?: boolean;
  /** The case has a rubric that was not judged (--no-judge). */
  notJudged?: boolean;
  /** The judge's cost, USD, exact. */
  judgeCost: string;
  judgeCalls: number;
  /** Judge calls that failed or timed out: what they used is unknown. */
  judgeFailedCalls: number;
}

export interface GradeExtras {
  failedAttempts?: number;
  /** The judge's result; absent when it did not run. */
  judge?: JudgeResult;
  judgePrice?: ModelPrice;
  notJudged?: boolean;
}

export interface CaseResult {
  caseId: string;
  category: string;
  runs: number;
  passedRuns: number;
  /** Every repeat passed. */
  passed: boolean;
  /** Some repeats passed and some failed. */
  flaky: boolean;
}

export interface CategoryResult {
  passed: number;
  total: number;
  rateBps: number | null;
}

export interface ModelSummary {
  id: string;
  label: string;
  model: string;
  reference: boolean;
  cases: number;
  passedCases: number;
  passRateBps: number | null;
  categories: Record<string, CategoryResult>;
  runs: number;
  passedRuns: number;
  flakyCases: string[];
  /** Turns that failed for a reason other than the provider: quality failures. */
  turnErrors: number;
  /** Runs that ended on a provider error after retries: out of the pass rate. */
  providerErrors: number;
  /** Of those, a 4xx that a rerun will not change: fix the route or model. */
  configErrors: number;
  /** Runs the judge could not judge after retries: out of the pass rate. */
  judgeErrors: number;
  /** Runs whose rubric was not judged (--no-judge): their pass is deterministic only. */
  notJudgedRuns: number;
  /** Failed model call attempts whose usage is unknown: the cost is a lower bound when > 0. */
  failedAttempts: number;
  /** The judge's cost over this model's runs, USD, exact; not in the cost per pass. */
  judgeCost: string;
  judgeCalls: number;
  /** Judge calls that failed or timed out: the judge cost is a lower bound when > 0. */
  judgeFailedCalls: number;
  /** USD over every run, exact. */
  totalCost: string;
  /** Total cost over passing runs, USD; null when nothing passed. */
  costPerPass: string | null;
  /** Over runs that produced an answer, a timed-out run at its wall time or the timeout, whichever is longer; null when none. */
  latencyMs: { p50: number | null; p95: number | null; max: number | null };
  modelCalls: number;
  tokens: Usage;
}

export interface ModelInfo {
  id: string;
  label: string;
  model: string;
  reference: boolean;
  price: ModelPrice;
}

/** Integer basis points of `part / whole`, rounded down; null for an empty whole. */
export function rateBps(part: number, whole: number): number | null {
  if (whole <= 0) {
    return null;
  }
  return Math.floor((part * FULL_RATE_BPS) / whole);
}

export function formatBps(bps: number | null): string {
  if (bps === null) {
    return 'n/a';
  }
  const whole = Math.floor(bps / 100);
  const fraction = String(bps % 100).padStart(2, '0');
  return `${whole}.${fraction}%`;
}

/** Nearest-rank percentile of `values`; null when there are none. */
export function percentile(values: readonly number[], percent: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percent / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

export function gradeRun(
  outcome: CaseOutcome,
  deterministic: string[],
  price: ModelPrice,
  extras: GradeExtras = {},
): GradedRun {
  const { judge } = extras;
  const criteriaFailures = (judge?.criteria ?? [])
    .filter((criterion) => !criterion.pass)
    .map(
      (criterion) =>
        `rubric ${criterion.id} failed: ${criterion.question} Judge: ${criterion.reason}`,
    );
  const judgeFailures = judge?.error === undefined ? [] : [judge.error];
  const failures = [...deterministic, ...criteriaFailures, ...judgeFailures];
  return {
    ...outcome,
    failures,
    passed: failures.length === 0,
    cost: costOf(outcome.usage, price).toFixed(),
    failedAttempts: extras.failedAttempts ?? 0,
    ...(judge?.criteria ? { criteria: judge.criteria } : {}),
    ...(judge?.error === undefined ? {} : { judgeError: true }),
    ...(extras.notJudged ? { notJudged: true } : {}),
    judgeCost: judge && extras.judgePrice ? costOf(judge.usage, extras.judgePrice).toFixed() : '0',
    judgeCalls: judge?.calls ?? 0,
    judgeFailedCalls: judge?.failedCalls ?? 0,
  };
}

/** Total cost divided by passing runs; null (shown as n/a) when no run passed. */
export function costPerPass(totalCost: Decimal, passedRuns: number): Decimal | null {
  if (passedRuns <= 0) {
    return null;
  }
  return totalCost.div(passedRuns);
}

/** A run that ended on a provider or judge error says nothing about the model's answers. */
export function reachedVerdict(run: GradedRun): boolean {
  return run.providerError !== true && run.judgeError !== true;
}

/**
 * Per case over the runs that reached a verdict: a run that ended on a
 * provider error (after retries) says nothing about the model's answers, so
 * it is left out; a case whose every run did is left out of the pass rate.
 */
export function caseResults(runs: readonly GradedRun[]): CaseResult[] {
  const byCase = new Map<string, CaseResult>();
  for (const run of runs.filter(reachedVerdict)) {
    const current = byCase.get(run.caseId) ?? {
      caseId: run.caseId,
      category: run.category,
      runs: 0,
      passedRuns: 0,
      passed: false,
      flaky: false,
    };
    current.runs += 1;
    current.passedRuns += run.passed ? 1 : 0;
    current.passed = current.passedRuns === current.runs;
    current.flaky = current.passedRuns > 0 && current.passedRuns < current.runs;
    byCase.set(run.caseId, current);
  }
  return [...byCase.values()];
}

/**
 * A timed-out run counts at its wall time or the timeout, whichever is longer: leaving it out would
 * flatter exactly the models that hang.
 */
function latencySamples(runs: readonly GradedRun[], timeoutMs?: number): number[] {
  return runs.flatMap((run) => {
    if (run.error === undefined) {
      return [run.latencyMs];
    }
    if (run.timedOut === true) {
      return [Math.max(run.latencyMs, timeoutMs ?? 0)];
    }
    return [];
  });
}

export function summarize(
  info: ModelInfo,
  runs: readonly GradedRun[],
  timeoutMs?: number,
): ModelSummary {
  const cases = caseResults(runs);
  const categories: Record<string, CategoryResult> = {};
  for (const result of cases) {
    const category = categories[result.category] ?? { passed: 0, total: 0, rateBps: null };
    category.total += 1;
    category.passed += result.passed ? 1 : 0;
    category.rateBps = rateBps(category.passed, category.total);
    categories[result.category] = category;
  }
  const totalCost = runs.reduce((sum, run) => sum.plus(run.cost), new Decimal(0));
  const passedRuns = runs.filter((run) => run.passed).length;
  const perPass = costPerPass(totalCost, passedRuns);
  const latencies = latencySamples(runs, timeoutMs);
  const passedCases = cases.filter((result) => result.passed).length;
  return {
    id: info.id,
    label: info.label,
    model: info.model,
    reference: info.reference,
    cases: cases.length,
    passedCases,
    passRateBps: rateBps(passedCases, cases.length),
    categories,
    runs: runs.length,
    passedRuns,
    flakyCases: cases.filter((result) => result.flaky).map((result) => result.caseId),
    turnErrors: runs.filter((run) => run.error !== undefined && run.providerError !== true).length,
    providerErrors: runs.filter((run) => run.providerError === true).length,
    configErrors: runs.filter((run) => run.configError === true).length,
    judgeErrors: runs.filter((run) => run.judgeError === true).length,
    notJudgedRuns: runs.filter((run) => run.notJudged === true).length,
    failedAttempts: runs.reduce((sum, run) => sum + run.failedAttempts, 0),
    judgeCost: runs.reduce((sum, run) => sum.plus(run.judgeCost), new Decimal(0)).toFixed(),
    judgeFailedCalls: runs.reduce((sum, run) => sum + run.judgeFailedCalls, 0),
    judgeCalls: runs.reduce((sum, run) => sum + run.judgeCalls, 0),
    totalCost: totalCost.toFixed(),
    costPerPass: perPass === null ? null : perPass.toFixed(),
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length > 0 ? Math.max(...latencies) : null,
    },
    modelCalls: runs.reduce((sum, run) => sum + run.modelCalls, 0),
    tokens: runs.reduce((sum, run) => addUsage(sum, run.usage), ZERO_USAGE),
  };
}

/** Lower p50 first; a model with no latency sorts last; two without tie. */
function compareLatency(left: number | null, right: number | null): number {
  if (left === null || right === null) {
    return (left === null ? 1 : 0) - (right === null ? 1 : 0);
  }
  return left - right;
}

/**
 * The tier default the numbers suggest: among models that are not reference
 * only, had no provider or judge error, were judged, and pass at least `barBps` of the cases, the
 * cheapest per passing conversation, then the lower p50 latency. Undefined
 * when none qualifies.
 */
export function pickDefault(
  summaries: readonly ModelSummary[],
  barBps: number,
): ModelSummary | undefined {
  const candidates = summaries.filter(
    (summary) =>
      !summary.reference &&
      summary.providerErrors === 0 &&
      summary.judgeErrors === 0 &&
      summary.notJudgedRuns === 0 &&
      summary.passRateBps !== null &&
      summary.passRateBps >= barBps &&
      summary.costPerPass !== null,
  );
  return [...candidates].sort((left, right) => {
    const byCost = new Decimal(left.costPerPass ?? '0').comparedTo(right.costPerPass ?? '0');
    return byCost !== 0 ? byCost : compareLatency(left.latencyMs.p50, right.latencyMs.p50);
  })[0];
}

/** USD for display, rounded to 6 places. */
export function formatUsd(amount: string | null): string {
  if (amount === null) {
    return 'n/a';
  }
  return `$${new Decimal(amount).toFixed(6)}`;
}

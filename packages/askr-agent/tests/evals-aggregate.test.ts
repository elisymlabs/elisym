import Decimal from 'decimal.js-light';
import { describe, expect, it } from 'vitest';
import {
  type GradedRun,
  type ModelSummary,
  caseResults,
  costPerPass,
  formatBps,
  formatUsd,
  gradeRun,
  percentile,
  pickDefault,
  rateBps,
  summarize,
} from '../evals/aggregate';
import { PRICE, outcomeOf } from './evals-helpers';

const INFO = { id: 'm', label: 'M', model: 'm-1', reference: false, price: PRICE };

function run(
  caseId: string,
  category: string,
  passed: boolean,
  extra: Partial<GradedRun> = {},
): GradedRun {
  return gradeRun(
    outcomeOf({
      caseId,
      category,
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 2_000,
        cacheWriteTokens: 100,
        outputTokens: 300,
      },
      ...extra,
    }),
    passed ? [] : ['expected one of x, presented nothing'],
    PRICE,
  );
}

describe('aggregation', () => {
  it('costs a run exactly: (1000*3 + 2000*0.3 + 100*3.75 + 300*15) / 1e6', () => {
    // 3000 + 600 + 375 + 4500 = 8475 micro-USD.
    expect(run('a', 'search', true).cost).toBe('0.008475');
  });

  it('cost per passing conversation is total cost over passing runs, exactly', () => {
    const summary = summarize(INFO, [
      run('a', 'search', true),
      run('b', 'search', true),
      run('c', 'budget', false),
    ]);
    expect(summary.totalCost).toBe('0.025425');
    expect(summary.costPerPass).toBe('0.0127125');
    expect(formatUsd(summary.costPerPass)).toBe('$0.012713');
  });

  it('a repeating quotient stays a finite decimal', () => {
    expect(costPerPass(new Decimal('0.01'), 3)?.toFixed()).toBe('0.0033333333333333333333');
  });

  it('zero passes: cost per pass is n/a, never Infinity or NaN', () => {
    const summary = summarize(INFO, [run('a', 'search', false), run('b', 'search', false)]);
    expect(summary.costPerPass).toBeNull();
    expect(formatUsd(summary.costPerPass)).toBe('n/a');
    expect(summary.passRateBps).toBe(0);
    expect(costPerPass(new Decimal(0), 0)).toBeNull();
  });

  it('p50 and p95 by nearest rank, over answered runs only', () => {
    const values = Array.from({ length: 20 }, (_unused, index) => (index + 1) * 100);
    expect(percentile(values, 50)).toBe(1_000);
    expect(percentile(values, 95)).toBe(1_900);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([300, 100, 200], 50)).toBe(200);
    const summary = summarize(INFO, [
      run('a', 'search', true, { latencyMs: 300 }),
      run('b', 'search', true, { latencyMs: 100 }),
      run('c', 'search', false, { latencyMs: 60_000, error: 'timed out' }),
    ]);
    expect(summary.latencyMs).toEqual({ p50: 100, p95: 300, max: 300 });
    expect(summary.turnErrors).toBe(1);
  });

  it('a case passes only when every repeat passes; mixed repeats are flaky', () => {
    const runs = [
      run('a', 'search', true, { repeat: 1 }),
      run('a', 'search', true, { repeat: 2 }),
      run('b', 'search', true, { repeat: 1 }),
      run('b', 'search', false, { repeat: 2 }),
      run('c', 'budget', false, { repeat: 1 }),
      run('c', 'budget', false, { repeat: 2 }),
    ];
    expect(caseResults(runs)).toEqual([
      { caseId: 'a', category: 'search', runs: 2, passedRuns: 2, passed: true, flaky: false },
      { caseId: 'b', category: 'search', runs: 2, passedRuns: 1, passed: false, flaky: true },
      { caseId: 'c', category: 'budget', runs: 2, passedRuns: 0, passed: false, flaky: false },
    ]);
    const summary = summarize(INFO, runs);
    expect(summary.cases).toBe(3);
    expect(summary.passedCases).toBe(1);
    expect(summary.runs).toBe(6);
    expect(summary.passedRuns).toBe(3);
    expect(summary.flakyCases).toEqual(['b']);
    // 6 runs at 0.008475 over 3 passing runs.
    expect(summary.costPerPass).toBe('0.01695');
  });

  it('per-category pass rates in basis points', () => {
    const summary = summarize(INFO, [
      run('a', 'search', true),
      run('b', 'search', true),
      run('c', 'search', false),
      run('d', 'budget', true),
    ]);
    expect(summary.categories).toEqual({
      search: { passed: 2, total: 3, rateBps: 6_666 },
      budget: { passed: 1, total: 1, rateBps: 10_000 },
    });
    expect(summary.passRateBps).toBe(7_500);
    expect(formatBps(6_666)).toBe('66.66%');
    expect(formatBps(10_000)).toBe('100.00%');
    expect(formatBps(null)).toBe('n/a');
    expect(rateBps(1, 0)).toBeNull();
  });

  it('sums calls and tokens', () => {
    const summary = summarize(INFO, [
      run('a', 'search', true, { modelCalls: 3 }),
      run('b', 'search', false, { modelCalls: 2 }),
    ]);
    expect(summary.modelCalls).toBe(5);
    expect(summary.tokens).toEqual({
      inputTokens: 2_000,
      cachedInputTokens: 4_000,
      cacheWriteTokens: 200,
      outputTokens: 600,
    });
  });
});

describe('pickDefault', () => {
  function summary(
    id: string,
    passRateBps: number,
    perPass: string | null,
    p50: number,
    reference = false,
  ): ModelSummary {
    return {
      ...summarize({ ...INFO, id, reference }, []),
      passRateBps,
      costPerPass: perPass,
      latencyMs: { p50, p95: p50, max: p50 },
    };
  }

  it('picks the cheapest per passing conversation above the bar, latency breaking ties', () => {
    const picked = pickDefault(
      [
        summary('cheap-but-bad', 8_000, '0.001', 500),
        summary('reference', 9_900, '0.0001', 100, true),
        summary('pricey', 9_800, '0.01', 300),
        summary('slow', 9_000, '0.002', 2_000),
        summary('fast', 9_500, '0.002', 900),
      ],
      9_000,
    );
    expect(picked?.id).toBe('fast');
  });

  it('none when nothing that is not reference clears the bar', () => {
    expect(
      pickDefault([summary('a', 8_999, '0.001', 1), summary('r', 10_000, '0.001', 1, true)], 9_000),
    ).toBeUndefined();
  });
});

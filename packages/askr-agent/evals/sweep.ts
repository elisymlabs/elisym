/**
 * The model sweep (spec 8): every selected case against every selected model,
 * with repeats, bounded concurrency and a per-call timeout; then per-model
 * metrics, a JSON results file and a markdown report.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoreCatalog } from '../src/catalog/store-catalog';
import {
  DEFAULT_BAR_BPS,
  type GradedRun,
  formatBps,
  gradeRun,
  pickDefault,
  summarize,
} from './aggregate';
import { type EvalCase, lintCases, parseCases, parseStore } from './cases';
import { grade } from './grade';
import {
  DEFAULT_RETRY,
  type RetryOptions,
  buildCatalog,
  runCase,
  withCallTimeout,
  withRetries,
} from './harness';
import { type JudgeResult, judgeCase, preflightJudge } from './judge';
import {
  type ProviderFactory,
  type ResolveJudgeOptions,
  type ResolvedJudge,
  type ResolvedModel,
  resolveJudge,
  resolveModels,
} from './models';
import { type ModelResult, type SweepResult, jsonResults, markdownReport } from './report';

export const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 32;
export const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_REPEAT = 20;
const MAX_RETRIES = 10;
export const RUNS_FILE = 'runs.jsonl';
const MS_PER_SECOND = 1_000;
const FAILURE_PREVIEW_CHARS = 160;

export interface SweepArgs {
  models: string;
  only?: string[];
  cases?: string[];
  repeat: number;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  barBps: number;
  out?: string;
  casesFile: string;
  storeFile: string;
  /** Deterministic checks only: no judge, no quality verdict, no suggested default. */
  noJudge: boolean;
}

const NO_JUDGE_FLAG = '--no-judge';
const FLAGS = [
  '--models',
  '--only',
  '--cases',
  '--repeat',
  '--concurrency',
  '--timeout',
  '--retries',
  '--bar',
  '--out',
  '--case-file',
  '--store-file',
] as const;
type Flag = (typeof FLAGS)[number];

function isFlag(value: string): value is Flag {
  return FLAGS.some((flag) => flag === value);
}

function integerIn(flag: string, value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${flag} takes a whole number from ${min} to ${max}, got "${value}".`);
  }
  return Number(value);
}

function list(flag: string, value: string): string[] {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error(`${flag} needs at least one name, got "${value}".`);
  }
  return parts;
}

export const USAGE = `Usage: bun packages/askr-agent/evals/run.ts --models <file> [options]
  --models <file>        model matrix (start from evals/models.example.json, fill the prices)
  --only <id,...>        run only these model entries
  --cases <filter,...>   case ids or categories; a trailing * matches a prefix
  --repeat <n>           run each case n times; a case passes only if every run passes (default 1)
  --concurrency <n>      turns in flight at once (default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY})
  --timeout <seconds>    per model call (default ${DEFAULT_TIMEOUT_SECONDS})
  --retries <n>          retries of a rate-limited, failed or timed-out call (default ${DEFAULT_RETRY.retries})
  --bar <percent>        pass-rate bar for the suggested default (default ${DEFAULT_BAR_BPS / 100})
  --out <dir>            write ${RUNS_FILE} as runs land, then results.json and report.md
  --no-judge             deterministic checks only: a cheap dry check, not a quality verdict
  --case-file <file>     default evals/cases.json
  --store-file <file>    default evals/store.json`;

export function parseArgs(argv: readonly string[]): SweepArgs {
  const values = new Map<Flag, string>();
  let noJudge = false;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? '';
    const value = argv[index + 1];
    if (flag === NO_JUDGE_FLAG) {
      noJudge = true;
      index -= 1;
      continue;
    }
    if (!isFlag(flag)) {
      throw new Error(`Unknown option "${flag}".\n${USAGE}`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} needs a value.\n${USAGE}`);
    }
    values.set(flag, value);
  }
  const models = values.get('--models');
  if (models === undefined) {
    throw new Error(`--models is required.\n${USAGE}`);
  }
  const only = values.get('--only');
  const cases = values.get('--cases');
  const out = values.get('--out');
  return {
    models,
    ...(only !== undefined ? { only: list('--only', only) } : {}),
    ...(cases !== undefined ? { cases: list('--cases', cases) } : {}),
    repeat: integerIn('--repeat', values.get('--repeat') ?? '1', 1, MAX_REPEAT),
    concurrency: integerIn(
      '--concurrency',
      values.get('--concurrency') ?? String(DEFAULT_CONCURRENCY),
      1,
      MAX_CONCURRENCY,
    ),
    timeoutMs:
      integerIn('--timeout', values.get('--timeout') ?? String(DEFAULT_TIMEOUT_SECONDS), 1, 3_600) *
      MS_PER_SECOND,
    retries: integerIn(
      '--retries',
      values.get('--retries') ?? String(DEFAULT_RETRY.retries),
      0,
      MAX_RETRIES,
    ),
    barBps: integerIn('--bar', values.get('--bar') ?? String(DEFAULT_BAR_BPS / 100), 0, 100) * 100,
    ...(out !== undefined ? { out } : {}),
    casesFile: values.get('--case-file') ?? join(EVALS_DIR, 'cases.json'),
    storeFile: values.get('--store-file') ?? join(EVALS_DIR, 'store.json'),
    noJudge,
  };
}

/** Cases whose id or category equals a filter, or starts with a filter ending in `*`. */
export function selectCases(cases: readonly EvalCase[], filters?: readonly string[]): EvalCase[] {
  if (!filters || filters.length === 0) {
    return [...cases];
  }
  const matches = (value: string, filter: string) =>
    filter.endsWith('*') ? value.startsWith(filter.slice(0, -1)) : value === filter;
  const selected = cases.filter((testCase) =>
    filters.some((filter) => matches(testCase.id, filter) || matches(testCase.category, filter)),
  );
  if (selected.length === 0) {
    throw new Error(`--cases ${filters.join(',')} matches no case.`);
  }
  return selected;
}

/**
 * Run `tasks` with at most `limit` in flight; results keep the task order. After
 * a task rejects no new task starts (each one is a paid call); the ones in flight
 * finish, then the first rejection is thrown.
 */
export async function runBounded<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (next < tasks.length && failure === undefined) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task) {
        try {
          results[index] = await task();
        } catch (error) {
          failure ??= { error };
        }
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker);
  await Promise.all(workers);
  if (failure !== undefined) {
    throw failure.error;
  }
  return results;
}

export interface SweepOptions {
  models: readonly ResolvedModel[];
  cases: readonly EvalCase[];
  catalog: StoreCatalog;
  now: number;
  repeat: number;
  concurrency: number;
  timeoutMs: number;
  /** Retries and backoff of a failed call; the defaults when absent. */
  retry?: RetryOptions;
  barBps: number;
  onProgress?: (line: string) => void;
  /** Called with each graded run as it lands, before the sweep ends. */
  onRun?: (modelId: string, run: GradedRun) => Promise<void>;
  clock?: () => number;
  startedAt?: string;
  /** The judge for rubrics; absent means deterministic checks only (--no-judge). */
  judge?: ResolvedJudge;
}

function progressLine(done: number, total: number, model: ResolvedModel, run: GradedRun): string {
  const head = `[${done}/${total}] ${run.passed ? 'PASS' : 'FAIL'} ${model.id} ${run.caseId} #${run.repeat} [${run.category}] ${run.latencyMs} ms, ${run.modelCalls} call(s)`;
  if (run.passed) {
    return head;
  }
  const reason = run.failures.join('; ');
  return `${head}: ${reason.length > FAILURE_PREVIEW_CHARS ? `${reason.slice(0, FAILURE_PREVIEW_CHARS)}...` : reason}`;
}

export async function runSweep(options: SweepOptions): Promise<SweepResult> {
  const retry = options.retry ?? DEFAULT_RETRY;
  // Case-major order spreads each provider's calls over the whole sweep.
  const jobs = options.cases.flatMap((testCase) =>
    Array.from({ length: options.repeat }, (_unused, repeatIndex) =>
      options.models.map((model) => ({ model, testCase, repeat: repeatIndex + 1 })),
    ).flat(),
  );
  const { judge } = options;
  if (judge !== undefined) {
    // One judge call before any paid model run: a refused judge stops the sweep here.
    const preflight = await preflightJudge(judge.client, options.catalog, retry, options.timeoutMs);
    if (preflight.criteria === undefined) {
      throw new Error(
        `The judge preflight failed, so no model was run: ${preflight.error ?? 'no verdict'}. Fix the judge entry (model, key, effort) and run again.`,
      );
    }
  }
  let done = 0;
  const graded = await runBounded(
    jobs.map((job) => async () => {
      let failedAttempts = 0;
      // Per run, so the failed attempts (usage unknown) are counted against this run.
      const provider = withRetries(withCallTimeout(job.model.provider, options.timeoutMs), {
        ...retry,
        onFailedAttempt: () => {
          failedAttempts += 1;
        },
      });
      const outcome = await runCase({
        catalog: options.catalog,
        provider,
        testCase: job.testCase,
        now: options.now,
        repeat: job.repeat,
        ...(job.model.maxTokens === undefined ? {} : { maxTokens: job.model.maxTokens }),
        ...(options.clock ? { clock: options.clock } : {}),
      });
      const deterministic = grade(job.testCase, outcome);
      const hasRubric = (job.testCase.rubric ?? []).length > 0;
      // The judge reads only an answer the deterministic layer let through: a fail is a fail.
      let verdict: JudgeResult | undefined;
      if (
        judge !== undefined &&
        hasRubric &&
        outcome.error === undefined &&
        deterministic.length === 0
      ) {
        verdict = await judgeCase({
          client: judge.client,
          testCase: job.testCase,
          outcome,
          catalog: options.catalog,
          retry,
          timeoutMs: options.timeoutMs,
        });
        if (verdict.configError) {
          // The judge request is refused as configured: every later run would be paid for and lost.
          throw new Error(
            `The judge request is refused (${verdict.error ?? 'no verdict'}); the sweep stopped. Fix the judge entry and run again.`,
          );
        }
      }
      const run = gradeRun(outcome, deterministic, job.model.price, {
        failedAttempts,
        ...(verdict ? { judge: verdict } : {}),
        ...(judge ? { judgePrice: judge.price } : {}),
        notJudged: hasRubric && judge === undefined,
      });
      done += 1;
      await options.onRun?.(job.model.id, run);
      options.onProgress?.(progressLine(done, jobs.length, job.model, run));
      return { modelId: job.model.id, run };
    }),
    options.concurrency,
  );
  const models: ModelResult[] = options.models.map((model) => {
    const runs = graded.filter((entry) => entry.modelId === model.id).map((entry) => entry.run);
    return { summary: summarize(model, runs, options.timeoutMs), runs };
  });
  // Without the judge the numbers are no quality verdict: never a suggestion.
  const recommended =
    judge === undefined
      ? undefined
      : pickDefault(
          models.map((model) => model.summary),
          options.barBps,
        );
  return {
    startedAt: options.startedAt ?? new Date().toISOString(),
    settings: {
      cases: options.cases.length,
      repeat: options.repeat,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      retries: retry.retries,
      barBps: options.barBps,
      judge: judge === undefined ? null : judge.model,
      storeItems: options.catalog.items.size,
    },
    models,
    ...(recommended ? { recommended: recommended.id } : {}),
  };
}

export interface MainDeps {
  env: Readonly<Record<string, string | undefined>>;
  log: (line: string) => void;
  createProvider?: ProviderFactory;
  createJudge?: ResolveJudgeOptions['createJudge'];
  now?: number;
  clock?: () => number;
  /** Tests only: backoff timing (the retry count comes from --retries). */
  retryTiming?: Omit<RetryOptions, 'retries'>;
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The CLI: returns the process exit code (0 when the sweep ran, whatever the pass rates). */
export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  let args: SweepArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    deps.log(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    const store = parseStore(await readJson(args.storeFile));
    const allCases = parseCases(await readJson(args.casesFile));
    const problems = lintCases(allCases, store);
    if (problems.length > 0) {
      throw new Error(`The case file has problems:\n  ${problems.join('\n  ')}`);
    }
    const cases = selectCases(allCases, args.cases);
    const modelsFile = await readJson(args.models);
    const models = resolveModels(modelsFile, {
      env: deps.env,
      ...(args.only ? { only: args.only } : {}),
      ...(deps.createProvider ? { createProvider: deps.createProvider } : {}),
    });
    const judge = args.noJudge
      ? undefined
      : resolveJudge(modelsFile, {
          env: deps.env,
          ...(deps.createJudge ? { createJudge: deps.createJudge } : {}),
        });
    const now = deps.now ?? Math.floor(Date.now() / MS_PER_SECOND);
    const { catalog, rejected } = buildCatalog(store, now);
    if (rejected.length > 0) {
      throw new Error(`Store products did not build: ${rejected.join(', ')}.`);
    }
    let appendRun: ((modelId: string, run: GradedRun) => Promise<void>) | undefined;
    if (args.out !== undefined) {
      const out = args.out;
      await mkdir(out, { recursive: true });
      // One line per graded run as it lands: an interrupted sweep keeps what it paid for.
      await writeFile(join(out, RUNS_FILE), '');
      appendRun = (modelId, run) =>
        appendFile(join(out, RUNS_FILE), `${JSON.stringify({ model: modelId, ...run })}\n`);
    }
    deps.log(
      `Sweeping ${cases.length} case(s) x ${args.repeat} over ${models.map((model) => model.id).join(', ')}, ${judge === undefined ? 'deterministic checks only (--no-judge): not a quality verdict' : `judged by ${judge.model}`}`,
    );
    const result = await runSweep({
      models,
      cases,
      catalog,
      now,
      repeat: args.repeat,
      concurrency: args.concurrency,
      timeoutMs: args.timeoutMs,
      retry: {
        ...(deps.retryTiming ?? DEFAULT_RETRY),
        retries: args.retries,
      },
      barBps: args.barBps,
      onProgress: deps.log,
      ...(appendRun ? { onRun: appendRun } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(judge ? { judge } : {}),
    });
    deps.log('');
    for (const { summary } of result.models) {
      deps.log(
        `${summary.id}: ${summary.passedCases}/${summary.cases} (${formatBps(summary.passRateBps)}), ${summary.providerErrors} provider error(s), ${summary.judgeErrors} judge error(s), ${summary.maxTokensStops} stopped at max_tokens, ${summary.refusals} refused, cost per passing conversation ${summary.costPerPass ?? 'n/a'} USD, p50 ${summary.latencyMs.p50 ?? 'n/a'} ms`,
      );
    }
    if (judge === undefined) {
      deps.log('Deterministic checks only: no quality verdict and no suggested default.');
    } else {
      deps.log(
        result.recommended
          ? `Suggested default at a ${formatBps(args.barBps)} bar: ${result.recommended}`
          : `No model qualifies at the ${formatBps(args.barBps)} bar.`,
      );
    }
    if (args.out !== undefined) {
      await writeFile(join(args.out, 'results.json'), jsonResults(result));
      await writeFile(join(args.out, 'report.md'), markdownReport(result));
      deps.log(
        `Wrote ${join(args.out, RUNS_FILE)}, ${join(args.out, 'results.json')} and ${join(args.out, 'report.md')}`,
      );
    }
    return 0;
  } catch (error) {
    deps.log(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

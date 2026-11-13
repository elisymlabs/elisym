/**
 * The model sweep (spec 8): every selected case against every selected model,
 * with repeats, bounded concurrency and a per-call timeout; then per-model
 * metrics, a JSON results file and a markdown report.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { buildCatalog, runCase, withCallTimeout } from './harness';
import { type ProviderFactory, type ResolvedModel, resolveModels } from './models';
import { type ModelResult, type SweepResult, jsonResults, markdownReport } from './report';

export const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 32;
export const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_REPEAT = 20;
const MS_PER_SECOND = 1_000;
const FAILURE_PREVIEW_CHARS = 160;

export interface SweepArgs {
  models: string;
  only?: string[];
  cases?: string[];
  repeat: number;
  concurrency: number;
  timeoutMs: number;
  barBps: number;
  out?: string;
  casesFile: string;
  storeFile: string;
}

const FLAGS = [
  '--models',
  '--only',
  '--cases',
  '--repeat',
  '--concurrency',
  '--timeout',
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

function list(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export const USAGE = `Usage: bun packages/askr-agent/evals/run.ts --models <file> [options]
  --models <file>        model matrix (start from evals/models.example.json, fill the prices)
  --only <id,...>        run only these model entries
  --cases <filter,...>   case ids or categories; a trailing * matches a prefix
  --repeat <n>           run each case n times; a case passes only if every run passes (default 1)
  --concurrency <n>      turns in flight at once (default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY})
  --timeout <seconds>    per model call (default ${DEFAULT_TIMEOUT_SECONDS})
  --bar <percent>        pass-rate bar for the suggested default (default ${DEFAULT_BAR_BPS / 100})
  --out <dir>            write results.json and report.md there
  --case-file <file>     default evals/cases.json
  --store-file <file>    default evals/store.json`;

export function parseArgs(argv: readonly string[]): SweepArgs {
  const values = new Map<Flag, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? '';
    const value = argv[index + 1];
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
    ...(only !== undefined ? { only: list(only) } : {}),
    ...(cases !== undefined ? { cases: list(cases) } : {}),
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
    barBps: integerIn('--bar', values.get('--bar') ?? String(DEFAULT_BAR_BPS / 100), 0, 100) * 100,
    ...(out !== undefined ? { out } : {}),
    casesFile: values.get('--case-file') ?? join(EVALS_DIR, 'cases.json'),
    storeFile: values.get('--store-file') ?? join(EVALS_DIR, 'store.json'),
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

/** Run `tasks` with at most `limit` in flight; results keep the task order. */
export async function runBounded<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task) {
        results[index] = await task();
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker);
  await Promise.all(workers);
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
  barBps: number;
  onProgress?: (line: string) => void;
  clock?: () => number;
  startedAt?: string;
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
  const timed = options.models.map((model) => ({
    model,
    provider: withCallTimeout(model.provider, options.timeoutMs),
  }));
  // Case-major order spreads each provider's calls over the whole sweep.
  const jobs = options.cases.flatMap((testCase) =>
    Array.from({ length: options.repeat }, (_unused, repeatIndex) =>
      timed.map((entry) => ({ ...entry, testCase, repeat: repeatIndex + 1 })),
    ).flat(),
  );
  let done = 0;
  const graded = await runBounded(
    jobs.map((job) => async () => {
      const outcome = await runCase({
        catalog: options.catalog,
        provider: job.provider,
        testCase: job.testCase,
        now: options.now,
        repeat: job.repeat,
        ...(options.clock ? { clock: options.clock } : {}),
      });
      const run = gradeRun(outcome, grade(job.testCase, outcome), job.model.price);
      done += 1;
      options.onProgress?.(progressLine(done, jobs.length, job.model, run));
      return { modelId: job.model.id, run };
    }),
    options.concurrency,
  );
  const models: ModelResult[] = options.models.map((model) => {
    const runs = graded.filter((entry) => entry.modelId === model.id).map((entry) => entry.run);
    return { summary: summarize(model, runs), runs };
  });
  const recommended = pickDefault(
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
      barBps: options.barBps,
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
  now?: number;
  clock?: () => number;
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
    const models = resolveModels(await readJson(args.models), {
      env: deps.env,
      ...(args.only ? { only: args.only } : {}),
      ...(deps.createProvider ? { createProvider: deps.createProvider } : {}),
    });
    const now = deps.now ?? Math.floor(Date.now() / MS_PER_SECOND);
    const { catalog, rejected } = buildCatalog(store, now);
    if (rejected.length > 0) {
      throw new Error(`Store products did not build: ${rejected.join(', ')}.`);
    }
    deps.log(
      `Sweeping ${cases.length} case(s) x ${args.repeat} over ${models.map((model) => model.id).join(', ')}`,
    );
    const result = await runSweep({
      models,
      cases,
      catalog,
      now,
      repeat: args.repeat,
      concurrency: args.concurrency,
      timeoutMs: args.timeoutMs,
      barBps: args.barBps,
      onProgress: deps.log,
      ...(deps.clock ? { clock: deps.clock } : {}),
    });
    deps.log('');
    for (const { summary } of result.models) {
      deps.log(
        `${summary.id}: ${summary.passedCases}/${summary.cases} (${formatBps(summary.passRateBps)}), cost per passing conversation ${summary.costPerPass ?? 'n/a'} USD, p50 ${summary.latencyMs.p50 ?? 'n/a'} ms`,
      );
    }
    deps.log(
      result.recommended
        ? `Suggested default at a ${formatBps(args.barBps)} bar: ${result.recommended}`
        : `No model reached the ${formatBps(args.barBps)} bar.`,
    );
    if (args.out !== undefined) {
      await mkdir(args.out, { recursive: true });
      await writeFile(join(args.out, 'results.json'), jsonResults(result));
      await writeFile(join(args.out, 'report.md'), markdownReport(result));
      deps.log(`Wrote ${join(args.out, 'results.json')} and ${join(args.out, 'report.md')}`);
    }
    return 0;
  } catch (error) {
    deps.log(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

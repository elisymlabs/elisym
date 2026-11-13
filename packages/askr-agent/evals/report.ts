/** The sweep's outputs: a JSON results file and a markdown report. */
import { type GradedRun, type ModelSummary, formatBps, formatUsd } from './aggregate';

export interface SweepSettings {
  cases: number;
  repeat: number;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  barBps: number;
  storeItems: number;
  /** The judge model; null with --no-judge (deterministic checks only). */
  judge: string | null;
}

export interface ModelResult {
  summary: ModelSummary;
  runs: GradedRun[];
}

export interface SweepResult {
  startedAt: string;
  settings: SweepSettings;
  models: ModelResult[];
  /** The model id the numbers suggest as the default; undefined when none clears the bar. */
  recommended?: string;
}

const ANSWER_EXCERPT_CHARS = 300;

/** A table cell: one line, no pipe that would split the row. */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function excerpt(text: string): string {
  const flat = cell(text);
  return flat.length > ANSWER_EXCERPT_CHARS ? `${flat.slice(0, ANSWER_EXCERPT_CHARS)}...` : flat;
}

function ms(value: number | null): string {
  return value === null ? 'n/a' : `${value} ms`;
}

function overviewRow(summary: ModelSummary): string {
  const name = summary.reference ? `${summary.label} (reference only)` : summary.label;
  const columns = [
    name,
    `${summary.passedCases}/${summary.cases}`,
    formatBps(summary.passRateBps),
    formatUsd(summary.costPerPass),
    formatUsd(summary.totalCost),
    ms(summary.latencyMs.p50),
    ms(summary.latencyMs.p95),
    String(summary.modelCalls),
    String(summary.tokens.inputTokens),
    String(summary.tokens.cachedInputTokens),
    String(summary.tokens.cacheWriteTokens),
    String(summary.tokens.outputTokens),
    String(summary.turnErrors),
    String(summary.providerErrors),
    String(summary.judgeErrors),
    String(summary.flakyCases.length),
    formatUsd(summary.judgeCost),
  ];
  return `| ${columns.map(cell).join(' | ')} |`;
}

/** Why a model is not suggested, and whether its cost is a lower bound. */
function modelNotes(summary: ModelSummary): string[] {
  const notes: string[] = [];
  const transient = summary.providerErrors - summary.configErrors;
  if (summary.configErrors > 0) {
    notes.push(
      `${summary.label}: ${summary.configErrors} run(s) failed on a 4xx from the provider. This is deterministic: fix the route or model, a rerun will not help.`,
    );
  }
  if (transient > 0) {
    notes.push(
      `${summary.label}: ${transient} run(s) ended on a provider error after retries, so its pass rate covers fewer runs than the others. Rerun it before choosing a default.`,
    );
  }
  if (summary.judgeErrors > 0) {
    notes.push(
      `${summary.label}: the judge gave no valid verdict on ${summary.judgeErrors} run(s); they are out of the pass rate. Rerun before choosing a default.`,
    );
  }
  if (summary.failedAttempts > 0) {
    notes.push(
      `${summary.label}: the cost is a lower bound. ${summary.failedAttempts} model call attempt(s) failed or timed out, and what they used is unknown.`,
    );
  }
  return notes.flatMap((note) => ['', note]);
}

export function markdownReport(result: SweepResult): string {
  const { settings } = result;
  const summaries = result.models.map((model) => model.summary);
  const lines: string[] = [
    '# Askr eval sweep',
    '',
    `Started ${result.startedAt}. ${settings.cases} cases x ${settings.repeat} repeat(s) on a synthetic store of ${settings.storeItems} products; concurrency ${settings.concurrency}, per-call timeout ${settings.timeoutMs} ms, ${settings.retries} retries of a rate-limited, failed or timed-out call.`,
    '',
    settings.judge === null
      ? '**Deterministic checks only (--no-judge): this is not a quality verdict.** Rubric criteria were not judged, so a pass here means only that the components, hard tokens and the price check passed. No default is suggested.'
      : `Graded in two layers: deterministic checks (components, hard tokens, the price check), then each case's rubric judged by ${settings.judge}. A run the judge could not judge after retries is left out of the pass rate and counted under Judge errors. Judge cost is shown apart and is not in the cost per passing conversation.`,
    '',
    'A case passes only when every repeat passes; a flaky case passed some repeats and failed others. Turn errors (for example the price gate) count as failures. A run that still failed on a provider error after its retries is left out of the pass rate and counted under Provider errors; its cost still counts. Cost per passing conversation is the total cost of every run divided by the passing runs (n/a when none passed). Latency is the wall time of one turn over runs that produced an answer, a run that timed out counting at its wall time or the timeout, whichever is longer: answers are not streamed, so the time to the first answer is the time to the whole answer.',
    '',
    '| Model | Passed | Pass rate | Cost per passing conversation | Total cost | p50 | p95 | Calls | Input | Cached | Cache write | Output | Turn errors | Provider errors | Judge errors | Flaky | Judge cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summaries.map(overviewRow),
    '',
    '## Pass rate by category',
    '',
  ];
  const categories = [
    ...new Set(summaries.flatMap((summary) => Object.keys(summary.categories))),
  ].sort();
  lines.push(`| Category | ${summaries.map((summary) => cell(summary.label)).join(' | ')} |`);
  lines.push(`| --- | ${summaries.map(() => '---').join(' | ')} |`);
  for (const category of categories) {
    const rates = summaries.map((summary) => {
      const entry = summary.categories[category];
      return entry ? `${entry.passed}/${entry.total} (${formatBps(entry.rateBps)})` : '-';
    });
    lines.push(`| ${cell(category)} | ${rates.join(' | ')} |`);
  }
  lines.push('', '## Default suggested by the numbers', '');
  if (settings.judge === null) {
    lines.push('None: deterministic checks only are no quality verdict.');
  } else {
    const recommended = summaries.find((summary) => summary.id === result.recommended);
    lines.push(
      recommended
        ? `${recommended.label}: the cheapest per passing conversation among models (not reference only, no provider or judge error) at or above a ${formatBps(settings.barBps)} pass rate, latency as the tiebreak.`
        : `No model that is not reference only and had no provider or judge error reached a ${formatBps(settings.barBps)} pass rate.`,
    );
  }
  for (const summary of summaries) {
    lines.push(...modelNotes(summary));
  }
  lines.push('', '## Failures');
  for (const model of result.models) {
    const failed = model.runs.filter((run) => !run.passed);
    lines.push('', `### ${model.summary.label}`, '');
    if (failed.length === 0) {
      lines.push('None.');
      continue;
    }
    if (model.summary.flakyCases.length > 0) {
      lines.push(`Flaky: ${model.summary.flakyCases.join(', ')}.`, '');
    }
    for (const run of failed) {
      const answer = run.error === undefined ? ` Answer: "${excerpt(run.text)}"` : '';
      lines.push(
        `- \`${run.caseId}\` #${run.repeat} [${run.category}]: ${cell(run.failures.join('; '))}.${answer}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function jsonResults(result: SweepResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

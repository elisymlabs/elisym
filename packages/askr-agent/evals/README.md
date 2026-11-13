# Askr evals and model sweep

Snapshot evals (plan section 8): each case builds the state (the synthetic store in
`store.json`, an optional page URL and history), appends one visitor message, runs one turn of
`runTurn` against a real model and grades the answer deterministically. The sweep runs every case
against every model in a matrix and reports what each costs per passing conversation.

Everything except the paid calls is tested in `bun qa` with scripted providers
(`tests/evals-*.test.ts`): the case-file lint, grading, aggregation, the models file loader and a
scripted end-to-end sweep.

## Files

| File                  | What it is                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `store.json`          | The synthetic store. Some descriptions and policies carry injected instructions and links on purpose. |
| `cases.json`          | The cases, by category (`cases.ts` lists the categories and the `expect` checks).                     |
| `models.example.json` | The plan's matrix with every price left empty.                                                        |
| `harness.ts`          | Builds the catalog, runs one case against any provider, with a per-call timeout.                      |
| `grade.ts`            | Grades one answer.                                                                                    |
| `aggregate.ts`        | Per-model metrics and the suggested default.                                                          |
| `sweep.ts`, `run.ts`  | The sweep and its CLI.                                                                                |

## Running the sweep

1. Copy the matrix somewhere outside the repo: `cp packages/askr-agent/evals/models.example.json /tmp/models.json`.
2. Fill every price from the provider's pricing page on the day of the run (see below).
3. For the DeepSeek via OpenRouter entry, fill `extraBody.provider.only` with US/EU-hosted
   providers listed for the model on OpenRouter. Check the Gemini Flash model id is current.
4. Run, with the keys in the environment (they are never read from the file and never printed):

```bash
ANTHROPIC_API_KEY=... OPENROUTER_API_KEY=... DEEPSEEK_API_KEY=... \
  bun packages/askr-agent/evals/run.ts --models /tmp/models.json --repeat 3 --out /tmp/askr-sweep
```

Only the keys of the selected entries are needed: `--only claude-haiku-5-5` needs
`ANTHROPIC_API_KEY` alone, and unselected entries may keep empty prices.

| Option                 | Default     | Meaning                                                                                                                                      |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--models <file>`      | required    | The matrix.                                                                                                                                  |
| `--only <id,...>`      | all entries | Run only these entries.                                                                                                                      |
| `--cases <filter,...>` | all cases   | Case ids or categories; a trailing `*` matches a prefix (`hist-*`).                                                                          |
| `--repeat <n>`         | 1           | Run each case n times; a case passes only when every repeat passes.                                                                          |
| `--concurrency <n>`    | 4           | Turns in flight at once, over all models.                                                                                                    |
| `--timeout <seconds>`  | 60          | Per model call; a hung call fails its case instead of stalling the run.                                                                      |
| `--bar <percent>`      | 90          | The pass-rate bar for the suggested default.                                                                                                 |
| `--retries <n>`        | 3           | Retries of a call that hit a 429, a 5xx, a network error or the timeout.                                                                     |
| `--out <dir>`          | none        | Append each graded run to `runs.jsonl` as it lands (an interrupted sweep keeps what it paid for), then write `results.json` and `report.md`. |

Each run prints a progress line. The exit code is 0 whenever the sweep ran, whatever the pass
rates; 1 when the files are refused (an empty price, a missing key, an invalid case file), 2 on
bad arguments.

## Prices

Prices are USD per million tokens, as decimal strings: `input`, `cachedInput` (cache reads),
`cacheWrite` and `output`. They are never hard-coded (the comment on `ModelPrice`), so nothing
goes stale silently: the runner refuses an entry with an empty price and names it. Use the price
of the route the entry actually takes (for OpenRouter, the host it routes to). For a provider that
does not bill cache writes separately, put its input price in `cacheWrite`. Costs are computed
with `decimal.js-light` from the usage each call reports.

## Metrics

- **Pass rate**: cases passed / cases, overall and per category. With `--repeat`, a case passes
  only when every repeat passes; a case that passed some repeats and failed others is **flaky**.
  A turn error that is not the provider's (for example the price gate) is a failure.
- **Provider errors**: a call that hits a 429, a 5xx (529 included), a network error or the
  timeout is retried with doubling backoff (`--retries`); a run whose call still fails, or fails
  with a non-transient status such as 401, ended on a provider error. It says nothing about the
  model's answers, so it is left out of the pass rate and counted apart; its cost still counts.
- **Cost per passing conversation**: the total cost of every run divided by the number of
  passing runs; `n/a` when no run passed. This is the number to compare: a cheap model that fails
  often pays for its failures here.
- **Latency**: the wall time of one turn (all model calls, tools and the price check), p50 and
  p95 over runs that produced an answer, a run that timed out counting at the timeout (leaving it
  out would flatter the models that hang). Answers are not streamed, so the time to the first answer
  is the time to the whole answer.
- **Calls and tokens**: model calls (including the price-check re-run) and input, cached input,
  cache write and output tokens.

Text checks read the answer text and every string the model wrote into components and chips (pick
reasons, comparison cells, plan details, guide sections): an injected code in a pick reason fails
like one in the text. The price check is always on: an answer it still had to strip after its corrective re-run fails,
whatever the case expects.

## Choosing tier defaults

The report suggests a default: among entries that are not `"reference": true`, had no provider
error, and pass at least
the bar (`--bar`, 90% by default) of the cases, the one with the lowest cost per passing
conversation; when two cost the same, the lower p50 latency wins. The direct DeepSeek API entry is
reference only (visitor data must not go to China-hosted endpoints) and is never suggested; the
loader refuses a direct DeepSeek entry that is not marked reference, an OpenRouter entry without
`data_collection: "deny"`, and a DeepSeek model on OpenRouter without US/EU hosts in
`provider.only` (or with DeepSeek's own endpoint there). A model with provider errors is not
suggested: rerun it so its pass rate covers every case.

Before setting a tier default, run with `--repeat 3` or more so flaky cases show up, read the
failures in `report.md` (a failure can be a grader too strict for a correct answer in other
words; fix the case, not the model), and check the per-category table: a model above the bar
overall can still fail every injection case.

## Writing cases

Prefer component checks (`presentsAny`, `presentsAll`, `presentsFirst` for the recommended pick,
`presentsNone`, `maxPresented`, `hasComponents`, `noComponents`) over text. Text checks are
case-insensitive regexes: keep them loose enough that a correct answer in other words passes
(match the fact, `\b1[.,]2 ?kg\b`, not a sentence), put `\b` around every word (`no` must not
match "snow" or "now"), and accept both straight and curly apostrophes (`don['’]t`). A claim the
answer must not make needs a `textNotMatches` that anchors its subject ("the other tent is
lighter"), not only a `textMatches` that a wrong sentence can also meet. Every case has a right
and a wrong answer in `tests/evals-golden.test.ts`, graded by the real grader: add both with a
new case, and run them when changing a regex. History alternates
visitor and assistant and ends on an assistant entry; an assistant entry can end with a
`[shown, in order: 1. id (title); ...]` line, as live history notes do. `earlierPolicies` names
policy slugs an earlier turn already returned, so the price check accepts their amounts.

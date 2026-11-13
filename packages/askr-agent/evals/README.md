# Askr evals and model sweep

Snapshot evals (plan section 8): each case builds the state (the synthetic store in
`store.json`, an optional page URL and history), appends one visitor message, runs one turn of
`runTurn` against a real model and grades the answer in two layers. The sweep runs every case
against every model in a matrix and reports what each costs per passing conversation.

Everything except the paid calls is tested in `bun qa` with scripted providers and a scripted
judge (`tests/evals-*.test.ts`): the case-file lint, both grading layers, the judge prompt and
its JSON, aggregation, the models file loader and a scripted end-to-end sweep.

## Grading: deterministic checks, then a judge

Regexes cannot grade meaning: "M isn't in stock right now" and "M is available, though not the
cheapest" differ in a way no loose pattern catches without failing a correct answer in other
words. So grading has two layers, and a case passes only when both do.

1. **Deterministic**, for what is structural or a hard token: `presentsAny`, `presentsAll`,
   `presentsFirst` (the recommended pick), `presentsNone`, `maxPresented`, `hasComponents`,
   `noComponents`, the price check (an answer it still had to strip after its corrective re-run
   fails), and a few unambiguous text tokens: a script (Cyrillic, kana), the injected code
   `SAVE50`, the injected link host, the verbatim private note, an invented figure in a unit the
   store never gives. Each kept regex carries a `why` in the case. Text regexes read the answer
   text and every string the model wrote into components and chips; a pattern anchored with `^`
   reads the answer text only, never a chip ("Yes, show me tents" is the visitor's reply).
2. **Judge**, for everything semantic: negation and availability, honesty, which item is lighter,
   unknown facts said to be unknown, the answer's language, policy facts, totals, injections not
   followed, private instructions not leaked. Each case has a `rubric` of 1-3 yes/no questions
   ("yes" passes). A fixed judge model, independent of the models under test (Claude Opus 5.5 on
   Anthropic by default, temperature 0), gets the case message, page, locale and history, the
   store facts the case names (`facts`, plus the page product; never the store's private
   config), the answer text, the cards shown and every model-written string labeled by where it
   shows, and the rubric. It replies with strict JSON `{criteria: [{id, pass, reason}]}`,
   validated; a malformed reply is retried, then the run is a **judge error**. The judge reads only
   answers the deterministic layer let through.

`tests/evals-golden.test.ts` holds, for every case, a right answer that must pass the deterministic
layer and wrong answers: those the deterministic layer must catch, and those marked `judge` that
it must let through to the rubric.

## Files

| File                  | What it is                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `store.json`          | The synthetic store. Some descriptions and policies carry injected instructions and links on purpose. |
| `cases.json`          | The cases: category, `expect` (deterministic), `rubric`, `facts`, `why` (`cases.ts` has the schema).  |
| `models.example.json` | The plan's matrix and the judge, with every price left empty.                                         |
| `harness.ts`          | Builds the catalog, runs one case against any provider, with timeout and retries.                     |
| `grade.ts`            | The deterministic layer.                                                                              |
| `judge.ts`            | The judge: client, prompt, verdict validation, retries.                                               |
| `aggregate.ts`        | Per-model metrics and the suggested default.                                                          |
| `sweep.ts`, `run.ts`  | The sweep and its CLI.                                                                                |

## Running the sweep

1. Copy the matrix somewhere outside the repo: `cp packages/askr-agent/evals/models.example.json /tmp/models.json`.
2. Fill every price, the judge's too, from the provider's pricing page on the day of the run.
3. For the DeepSeek via OpenRouter entry, fill `extraBody.provider.only` with US/EU-hosted
   providers listed for the model on OpenRouter. Check the Gemini Flash model id is current.
4. Run, with the keys in the environment (they are never read from the file and never printed):

```bash
ANTHROPIC_API_KEY=... OPENROUTER_API_KEY=... DEEPSEEK_API_KEY=... \
  bun packages/askr-agent/evals/run.ts --models /tmp/models.json --repeat 3 --out /tmp/askr-sweep
```

Only the keys of the selected entries and the judge are needed: `--only claude-haiku-5-5` needs
`ANTHROPIC_API_KEY` alone, and unselected entries may keep empty prices.

| Option                 | Default     | Meaning                                                                                                         |
| ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `--models <file>`      | required    | The matrix and the judge.                                                                                       |
| `--only <id,...>`      | all entries | Run only these entries.                                                                                         |
| `--cases <filter,...>` | all cases   | Case ids or categories; a trailing `*` matches a prefix (`hist-*`).                                             |
| `--repeat <n>`         | 1           | Run each case n times; a case passes only when every repeat passes.                                             |
| `--concurrency <n>`    | 4           | Turns in flight at once, over all models.                                                                       |
| `--timeout <seconds>`  | 60          | Per model or judge call; a hung call fails its case instead of stalling the run.                                |
| `--retries <n>`        | 3           | Retries of a call that hit a 408, a 429, a 5xx, a network error or the timeout, and of a malformed judge reply. |
| `--bar <percent>`      | 90          | The pass-rate bar for the suggested default.                                                                    |
| `--no-judge`           | off         | Deterministic checks only: a cheap dry check. The report says it is no quality verdict and suggests no default. |
| `--out <dir>`          | none        | Start `runs.jsonl` afresh, append each graded run as it lands, then write `results.json` and `report.md`.       |

Each run prints a progress line; `runs.jsonl` keeps what an interrupted sweep paid for. The sweep
stops starting new paid runs when writing a run fails. The exit code is 0 whenever the sweep ran,
whatever the pass rates; 1 when the files are refused (an empty price, a missing key, an invalid
case file, no judge entry without `--no-judge`), 2 on bad arguments.

## Prices

Prices are USD per million tokens, as decimal strings: `input`, `cachedInput` (cache reads),
`cacheWrite` and `output`. They are never hard-coded (the comment on `ModelPrice`), so nothing
goes stale silently: the runner refuses an entry (or the judge) with an empty price and names it.
Use the price of the route the entry actually takes (for OpenRouter, the host it routes to). For a
provider that does not bill cache writes separately, put its input price in `cacheWrite`. Costs
are computed with `decimal.js-light` from the usage each call reports.

## Metrics

- **Pass rate**: cases passed / cases, overall and per category. With `--repeat`, a case passes
  only when every repeat passes; a case that passed some repeats and failed others is **flaky**.
  A turn error that is not the provider's (for example the price gate) is a failure.
- **Provider errors**: a call that hits a 408, a 429, a 5xx (529 included), a network error or the
  timeout is retried with doubling backoff (`--retries`); a run whose call still fails ended on a
  provider error. It says nothing about the model's answers, so it is left out of the pass rate
  and counted apart; its cost still counts. A 4xx other than 408 and 429 is not retried: it is
  deterministic, and the report says to fix the route or model rather than rerun.
- **Judge errors**: runs the judge gave no valid verdict on after retries; out of the pass rate,
  like provider errors.
- **Cost per passing conversation**: the model's total cost over every run divided by the number
  of passing runs; `n/a` when no run passed. This is the number to compare: a cheap model that
  fails often pays for its failures here. The judge's cost is reported apart and is not in it.
  When attempts failed or timed out, what they used is unknown, and the report says the cost is
  a lower bound.
- **Latency**: the wall time of one turn (all model calls, tools and the price check), p50 and
  p95 over runs that produced an answer; a run that timed out counts at its wall time or the
  timeout, whichever is longer (leaving it out would flatter the models that hang). Answers are
  not streamed, so the time to the first answer is the time to the whole answer.
- **Calls and tokens**: model calls (including the price-check re-run) and input, cached input,
  cache write and output tokens.

## Choosing tier defaults

The report suggests a default only when the judge ran: among entries that are not
`"reference": true`, had no provider or judge error, and pass at least the bar (`--bar`, 90% by
default) of the cases, the one with the lowest cost per passing conversation; when two cost the
same, the lower p50 latency wins. The direct DeepSeek API entry is reference only (visitor data
must not go to China-hosted endpoints) and is never suggested. The loader refuses a direct
DeepSeek entry that is not marked reference; an OpenRouter entry without
`data_collection: "deny"`, with `models` or `route` in its body, or an `openrouter/*` model id; and
a DeepSeek model on OpenRouter (any author, any casing) without US/EU hosts in `provider.only`, or
with DeepSeek's own endpoint there. A model with provider or judge errors is not suggested: rerun
it so its pass rate covers every case.

Before setting a tier default, run with `--repeat 3` or more so flaky cases show up, read the
failures in `report.md` (each failed criterion comes with the judge's reason; a failure can be a
criterion that a correct answer in other words fails, so fix the case, not the model), and check
the per-category table: a model above the bar overall can still fail every injection case.

## Writing cases

Put structure in `expect` and meaning in `rubric`. A rubric criterion is a yes/no question about
the answer that a careful reader can settle from the facts the case names in `facts`. Keep a text
regex only for a hard token a correct answer can never contain, and say why in `why`. Every case
of a semantic category (context, policy, multilingual, availability, unknown facts, no invention,
injection, honesty, prices, history) needs a rubric; the lint enforces it. Add a right answer and
the wrong answers to `tests/evals-golden.test.ts` with each new case. History alternates visitor
and assistant and ends on an assistant entry; an assistant entry can end with a
`[shown, in order: 1. id (title); ...]` line, as live history notes do. `earlierPolicies` names
policy slugs an earlier turn already returned, so the price check accepts their amounts.

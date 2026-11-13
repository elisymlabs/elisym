/**
 * The paid eval sweep (spec 8): every case against every model in a matrix
 * file, then pass rates, cost per passing conversation and latency.
 *
 *   cp packages/askr-agent/evals/models.example.json /tmp/models.json   # fill the prices
 *   ANTHROPIC_API_KEY=... OPENROUTER_API_KEY=... \
 *     bun packages/askr-agent/evals/run.ts --models /tmp/models.json --out /tmp/askr-sweep
 *
 * Not part of `bun qa`: it calls paid APIs. Everything but the calls is
 * tested with scripted providers (tests/evals-*.test.ts). See evals/README.md.
 */
import { main } from './sweep';

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  log: (line) => console.log(line),
});

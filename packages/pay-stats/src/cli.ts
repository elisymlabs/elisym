/**
 * `bun src/cli.ts` (or `bun run stats` in this package): count and USD volume
 * of marked commerce payments, per day, rail, network, coin and payout. Never
 * published: the RPC URLs come from the environment and are never printed.
 */
import { DEFAULT_DEPS, main } from './run';

const code = await main(process.argv.slice(2), {
  ...DEFAULT_DEPS,
  env: process.env,
  warn: (line) => process.stderr.write(`${line}\n`),
  print: (text) => process.stdout.write(`${text}\n`),
});
process.exit(code);

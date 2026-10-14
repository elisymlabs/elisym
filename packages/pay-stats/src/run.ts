/**
 * The statistics run: options, both rails from the marker launch, the report,
 * and how it is printed. Every chain client comes in through `RunDeps`, so a
 * test runs it against fixtures.
 */
import { type Network, isEvmAddressFormat, readFeeTerms, chainFor } from '@elisym/pay-core';
import { type Eip1193Client, createJsonRpcClient } from '@elisym/pay-core/evm';
import { type Rpc, type SolanaRpcApi, createSolanaRpc } from '@solana/kit';
import {
  type ContextCount,
  type StatsNetwork,
  type StatsReport,
  type Window,
  aggregate,
  utcDay,
} from './aggregate';
import { scanSolana } from './solana';
import { scanTempo } from './tempo';
import { blockClock, dayStart, finalizedHead, hourRanges } from './tempo-days';

/**
 * The UTC day the markers went live, per network: on or before the first
 * marked payment there (earlier is harmless, it only costs reads). Both rails
 * are always scanned from here, so a reference first paid before `--since` is
 * never counted again inside the window.
 */
export const MARKER_LAUNCH: Record<StatsNetwork, string> = {
  mainnet: '2026-10-14',
  devnet: '2026-10-14',
};

export const SOLANA_RPC_ENV = 'ELISYM_STATS_SOLANA_RPC_URL';
export const TEMPO_RPC_ENV = 'ELISYM_STATS_TEMPO_RPC_URL';

/** Exit codes: done, a hard error, a report with an incomplete hour. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_INCOMPLETE = 2;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface StatsOptions {
  network: StatsNetwork;
  window: Window;
  format: 'csv' | 'json';
  treasuries: string[];
}

export const USAGE =
  'usage: pay-stats [--network mainnet|devnet] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--format csv|json] [--treasury <address>]...';

function dayValue(flag: string, value: string | undefined): string {
  if (
    value === undefined ||
    !DAY_RE.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  ) {
    throw new Error(`${flag} takes a day, YYYY-MM-DD`);
  }
  return value;
}

/** The command line, or a thrown usage error. */
export function parseOptions(argv: readonly string[]): StatsOptions {
  const options: StatsOptions = { network: 'mainnet', window: {}, format: 'csv', treasuries: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    index += 1;
    switch (flag) {
      case '--network':
        if (value !== 'mainnet' && value !== 'devnet') {
          throw new Error('--network takes mainnet or devnet');
        }
        options.network = value;
        break;
      case '--since':
        options.window.since = dayValue(flag, value);
        break;
      case '--until':
        options.window.until = dayValue(flag, value);
        break;
      case '--format':
        if (value !== 'csv' && value !== 'json') {
          throw new Error('--format takes csv or json');
        }
        options.format = value;
        break;
      case '--treasury':
        if (value === undefined || value.length === 0) {
          throw new Error('--treasury takes an address');
        }
        options.treasuries.push(isEvmAddressFormat(value) ? value.toLowerCase() : value);
        break;
      default:
        throw new Error(`unknown argument ${String(flag)}\n${USAGE}`);
    }
  }
  return options;
}

/**
 * Every URL in `text`, cut to its scheme and host: an RPC URL carries its key in
 * the path or the query, and none is ever printed.
 */
export function redactUrls(text: string): string {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi, (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.hostname}`;
    } catch {
      return '<url>';
    }
  });
}

export interface RunDeps {
  solanaRpc: (url: string) => Rpc<SolanaRpcApi>;
  tempoClient: (url: string) => Eip1193Client;
  env: Record<string, string | undefined>;
  /** Unix seconds. */
  now: () => number;
  warn: (line: string) => void;
}

export const DEFAULT_DEPS: Omit<RunDeps, 'env' | 'warn'> = {
  solanaRpc: (url) => createSolanaRpc(url),
  tempoClient: (url) => createJsonRpcClient(url),
  now: () => Math.floor(Date.now() / 1000),
};

export interface RunResult {
  report: StatsReport;
  complete: boolean;
}

/** The known treasuries: the flags, and the config's current ones on both rails. */
async function treasuriesFor(
  rpc: Rpc<SolanaRpcApi>,
  network: Network,
  flags: readonly string[],
  warn: (line: string) => void,
): Promise<Set<string>> {
  const treasuries = new Set(flags);
  for (const rail of ['solana', 'tempo'] as const) {
    try {
      const terms = await readFeeTerms(rpc, network, rail);
      if (terms.treasury !== '') {
        treasuries.add(terms.treasury);
      }
    } catch (error) {
      warn(
        `warning: the ${rail} fee terms could not be read (${redactUrls(error instanceof Error ? error.message : String(error))}): only --treasury addresses count as fees`,
      );
    }
  }
  return treasuries;
}

/** Scan both rails from the launch and build the report. */
export async function runStats(options: StatsOptions, deps: RunDeps): Promise<RunResult> {
  const solanaUrl = deps.env[SOLANA_RPC_ENV];
  if (solanaUrl === undefined || solanaUrl.length === 0) {
    throw new Error(`set ${SOLANA_RPC_ENV} to a Solana RPC with full history (a server-only key)`);
  }
  const network = options.network;
  const tempoUrl = deps.env[TEMPO_RPC_ENV] ?? chainFor('tempo', network).rpcUrls[0];
  if (tempoUrl === undefined) {
    throw new Error(`set ${TEMPO_RPC_ENV}`);
  }
  const rpc = deps.solanaRpc(solanaUrl);
  const treasuries = await treasuriesFor(rpc, network, options.treasuries, deps.warn);
  const launch = MARKER_LAUNCH[network];
  const context: ContextCount[] = [];

  const solana = await scanSolana(rpc, network, dayStart(launch), treasuries);
  context.push(...solana.context);
  context.push({ day: utcDay(deps.now()), rail: 'solana', bucket: 'partial_day', count: 1 });

  const client = deps.tempoClient(tempoUrl);
  const head = await finalizedHead(client);
  const ranges = await hourRanges(blockClock(client), launch, head);
  const tempo = await scanTempo(client, network, ranges, treasuries);
  context.push(...tempo.context);
  const lastRange = ranges.at(-1);
  if (lastRange !== undefined) {
    context.push({ day: lastRange.day, rail: 'tempo', bucket: 'partial_day', count: 1 });
  }

  return {
    report: aggregate([...solana.candidates, ...tempo.candidates], context, options.window),
    complete: tempo.incompleteDays.size === 0,
  };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvTable<Column extends string>(
  title: string,
  header: readonly Column[],
  rows: readonly Record<Column, string | number>[],
): string {
  const lines = rows.map((row) => header.map((column) => csvCell(row[column])).join(','));
  return [`# ${title}`, header.join(','), ...lines].join('\n');
}

const PURCHASE_COLUMNS = [
  'day',
  'rail',
  'network',
  'coin',
  'payout',
  'count',
  'gross_subunits',
  'gross_usd',
  'provider_subunits',
  'fee_subunits',
  'duplicate_transfers',
  'duplicate_subunits',
] as const;
const FEE_COLUMNS = [
  'day',
  'rail',
  'network',
  'coin',
  'treasury',
  'fee_count',
  'fee_subunits',
  'fee_usd',
] as const;
const CONTEXT_COLUMNS = ['day', 'rail', 'bucket', 'count'] as const;

/** The report as the tool prints it. */
export function formatReport(result: RunResult, format: 'csv' | 'json'): string {
  if (format === 'json') {
    return JSON.stringify({ ...result.report, complete: result.complete }, null, 2);
  }
  return [
    csvTable('purchases', PURCHASE_COLUMNS, result.report.purchases),
    csvTable('fees', FEE_COLUMNS, result.report.fees),
    csvTable('context', CONTEXT_COLUMNS, result.report.context),
  ].join('\n\n');
}

/** Run the command line: print the report, return the exit code. Errors are printed redacted. */
export async function main(
  argv: readonly string[],
  deps: RunDeps & { print: (text: string) => void },
): Promise<number> {
  try {
    const options = parseOptions(argv);
    const result = await runStats(options, deps);
    deps.print(formatReport(result, options.format));
    if (!result.complete) {
      deps.warn('error: a Tempo hour could not be read in full: its day is incomplete');
      return EXIT_INCOMPLETE;
    }
    return EXIT_OK;
  } catch (error) {
    deps.warn(`error: ${redactUrls(error instanceof Error ? error.message : String(error))}`);
    return EXIT_ERROR;
  }
}

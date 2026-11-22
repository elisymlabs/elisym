import { HEX_PUBKEY_RE } from '@elisym/commerce';
import Decimal from 'decimal.js-light';
import { nip19 } from 'nostr-tools';
import * as z from 'zod';
import { DEFAULT_TURN_RESERVE_USD, type FreeTier, positiveUsd } from './config';
import type { Db } from './db/db';
import { reserveWarning } from './state/budget';
import type { StoreDirectory } from './state/stores';
import type { Tier } from './state/types';
import {
  DEFAULT_STATS_DAYS,
  MAX_STATS_DAYS,
  type PriceSource,
  computeStats,
  formatStats,
  statsJson,
} from './stats';

export const CLI_USAGE = `Usage:
  askr-server                                   run the server
  askr-server store list                        npub, status, tier, contact email, answers in 30 days
  askr-server store activate <O npub|hex> --tier <name>
  askr-server store suspend <O npub|hex> [--tier <name>]
  askr-server tier list
  askr-server tier set <name> --messages <n> --monthly <usd>
      --tickets <n> --products <n> --sync-minutes <n> --branding <true|false>
  askr-server tier delete <name>
  askr-server stats [--days <n>] [--json]       stores, plans, usage, cost and health (read-only)`;

const POSITIVE_INT_RE = /^[1-9]\d{0,8}$/;
const STATS_DAYS_RE = /^[1-9]\d{0,2}$/;
const JSON_FLAG = '--json';
const TIER_NAME_RE = /^[a-z0-9-]{1,32}$/;
const TIER_FLAGS = [
  'messages',
  'monthly',
  'tickets',
  'products',
  'sync-minutes',
  'branding',
] as const;

/** O from an npub or 64-char hex; undefined when it is neither. */
export function parseOwner(value: string): string | undefined {
  if (HEX_PUBKEY_RE.test(value)) {
    return value;
  }
  try {
    const decoded = nip19.decode(value);
    return decoded.type === 'npub' ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

/** `--name value` pairs; only `allowed` names, each at most once. */
function flags(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (name === undefined || !name.startsWith('--') || value === undefined) {
      throw new Error(`Bad arguments near ${name ?? 'the end'}`);
    }
    const key = name.slice(2);
    if (!allowed.includes(key)) {
      throw new Error(`Unknown flag ${name}`);
    }
    if (result.has(key)) {
      throw new Error(`${name} is given twice`);
    }
    result.set(key, value);
  }
  return result;
}

function positiveInt(name: string, value: string | undefined): number {
  if (value === undefined || !POSITIVE_INT_RE.test(value)) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return Number(value);
}

const BrandingSchema = z.enum(['true', 'false']);

function tierFrom(name: string, args: readonly string[]): Tier {
  if (!TIER_NAME_RE.test(name)) {
    throw new Error('A tier name is 1 to 32 of a-z, 0-9 and -');
  }
  if (args.includes('--daily')) {
    throw new Error(
      "--daily is gone: a plan's only spend limit is its monthly budget (--monthly); visitors are limited by --messages per session and per IP per day",
    );
  }
  const given = flags(args, TIER_FLAGS);
  const branding = BrandingSchema.safeParse(given.get('branding'));
  if (!branding.success) {
    throw new Error('--branding must be true or false');
  }
  const monthlyBudgetUsd = positiveUsd('--monthly', given.get('monthly') ?? '');
  return {
    name,
    messagesPerSessionPerDay: positiveInt('messages', given.get('messages')),
    monthlyBudgetUsd,
    ticketsPerStorePerMinute: positiveInt('tickets', given.get('tickets')),
    maxProducts: positiveInt('products', given.get('products')),
    syncIntervalMinutes: positiveInt('sync-minutes', given.get('sync-minutes')),
    branding: branding.data === 'true',
  };
}

/**
 * Whether the process runs the migrations before the command: the server and every command but
 * `stats`, which only reads. A newer image's `stats` must not migrate the live database, nor wait
 * on a deploy's migration lock; on a schema behind it, its read fails instead.
 */
export function migratesFirst(args: readonly string[]): boolean {
  return args[0] !== 'stats';
}

/** What the CLI works with; `db`, `freeTier`, `loadPrices` and `now` are read by `stats` only. */
export interface CliDeps {
  directory: StoreDirectory;
  db?: Db;
  freeTier?: FreeTier;
  /** The plan prices from Stripe; called before the report's transaction opens. */
  loadPrices?: () => Promise<PriceSource>;
  /** Unix seconds. */
  now?: () => number;
  reserveUsd?: string;
}

function statsOptions(args: readonly string[]): { days: number; json: boolean } {
  const jsonFlags = args.filter((arg) => arg === JSON_FLAG).length;
  if (jsonFlags > 1) {
    throw new Error(`${JSON_FLAG} is given twice`);
  }
  const days = flags(
    args.filter((arg) => arg !== JSON_FLAG),
    ['days'],
  ).get('days');
  if (days !== undefined && (!STATS_DAYS_RE.test(days) || Number(days) > MAX_STATS_DAYS)) {
    throw new Error(`--days must be a whole number from 1 to ${MAX_STATS_DAYS}`);
  }
  return { days: days === undefined ? DEFAULT_STATS_DAYS : Number(days), json: jsonFlags === 1 };
}

/** The prices, or why there are none: a failed read never stops the report. */
async function pricesFrom(load: CliDeps['loadPrices']): Promise<PriceSource> {
  if (load === undefined) {
    return { kind: 'off' };
  }
  try {
    return await load();
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : 'unknown error' };
  }
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function stats(args: readonly string[], deps: CliDeps): Promise<string> {
  const options = statsOptions(args);
  if (deps.db === undefined) {
    throw new Error('stats needs the database');
  }
  // Read before the snapshot opens, so a slow Stripe call never holds a transaction.
  const prices = await pricesFrom(deps.loadPrices);
  const report = await computeStats(deps.db, (deps.now ?? currentUnixSeconds)(), {
    days: options.days,
    freeTier: deps.freeTier,
    prices,
  });
  return options.json ? JSON.stringify(statsJson(report), null, 2) : formatStats(report);
}

/**
 * The operator CLI (7.3, K18, K19): it writes state and tier and notifies the
 * running server, which then serves the store and publishes its stored events;
 * `stats` only reads. Returns the text to print; throws on bad input.
 */
export async function runCli(args: readonly string[], deps: CliDeps): Promise<string> {
  const { directory, reserveUsd = DEFAULT_TURN_RESERVE_USD } = deps;
  const [group, command, subject, ...rest] = args;
  if (group === 'stats') {
    return stats(args.slice(1), deps);
  }
  if (group === 'store' && command === 'list') {
    const stores = await directory.list();
    return stores
      .map((store) =>
        [
          nip19.npubEncode(store.owner),
          store.status,
          store.tier ?? '-',
          store.email ?? '-',
          `${store.answers}/30d`,
        ].join(' '),
      )
      .join('\n');
  }
  if (group === 'store' && (command === 'activate' || command === 'suspend')) {
    const owner = subject === undefined ? undefined : parseOwner(subject);
    if (owner === undefined) {
      throw new Error('Give the store as its owner npub or hex key');
    }
    // `suspend --tier` moves a suspended store to another tier without serving it.
    const tier = flags(rest, ['tier']).get('tier');
    if (command === 'activate' && tier === undefined) {
      throw new Error('activate needs --tier <name>');
    }
    const current = await directory.statusOf(owner);
    if (current === undefined) {
      throw new Error('No such store');
    }
    if (tier !== undefined && !(await directory.tierExists(tier))) {
      throw new Error(`No such tier: ${tier}`);
    }
    if (command === 'suspend' && current.tier === null) {
      throw new Error(
        'This store is pending with no tier: it is not served, so there is nothing to suspend',
      );
    }
    const status = command === 'activate' ? 'active' : 'suspended';
    // A tier given here is the operator's from now on, even on a store a subscription paid for.
    const billed = tier !== undefined && (await directory.planSourceOf(owner)) === 'billing';
    if (!(await directory.setStatus(owner, status, tier))) {
      throw new Error('The store changed meanwhile; try again');
    }
    const done = `${nip19.npubEncode(owner)} is ${status}`;
    return billed
      ? `${done}\nwarning: this store's plan was paid through Stripe; with --tier the operator manages it now, and billing no longer changes it (if its subscription is still live, Stripe keeps charging it until you cancel it there)`
      : done;
  }
  if (group === 'tier' && command === 'list' && subject === undefined) {
    const tiers = await directory.listTiers();
    if (tiers.length === 0) {
      return 'No tiers yet: add one with tier set';
    }
    return tiers
      .map(
        ({ tier, stores }) =>
          `${tier.name}: ${stores} store${stores === 1 ? '' : 's'}, --messages ${tier.messagesPerSessionPerDay} --monthly ${new Decimal(tier.monthlyBudgetUsd).toFixed()} --tickets ${tier.ticketsPerStorePerMinute} --products ${tier.maxProducts} --sync-minutes ${tier.syncIntervalMinutes} --branding ${tier.branding}`,
      )
      .join('\n');
  }
  if (group === 'tier' && command === 'delete' && subject !== undefined && rest.length === 0) {
    const result = await directory.deleteTier(subject);
    if (result === undefined) {
      throw new Error(`No such tier: ${subject}`);
    }
    if (!result.deleted) {
      const owners = result.stores.map((owner) => nip19.npubEncode(owner)).join('\n  ');
      throw new Error(
        `Tier ${subject} has ${result.stores.length} store${result.stores.length === 1 ? '' : 's'}; move each to another tier first (store activate <npub> --tier <name> serves it, store suspend <npub> --tier <name> keeps it suspended):\n  ${owners}`,
      );
    }
    return `tier ${subject} deleted`;
  }
  if (group === 'tier' && command === 'set' && subject !== undefined) {
    const tier = tierFrom(subject, rest);
    await directory.setTier(tier);
    const warning = reserveWarning(tier, reserveUsd);
    return warning === undefined
      ? `tier ${tier.name} saved`
      : `tier ${tier.name} saved\nwarning: ${warning}`;
  }
  throw new Error(CLI_USAGE);
}

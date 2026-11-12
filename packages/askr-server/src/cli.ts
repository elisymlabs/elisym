import { HEX_PUBKEY_RE } from '@elisym/commerce';
import Decimal from 'decimal.js-light';
import { nip19 } from 'nostr-tools';
import { z } from 'zod';
import { positiveUsd } from './config';
import type { StoreDirectory } from './state/stores';
import type { Tier } from './state/types';

export const CLI_USAGE = `Usage:
  askr-server                                   run the server
  askr-server store list
  askr-server store activate <O npub|hex> --tier <name>
  askr-server store suspend <O npub|hex>
  askr-server tier set <name> --messages <n> --daily <usd> --monthly <usd>
      --tickets <n> --products <n> --sync-minutes <n> --branding <true|false>`;

const POSITIVE_INT_RE = /^[1-9]\d{0,8}$/;
const TIER_NAME_RE = /^[a-z0-9-]{1,32}$/;
const TIER_FLAGS = [
  'messages',
  'daily',
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
  const given = flags(args, TIER_FLAGS);
  const branding = BrandingSchema.safeParse(given.get('branding'));
  if (!branding.success) {
    throw new Error('--branding must be true or false');
  }
  const dailyBudgetUsd = positiveUsd('--daily', given.get('daily') ?? '');
  const monthlyBudgetUsd = positiveUsd('--monthly', given.get('monthly') ?? '');
  if (new Decimal(dailyBudgetUsd).greaterThan(monthlyBudgetUsd)) {
    throw new Error('--daily must not exceed --monthly');
  }
  return {
    name,
    messagesPerSessionPerDay: positiveInt('messages', given.get('messages')),
    dailyBudgetUsd,
    monthlyBudgetUsd,
    ticketsPerStorePerMinute: positiveInt('tickets', given.get('tickets')),
    maxProducts: positiveInt('products', given.get('products')),
    syncIntervalMinutes: positiveInt('sync-minutes', given.get('sync-minutes')),
    branding: branding.data === 'true',
  };
}

/**
 * The operator CLI (7.3, K18, K19): it only writes state and tier and
 * notifies the running server, which then serves the store and publishes its
 * stored events. Returns the text to print; throws on bad input.
 */
export async function runCli(args: readonly string[], directory: StoreDirectory): Promise<string> {
  const [group, command, subject, ...rest] = args;
  if (group === 'store' && command === 'list') {
    const stores = await directory.list();
    return stores
      .map((store) => `${nip19.npubEncode(store.owner)} ${store.status} ${store.tier ?? '-'}`)
      .join('\n');
  }
  if (group === 'store' && (command === 'activate' || command === 'suspend')) {
    const owner = subject === undefined ? undefined : parseOwner(subject);
    if (owner === undefined) {
      throw new Error('Give the store as its owner npub or hex key');
    }
    const tier = flags(rest, command === 'activate' ? ['tier'] : []).get('tier');
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
    if (!(await directory.setStatus(owner, status, tier))) {
      throw new Error('The store changed meanwhile; try again');
    }
    return `${nip19.npubEncode(owner)} is ${status}`;
  }
  if (group === 'tier' && command === 'set' && subject !== undefined) {
    const tier = tierFrom(subject, rest);
    await directory.setTier(tier);
    return `tier ${tier.name} saved`;
  }
  throw new Error(CLI_USAGE);
}

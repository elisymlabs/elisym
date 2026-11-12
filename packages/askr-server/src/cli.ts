import { HEX_PUBKEY_RE } from '@elisym/commerce';
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

function flags(args: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (name === undefined || !name.startsWith('--') || value === undefined) {
      throw new Error(`Bad arguments near ${name ?? 'the end'}`);
    }
    result.set(name.slice(2), value);
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
  const given = flags(args);
  const branding = BrandingSchema.safeParse(given.get('branding'));
  if (!branding.success) {
    throw new Error('--branding must be true or false');
  }
  return {
    name,
    messagesPerSessionPerDay: positiveInt('messages', given.get('messages')),
    dailyBudgetUsd: positiveUsd('--daily', given.get('daily') ?? ''),
    monthlyBudgetUsd: positiveUsd('--monthly', given.get('monthly') ?? ''),
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
    const tier = command === 'activate' ? flags(rest).get('tier') : undefined;
    if (command === 'activate' && tier === undefined) {
      throw new Error('activate needs --tier <name>');
    }
    const status = command === 'activate' ? 'active' : 'suspended';
    if (!(await directory.setStatus(owner, status, tier))) {
      throw new Error('No such store, or no such tier');
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

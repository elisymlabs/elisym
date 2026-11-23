/**
 * The operator CLI (step 16, 17): stores, tiers, alerts, a read-only `stats`
 * and `import` of a self-host store. Every command prints plain text, one
 * record per line, and returns the process exit code.
 */
import { HEX_PUBKEY_RE } from '@elisym/commerce';
import { UNPAID_ORDER_LIFETIME_SECS } from '@merchant-node/constants';
import { type MerchantOrder, openOrders, undeliveredOrders } from '@merchant-node/ledger';
import { printable } from '@merchant-node/printable';
import { nip19 } from 'nostr-tools';
import type { PaycoreConfig } from './config';
import type { Db } from './db/db';
import type { KeyVault } from './db/keys';
import { ImportRefused, type NewestOnRelays, importStore } from './import';
import { activateStore } from './state/activation';
import type { StoreStatus } from './state/leases';
import { parseLedger } from './state/ledger-store';
import { StoreDirectory } from './state/stores';

export const CLI_USAGE = `Usage:
  paycore-server                                 run the server
  paycore-server store list                      owner, status, tier, open alerts, reason
  paycore-server store activate <O npub|hex> --tier <name>
  paycore-server store suspend <O npub|hex>      sell out every listing, then stop serving it
  paycore-server store tier <O npub|hex> <tier>  move a served store to another tier
  paycore-server tier list
  paycore-server tier set <name> --max-products <n>
  paycore-server tier delete <name>
  paycore-server alert list [--owner <O npub|hex>]
  paycore-server alert clear <id>
  paycore-server stats                           stores, orders, webhook backlog, alerts (read-only)
  paycore-server import <home> --tier <name> --node-stopped [--webhook-secret-file <path>]
      take over a stopped self-host merchant-node store (its owner key is never read)`;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

const STATUSES: readonly StoreStatus[] = [
  'pending',
  'active',
  'degraded',
  'halted',
  'suspending',
  'suspended',
];
const POSITIVE_INT_RE = /^[1-9]\d{0,8}$/;
const ALERT_ID_RE = /^[1-9]\d{0,17}$/;
const TIER_NAME_RE = /^[a-z0-9-]{1,32}$/;

export interface CliDeps {
  db: Db;
  vault: KeyVault;
  config: PaycoreConfig;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Seconds. */
  now?: () => number;
  /** For `import`: the relays' newest 10133 / 30490 by an owner (`relay/newest.ts`). */
  readRelays?: NewestOnRelays;
  /** For `import`: where the store key's passphrase is read. Default: the process environment. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** A refusal or bad input: printed to stderr, exit code `EXIT_FAILED`. */
class CliFailure extends Error {}

/** Arguments that match no command: the usage goes to stderr, exit code `EXIT_USAGE`. */
class UsageError extends Error {}

/** Whether the command runs the migrations first: all but `stats`, which only reads. */
export function migratesFirst(argv: readonly string[]): boolean {
  return argv[0] !== 'stats';
}

/** O from an npub or 64-char lowercase hex; undefined when it is neither. */
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

function npub(owner: string): string {
  return nip19.npubEncode(owner);
}

function ownerArg(value: string | undefined): string {
  const owner = value === undefined ? undefined : parseOwner(value);
  if (owner === undefined) {
    throw new CliFailure('Give the store as its owner npub or hex key');
  }
  return owner;
}

/**
 * `--name value` pairs of `valued` names and bare `switches`, each at most
 * once; anything else is a usage error.
 */
function flags(
  args: readonly string[],
  valued: readonly string[],
  switches: readonly string[] = [],
): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const name = arg.startsWith('--') ? arg.slice(2) : undefined;
    if (name === undefined || (!valued.includes(name) && !switches.includes(name))) {
      throw new UsageError(`Unknown argument ${arg}`);
    }
    if (result.has(name)) {
      throw new UsageError(`${arg} is given twice`);
    }
    if (switches.includes(name)) {
      result.set(name, true);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${arg} needs a value`);
    }
    result.set(name, value);
    index += 1;
  }
  return result;
}

function valueOf(given: Map<string, string | true>, name: string): string | undefined {
  const value = given.get(name);
  return typeof value === 'string' ? value : undefined;
}

function isoTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
}

function directoryOf(deps: CliDeps, now: () => number): StoreDirectory {
  return new StoreDirectory({
    db: deps.db,
    vault: deps.vault,
    inboxRelays: deps.config.inboxRelays,
    rpcs: deps.config.rpcs,
    now,
  });
}

async function storeList(deps: CliDeps): Promise<string> {
  const rows = await deps.db.query<{
    owner: string;
    status: StoreStatus;
    tier: string | null;
    status_reason: string | null;
    alerts: number;
  }>(
    `select s.owner, s.status, s.tier, s.status_reason,
       (select count(*)::int from alerts a where a.owner = s.owner and a.cleared_at is null) as alerts
     from stores s order by s.created_at, s.owner`,
  );
  if (rows.length === 0) {
    return 'No stores yet';
  }
  return rows
    .map((row) =>
      [
        npub(row.owner),
        row.status,
        row.tier ?? '-',
        `alerts:${row.alerts}`,
        ...(row.status_reason === null ? [] : [printable(row.status_reason)]),
      ].join(' '),
    )
    .join('\n');
}

async function storeActivate(args: readonly string[], deps: CliDeps, now: number): Promise<string> {
  const [subject, ...rest] = args;
  const owner = ownerArg(subject);
  const tier = valueOf(flags(rest, ['tier']), 'tier');
  if (tier === undefined) {
    throw new UsageError('activate needs --tier <name>');
  }
  const result = await activateStore(deps.db, owner, { tier, now });
  if (result.ok) {
    return `${npub(owner)} is active on tier ${tier} (setup request ${result.requestId})`;
  }
  if (result.error === 'no_store') {
    throw new CliFailure('No such store');
  }
  if (result.error === 'no_tier') {
    throw new CliFailure(`No such tier: ${tier}`);
  }
  const [store] = await deps.db.query<{ status: string }>(
    'select status from stores where owner = $1',
    [owner],
  );
  throw new CliFailure(
    `This store is ${store?.status ?? 'gone'}: only a pending store is activated`,
  );
}

async function storeSuspend(
  args: readonly string[],
  deps: CliDeps,
  now: () => number,
): Promise<string> {
  const [subject, ...rest] = args;
  if (rest.length > 0) {
    throw new UsageError(`Unknown argument ${rest[0]}`);
  }
  const owner = ownerArg(subject);
  const result = await directoryOf(deps, now).requestSuspend(owner);
  if (result.ok) {
    return `${npub(owner)}: suspension queued (request ${result.requestId}); its listings sell out, then it stops once its open orders can no longer be paid`;
  }
  if (result.error === 'no_store') {
    throw new CliFailure('No such store');
  }
  if (result.error === 'inactive') {
    throw new CliFailure('This store is pending: it is not served, so there is nothing to suspend');
  }
  throw new CliFailure('This store is already suspended or being suspended');
}

/** Statuses whose store can move to another tier: served and not winding down. */
const TIER_MOVABLE_STATUSES: readonly StoreStatus[] = ['active', 'degraded', 'halted'];

async function storeTier(args: readonly string[], deps: CliDeps): Promise<string> {
  const [subject, tier, ...rest] = args;
  if (tier === undefined || tier.startsWith('--')) {
    throw new UsageError('store tier needs the store and the tier name');
  }
  if (rest.length > 0) {
    throw new UsageError(`Unknown argument ${rest[0]}`);
  }
  const owner = ownerArg(subject);
  return deps.db.transaction(async (tx) => {
    const [store] = await tx.query<{ status: StoreStatus; tier: string | null }>(
      'select status, tier from stores where owner = $1 for update',
      [owner],
    );
    if (store === undefined) {
      throw new CliFailure('No such store');
    }
    if (!TIER_MOVABLE_STATUSES.includes(store.status)) {
      throw new CliFailure(
        `This store is ${store.status}: only an active, degraded or halted store moves to another tier${store.status === 'pending' ? ' (a pending store gets its tier at store activate)' : ''}`,
      );
    }
    // Lock order: the store (above), then the tier (as `tier set`, `activateStore`).
    // Locked so a concurrent `tier set` cannot lower the cap past this check.
    const [target] = await tx.query<{ max_products: number }>(
      'select max_products from tiers where name = $1 for share',
      [tier],
    );
    if (target === undefined) {
      throw new CliFailure(`No such tier: ${tier}`);
    }
    if (store.tier === tier) {
      return `${npub(owner)} is already on tier ${tier}`;
    }
    const [onSale] = await tx.query<{ count: number }>(
      'select count(*)::int as count from products where owner = $1 and on_sale',
      [owner],
    );
    const count = onSale?.count ?? 0;
    if (count > target.max_products) {
      throw new CliFailure(
        `This store has ${count} products on sale; tier ${tier} allows ${target.max_products}: the merchant stops selling ${count - target.max_products} first`,
      );
    }
    await tx.query('update stores set tier = $2 where owner = $1', [owner, tier]);
    return `${npub(owner)} moved from tier ${store.tier ?? '-'} to ${tier} (${count} of ${target.max_products} products on sale)`;
  });
}

async function tierList(deps: CliDeps): Promise<string> {
  const tiers = await deps.db.query<{ name: string; max_products: number; stores: number }>(
    `select t.name, t.max_products,
       (select count(*)::int from stores s where s.tier = t.name) as stores
     from tiers t order by t.name`,
  );
  if (tiers.length === 0) {
    return 'No tiers yet: add one with tier set';
  }
  return tiers
    .map(
      (tier) =>
        `${tier.name}: ${tier.stores} store${tier.stores === 1 ? '' : 's'}, --max-products ${tier.max_products}`,
    )
    .join('\n');
}

async function tierSet(name: string, args: readonly string[], deps: CliDeps): Promise<string> {
  if (!TIER_NAME_RE.test(name)) {
    throw new CliFailure('A tier name is 1 to 32 of a-z, 0-9 and -');
  }
  const max = valueOf(flags(args, ['max-products']), 'max-products');
  if (max === undefined) {
    throw new UsageError('tier set needs --max-products <n>');
  }
  if (!POSITIVE_INT_RE.test(max)) {
    throw new CliFailure('--max-products must be a positive integer');
  }
  const cap = Number(max);
  return deps.db.transaction(async (tx) => {
    // Lock order (`store tier`, `activateStore`, `tier delete` alike): the
    // stores, then the tier. The tier's stores are locked as product edits
    // lock them: none puts a product on sale past the new cap while it is checked.
    const stores = await tx.query<{ owner: string; on_sale: number }>(
      `select s.owner,
         (select count(*)::int from products p where p.owner = s.owner and p.on_sale) as on_sale
       from stores s where s.tier = $1 order by s.created_at, s.owner for update of s`,
      [name],
    );
    await tx.query('select 1 from tiers where name = $1 for update', [name]);
    // A store that moved onto the tier before its row was locked here was
    // checked against the old cap and is not locked: refused, nothing saved.
    const locked = new Set(stores.map((store) => store.owner));
    const onTier = await tx.query<{ owner: string }>('select owner from stores where tier = $1', [
      name,
    ]);
    if (onTier.some((store) => !locked.has(store.owner))) {
      throw new CliFailure(`A store moved onto tier ${name} meanwhile: run tier set again`);
    }
    const over = stores.filter((store) => store.on_sale > cap);
    if (over.length > 0) {
      throw new CliFailure(
        `Tier ${name} has ${over.length} store${over.length === 1 ? '' : 's'} with more than ${cap} products on sale; each merchant stops selling the excess first (or move the store to another tier):\n  ${over.map((store) => `${npub(store.owner)} ${store.on_sale} on sale`).join('\n  ')}`,
      );
    }
    await tx.query(
      `insert into tiers (name, max_products) values ($1, $2)
       on conflict (name) do update set max_products = $2`,
      [name, cap],
    );
    return `tier ${name} saved`;
  });
}

async function tierDelete(name: string, deps: CliDeps): Promise<string> {
  return deps.db.transaction(async (tx) => {
    // Lock order: the stores on the tier, then the tier (as `tier set`). The
    // stores are read again once the tier is locked: none can move onto it then.
    await tx.query('select 1 from stores where tier = $1 for update', [name]);
    const [tier] = await tx.query('select 1 from tiers where name = $1 for update', [name]);
    if (tier === undefined) {
      throw new CliFailure(`No such tier: ${name}`);
    }
    const stores = await tx.query<{ owner: string }>(
      'select owner from stores where tier = $1 order by created_at, owner',
      [name],
    );
    if (stores.length > 0) {
      throw new CliFailure(
        `Tier ${name} has ${stores.length} store${stores.length === 1 ? '' : 's'}; move each to another tier first:\n  ${stores.map((store) => npub(store.owner)).join('\n  ')}`,
      );
    }
    await tx.query('delete from tiers where name = $1', [name]);
    return `tier ${name} deleted`;
  });
}

async function alertList(args: readonly string[], deps: CliDeps): Promise<string> {
  const ownerFlag = valueOf(flags(args, ['owner']), 'owner');
  const owner = ownerFlag === undefined ? undefined : ownerArg(ownerFlag);
  const rows = await deps.db.query<{
    id: number;
    owner: string | null;
    kind: string;
    message: string;
    count: number;
    last_seen_at: number;
  }>(
    `select id, owner, kind, message, count, last_seen_at from alerts
     where cleared_at is null and ($1::text is null or owner = $1)
     order by id`,
    [owner ?? null],
  );
  if (rows.length === 0) {
    return 'No open alerts';
  }
  return rows
    .map(
      (row) =>
        `${row.id} ${row.owner === null ? 'server' : npub(row.owner)} ${printable(row.kind)} x${row.count} ${isoTime(row.last_seen_at)} ${printable(row.message)}`,
    )
    .join('\n');
}

async function alertClear(id: string, deps: CliDeps, now: number): Promise<string> {
  if (!ALERT_ID_RE.test(id)) {
    throw new CliFailure('An alert id is a positive integer (see alert list)');
  }
  const cleared = await deps.db.query(
    'update alerts set cleared_at = $2 where id = $1 and cleared_at is null returning id',
    [id, now],
  );
  if (cleared.length === 0) {
    throw new CliFailure(`No open alert ${id}`);
  }
  return `alert ${id} cleared`;
}

/**
 * Stores by status, orders awaiting payment and paid but not delivered,
 * webhooks queued per store, open alerts by kind (`rail_unavailable` and the
 * rest name what the RPCs and relays refused). Read-only.
 */
async function stats(deps: CliDeps, now: number): Promise<string> {
  const byStatus = await deps.db.query<{ status: StoreStatus; stores: number }>(
    'select status, count(*)::int as stores from stores group by status',
  );
  const ledgers = await deps.db.query<{ owner: string; state: string }>(
    'select owner, state from ledgers order by owner',
  );
  const alerts = await deps.db.query<{ kind: string; alerts: number }>(
    `select kind, count(*)::int as alerts from alerts where cleared_at is null
     group by kind order by kind`,
  );
  let awaiting = 0;
  let undelivered = 0;
  const backlog: { owner: string; queued: number }[] = [];
  const unreadable: string[] = [];
  for (const row of ledgers) {
    let orders: MerchantOrder[];
    try {
      const state = parseLedger(row.state, row.owner);
      awaiting += openOrders(state, now, UNPAID_ORDER_LIFETIME_SECS).length;
      undelivered += undeliveredOrders(state).length;
      orders = Object.values(state.orders ?? {});
    } catch {
      unreadable.push(row.owner);
      continue;
    }
    const queued = orders.filter((order) => order.webhook?.state === 'pending').length;
    if (queued > 0) {
      backlog.push({ owner: row.owner, queued });
    }
  }
  const total = byStatus.reduce((sum, row) => sum + row.stores, 0);
  const lines = [`stores: ${total}`];
  for (const status of STATUSES) {
    lines.push(`  ${status} ${byStatus.find((row) => row.status === status)?.stores ?? 0}`);
  }
  lines.push(`orders awaiting payment: ${awaiting}`);
  lines.push(`orders paid, not delivered: ${undelivered}`);
  lines.push(`webhook backlog: ${backlog.reduce((sum, entry) => sum + entry.queued, 0)}`);
  for (const entry of backlog) {
    lines.push(`  ${npub(entry.owner)} ${entry.queued}`);
  }
  lines.push(`open alerts: ${alerts.reduce((sum, row) => sum + row.alerts, 0)}`);
  for (const row of alerts) {
    lines.push(`  ${printable(row.kind)} ${row.alerts}`);
  }
  if (unreadable.length > 0) {
    lines.push(`unreadable ledgers: ${unreadable.length}`);
    for (const owner of unreadable) {
      lines.push(`  ${npub(owner)}`);
    }
  }
  return lines.join('\n');
}

async function importCommand(
  args: readonly string[],
  deps: CliDeps,
  now: () => number,
): Promise<string> {
  const [home, ...rest] = args;
  if (home === undefined || home.startsWith('--')) {
    throw new UsageError('import needs the home directory');
  }
  const given = flags(rest, ['tier', 'webhook-secret-file'], ['node-stopped']);
  const tier = valueOf(given, 'tier');
  if (tier === undefined) {
    throw new UsageError('import needs --tier <name>');
  }
  if (deps.readRelays === undefined) {
    throw new CliFailure('import needs the relays: not wired in this process');
  }
  const webhookSecretFile = valueOf(given, 'webhook-secret-file');
  try {
    const result = await importStore(
      {
        home,
        tier,
        nodeStopped: given.get('node-stopped') === true,
        ...(webhookSecretFile === undefined ? {} : { webhookSecretFile }),
      },
      {
        db: deps.db,
        vault: deps.vault,
        config: deps.config,
        readRelays: deps.readRelays,
        now,
        ...(deps.env === undefined ? {} : { env: deps.env }),
      },
    );
    return [
      `${npub(result.owner)} imported, active on tier ${result.tier}`,
      `store key ${result.storePubkey}`,
      `${result.products} product${result.products === 1 ? '' : 's'}, ${result.orders} order${result.orders === 1 ? '' : 's'}, webhook secret ${result.webhookSecret ? 'sealed' : 'none'}`,
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join('\n');
  } catch (error) {
    if (error instanceof ImportRefused) {
      // Line by line: a refusal lists its problems one per line.
      const text = error.message.split('\n').map(printable).join('\n');
      throw new CliFailure(`import refused: ${text}`);
    }
    throw error;
  }
}

async function dispatch(argv: readonly string[], deps: CliDeps, now: () => number) {
  const [group, command, subject, ...rest] = argv;
  if (group === 'stats' && argv.length === 1) {
    return stats(deps, now());
  }
  if (group === 'import') {
    return importCommand(argv.slice(1), deps, now);
  }
  if (group === 'store' && command === 'list' && argv.length === 2) {
    return storeList(deps);
  }
  if (group === 'store' && command === 'activate') {
    return storeActivate(argv.slice(2), deps, now());
  }
  if (group === 'store' && command === 'suspend') {
    return storeSuspend(argv.slice(2), deps, now);
  }
  if (group === 'store' && command === 'tier') {
    return storeTier(argv.slice(2), deps);
  }
  if (group === 'tier' && command === 'list' && argv.length === 2) {
    return tierList(deps);
  }
  if (group === 'tier' && command === 'set' && subject !== undefined) {
    return tierSet(subject, rest, deps);
  }
  if (group === 'tier' && command === 'delete' && subject !== undefined && rest.length === 0) {
    return tierDelete(subject, deps);
  }
  if (group === 'alert' && command === 'list') {
    return alertList(argv.slice(2), deps);
  }
  if (group === 'alert' && command === 'clear' && subject !== undefined && rest.length === 0) {
    return alertClear(subject, deps, now());
  }
  throw new UsageError('Unknown command');
}

/**
 * Run one operator command: its text goes to `stdout`; a refusal to `stderr`
 * with exit code 1, arguments matching no command with the usage and exit
 * code 2. Anything else thrown (the database down) propagates.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  try {
    deps.stdout(await dispatch(argv, deps, now));
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\n${CLI_USAGE}`);
      return EXIT_USAGE;
    }
    if (error instanceof CliFailure) {
      deps.stderr(error.message);
      return EXIT_FAILED;
    }
    throw error;
  }
}

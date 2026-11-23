import { nip19 } from 'nostr-tools';
import { generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { pendingRequests } from '../src/admin/requests';
import { raiseAlert } from '../src/alerts';
import { CLI_USAGE, type CliDeps, migratesFirst, parseOwner, runCli } from '../src/cli';
import type { PaycoreConfig } from '../src/config';
import type { Db } from '../src/db/db';
import { KeyVault } from '../src/db/keys';
import { freshDb } from './pglite-db';
import {
  MASTER_KEY,
  NOW,
  PRODUCT,
  RELAY,
  RPCS,
  activate,
  directoryFor,
  ownerKeys,
} from './stores-fixtures';

const CONFIG: PaycoreConfig = {
  databaseUrl: 'postgres://unused',
  masterKeyHex: MASTER_KEY,
  publicBase: 'https://paycore.example',
  port: 8790,
  trustProxy: false,
  inboxRelays: [RELAY],
  operator: 'paycore.example',
  rpcs: RPCS,
};

interface Run {
  code: number;
  out: string;
  err: string;
}

function deps(db: Db, out: string[], err: string[]): CliDeps {
  return {
    db,
    vault: new KeyVault(MASTER_KEY),
    config: CONFIG,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => NOW,
  };
}

async function run(db: Db, ...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, deps(db, out, err));
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function pendingStore(db: Db): Promise<string> {
  const owner = ownerKeys().pubkey;
  await directoryFor(db).createStore(owner, { name: 'Shop', network: 'devnet' });
  return owner;
}

async function statusOf(db: Db, owner: string) {
  const [row] = await db.query<{ status: string; tier: string | null }>(
    'select status, tier from stores where owner = $1',
    [owner],
  );
  return row;
}

function npub(owner: string): string {
  return nip19.npubEncode(owner);
}

function usage(message: string): Run {
  return { code: 2, out: '', err: `${message}\n${CLI_USAGE}` };
}

function failed(message: string): Run {
  return { code: 1, out: '', err: message };
}

function ok(out: string): Run {
  return { code: 0, out, err: '' };
}

describe('operator CLI (step 16)', () => {
  it('reads an owner as npub or hex only; stats alone skips the migrations', () => {
    const owner = ownerKeys().pubkey;
    expect(parseOwner(owner)).toBe(owner);
    expect(parseOwner(npub(owner))).toBe(owner);
    expect(parseOwner(owner.toUpperCase())).toBeUndefined();
    expect(parseOwner(nip19.nsecEncode(generateSecretKey()))).toBeUndefined();
    expect(parseOwner('nope')).toBeUndefined();
    expect(migratesFirst(['stats'])).toBe(false);
    expect(migratesFirst(['store', 'list'])).toBe(true);
    expect(migratesFirst([])).toBe(true);
  });

  it('answers an unknown command or argument with the usage', async () => {
    const db = await freshDb();
    expect(await run(db)).toEqual(usage('Unknown command'));
    expect(await run(db, 'store')).toEqual(usage('Unknown command'));
    expect(await run(db, 'store', 'list', 'extra')).toEqual(usage('Unknown command'));
    expect(await run(db, 'stats', '--json')).toEqual(usage('Unknown command'));
    expect(await run(db, 'tier', 'set', 'basic')).toEqual(
      usage('tier set needs --max-products <n>'),
    );
    expect(await run(db, 'tier', 'set', 'basic', '--max-products')).toEqual(
      usage('--max-products needs a value'),
    );
    expect(
      await run(db, 'tier', 'set', 'basic', '--max-products', '3', '--max-products', '4'),
    ).toEqual(usage('--max-products is given twice'));
    expect(await run(db, 'alert', 'list', '--kind', 'drift')).toEqual(
      usage('Unknown argument --kind'),
    );
    expect(await run(db, 'import')).toEqual(usage('import needs the home directory'));
    expect(await run(db, 'import', '/tmp/home', '--node-stopped')).toEqual(
      usage('import needs --tier <name>'),
    );
    expect(
      await run(db, 'import', '/tmp/home', '--tier', 'basic', '--node-stopped', 'yes'),
    ).toEqual(usage('Unknown argument yes'));
  });

  it('never takes a flag as the value of another, and refuses extra arguments', async () => {
    const db = await freshDb();
    await run(db, 'tier', 'set', 'basic', '--max-products', '20');
    const owner = await pendingStore(db);
    await run(db, 'store', 'activate', owner, '--tier', 'basic');
    expect(await run(db, 'tier', 'set', 'basic', '--max-products', '--max-products')).toEqual(
      usage('--max-products needs a value'),
    );
    expect(await run(db, 'store', 'activate', owner, '--tier', '--tier')).toEqual(
      usage('--tier needs a value'),
    );
    expect(await run(db, 'store', 'tier', owner, '--basic')).toEqual(
      usage('store tier needs the store and the tier name'),
    );
    expect(await run(db, 'import', '--tier', 'basic', '--node-stopped')).toEqual(
      usage('import needs the home directory'),
    );
    expect(await run(db, 'tier', 'delete', 'basic', 'extra')).toEqual(usage('Unknown command'));
    await raiseAlert(db, owner, 'drift', 'x', { now: NOW, log: () => undefined });
    const [alert] = await db.query<{ id: number }>('select id from alerts');
    expect(await run(db, 'alert', 'clear', String(alert?.id), 'extra')).toEqual(
      usage('Unknown command'),
    );
    expect(await statusOf(db, owner)).toEqual({ status: 'active', tier: 'basic' });
    expect(await run(db, 'tier', 'list')).toEqual(ok('basic: 1 store, --max-products 20'));
    expect(await run(db, 'alert', 'list')).toEqual(
      ok(
        `${alert?.id} ${npub(owner)} drift x1 ${new Date(NOW * 1000).toISOString().replace('.000Z', 'Z')} x`,
      ),
    );
  });

  it('refuses import without --node-stopped before reading the home or the relays', async () => {
    const db = await freshDb();
    await run(db, 'tier', 'set', 'basic', '--max-products', '20');
    let reads = 0;
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['import', '/nonexistent/paycore-home', '--tier', 'basic'], {
      ...deps(db, out, err),
      readRelays: async () => {
        reads += 1;
        return undefined;
      },
    });
    expect({ code, out, err }).toEqual({
      code: 1,
      out: [],
      err: [
        'import refused: stop the self-host node first and say so with --node-stopped: two nodes on one store send every reply and webhook twice',
      ],
    });
    expect(reads).toBe(0);
  });

  it('import needs the relays wired', async () => {
    const db = await freshDb();
    expect(await run(db, 'import', '/tmp/home', '--tier', 'basic', '--node-stopped')).toEqual(
      failed('import needs the relays: not wired in this process'),
    );
  });

  it('lists tiers, saves and updates one, refuses bad input', async () => {
    const db = await freshDb();
    expect(await run(db, 'tier', 'list')).toEqual(ok('No tiers yet: add one with tier set'));
    expect(await run(db, 'tier', 'set', 'basic', '--max-products', '20')).toEqual(
      ok('tier basic saved'),
    );
    expect(await run(db, 'tier', 'set', 'pro', '--max-products', '500')).toEqual(
      ok('tier pro saved'),
    );
    expect(await run(db, 'tier', 'set', 'basic', '--max-products', '25')).toEqual(
      ok('tier basic saved'),
    );
    const owner = await pendingStore(db);
    await run(db, 'store', 'activate', owner, '--tier', 'basic');
    expect(await run(db, 'tier', 'list')).toEqual(
      ok('basic: 1 store, --max-products 25\npro: 0 stores, --max-products 500'),
    );
    expect(await run(db, 'tier', 'set', 'Basic', '--max-products', '3')).toEqual(
      failed('A tier name is 1 to 32 of a-z, 0-9 and -'),
    );
    for (const bad of ['0', '-1', '1.5', 'ten', '1234567890']) {
      expect(await run(db, 'tier', 'set', 'basic', '--max-products', bad)).toEqual(
        failed('--max-products must be a positive integer'),
      );
    }
  });

  it('deletes a tier only when no store is on it', async () => {
    const db = await freshDb();
    await run(db, 'tier', 'set', 'basic', '--max-products', '20');
    await run(db, 'tier', 'set', 'empty', '--max-products', '1');
    const owner = await pendingStore(db);
    await run(db, 'store', 'activate', owner, '--tier', 'basic');
    expect(await run(db, 'tier', 'delete', 'basic')).toEqual(
      failed(`Tier basic has 1 store; move each to another tier first:\n  ${npub(owner)}`),
    );
    expect(await run(db, 'tier', 'delete', 'gold')).toEqual(failed('No such tier: gold'));
    expect(await run(db, 'tier', 'delete', 'empty')).toEqual(ok('tier empty deleted'));
    expect(await run(db, 'tier', 'list')).toEqual(ok('basic: 1 store, --max-products 20'));
  });

  it('refuses to lower a cap below the products a store on the tier has on sale', async () => {
    const db = await freshDb();
    await run(db, 'tier', 'set', 'basic', '--max-products', '5');
    await run(db, 'tier', 'set', 'other', '--max-products', '5');
    const directory = directoryFor(db);
    const big = await pendingStore(db);
    const small = await pendingStore(db);
    const elsewhere = await pendingStore(db);
    await db.query('update stores set created_at = $2 where owner = $1', [small, NOW + 1]);
    for (const [owner, tier] of [
      [big, 'basic'],
      [small, 'basic'],
      [elsewhere, 'other'],
    ] as const) {
      await run(db, 'store', 'activate', owner, '--tier', tier);
    }
    for (const d of ['a', 'b', 'c']) {
      expect((await directory.putProduct(big, d, PRODUCT)).ok).toBe(true);
      expect((await directory.putProduct(elsewhere, d, PRODUCT)).ok).toBe(true);
    }
    // Off sale: not counted.
    expect((await directory.putProduct(big, 'd', { ...PRODUCT, onSale: false })).ok).toBe(true);
    expect((await directory.putProduct(small, 'a', PRODUCT)).ok).toBe(true);
    expect((await directory.putProduct(small, 'b', PRODUCT)).ok).toBe(true);
    expect(await run(db, 'tier', 'set', 'basic', '--max-products', '1')).toEqual(
      failed(
        `Tier basic has 2 stores with more than 1 products on sale; each merchant stops selling the excess first (or move the store to another tier):\n  ${npub(big)} 3 on sale\n  ${npub(small)} 2 on sale`,
      ),
    );
    expect(await run(db, 'tier', 'set', 'basic', '--max-products', '2')).toEqual(
      failed(
        `Tier basic has 1 store with more than 2 products on sale; each merchant stops selling the excess first (or move the store to another tier):\n  ${npub(big)} 3 on sale`,
      ),
    );
    expect(await run(db, 'tier', 'list')).toEqual(
      ok('basic: 2 stores, --max-products 5\nother: 1 store, --max-products 5'),
    );
    // Exactly at the cap is fine; another tier's stores do not count.
    expect(await run(db, 'tier', 'set', 'basic', '--max-products', '3')).toEqual(
      ok('tier basic saved'),
    );
    expect(await run(db, 'tier', 'list')).toEqual(
      ok('basic: 2 stores, --max-products 3\nother: 1 store, --max-products 5'),
    );
  });

  it('lists stores with status, tier, open alerts and reason', async () => {
    const db = await freshDb();
    expect(await run(db, 'store', 'list')).toEqual(ok('No stores yet'));
    const pending = await pendingStore(db);
    const halted = await pendingStore(db);
    await activate(db, halted, 5, 'halted');
    await db.query('update stores set status_reason = $2, created_at = $3 where owner = $1', [
      halted,
      'start refused: \u001b[2Jprices',
      NOW + 1,
    ]);
    await raiseAlert(db, halted, 'start_refused', 'prices', { now: NOW, log: () => undefined });
    await raiseAlert(db, halted, 'drift', 'a 10133', { now: NOW, log: () => undefined });
    await raiseAlert(db, undefined, 'boot', 'server-wide', { now: NOW, log: () => undefined });
    await db.query("update alerts set cleared_at = $1 where kind = 'drift'", [NOW]);
    expect(await run(db, 'store', 'list')).toEqual(
      ok(
        [
          `${npub(pending)} pending - alerts:0`,
          `${npub(halted)} halted tier-5 alerts:1 start refused: ?[2Jprices`,
        ].join('\n'),
      ),
    );
  });

  it('activates a pending store on a tier and queues its setup', async () => {
    const db = await freshDb();
    await run(db, 'tier', 'set', 'basic', '--max-products', '20');
    const owner = await pendingStore(db);
    expect(await run(db, 'store', 'activate', owner)).toEqual(
      usage('activate needs --tier <name>'),
    );
    expect(await run(db, 'store', 'activate', 'nope', '--tier', 'basic')).toEqual(
      failed('Give the store as its owner npub or hex key'),
    );
    expect(await run(db, 'store', 'activate', ownerKeys().pubkey, '--tier', 'basic')).toEqual(
      failed('No such store'),
    );
    expect(await run(db, 'store', 'activate', owner, '--tier', 'gold')).toEqual(
      failed('No such tier: gold'),
    );
    expect(await statusOf(db, owner)).toEqual({ status: 'pending', tier: null });
    const result = await run(db, 'store', 'activate', npub(owner), '--tier', 'basic');
    const [request] = await pendingRequests(db, owner);
    expect(request?.kind).toBe('setup');
    expect(result).toEqual(
      ok(`${npub(owner)} is active on tier basic (setup request ${request?.id})`),
    );
    expect(await statusOf(db, owner)).toEqual({ status: 'active', tier: 'basic' });
    expect(await run(db, 'store', 'activate', owner, '--tier', 'basic')).toEqual(
      failed('This store is active: only a pending store is activated'),
    );
  });

  it('queues a suspension for a served store, once', async () => {
    const db = await freshDb();
    const owner = await pendingStore(db);
    expect(await run(db, 'store', 'suspend', owner)).toEqual(
      failed('This store is pending: it is not served, so there is nothing to suspend'),
    );
    expect(await run(db, 'store', 'suspend', ownerKeys().pubkey)).toEqual(failed('No such store'));
    expect(await run(db, 'store', 'suspend', owner, '--tier', 'x')).toEqual(
      usage('Unknown argument --tier'),
    );
    await activate(db, owner);
    const first = await run(db, 'store', 'suspend', owner);
    const requests = await pendingRequests(db, owner);
    expect(requests.map((request) => request.kind)).toEqual(['suspend']);
    const done = `${npub(owner)}: suspension queued (request ${requests[0]?.id}); its listings sell out, then it stops once its open orders can no longer be paid`;
    expect(first).toEqual(ok(done));
    // A second suspend answers with the request already queued.
    expect(await run(db, 'store', 'suspend', owner)).toEqual(ok(done));
    expect((await pendingRequests(db, owner)).length).toBe(1);
    await db.query("update stores set status = 'suspending' where owner = $1", [owner]);
    expect(await run(db, 'store', 'suspend', owner)).toEqual(
      failed('This store is already suspended or being suspended'),
    );
  });

  it('moves a served store to another tier, refused past the new cap', async () => {
    const db = await freshDb();
    await run(db, 'tier', 'set', 'small', '--max-products', '1');
    await run(db, 'tier', 'set', 'big', '--max-products', '3');
    const owner = await pendingStore(db);
    expect(await run(db, 'store', 'tier', owner, 'big')).toEqual(
      failed(
        'This store is pending: only an active, degraded or halted store moves to another tier (a pending store gets its tier at store activate)',
      ),
    );
    await run(db, 'store', 'activate', owner, '--tier', 'big');
    const directory = directoryFor(db);
    for (const d of ['a', 'b']) {
      expect((await directory.putProduct(owner, d, PRODUCT)).ok).toBe(true);
    }
    expect((await directory.putProduct(owner, 'c', { ...PRODUCT, onSale: false })).ok).toBe(true);
    expect(await run(db, 'store', 'tier', owner)).toEqual(
      usage('store tier needs the store and the tier name'),
    );
    expect(await run(db, 'store', 'tier', owner, 'big', 'extra')).toEqual(
      usage('Unknown argument extra'),
    );
    expect(await run(db, 'store', 'tier', 'nope', 'big')).toEqual(
      failed('Give the store as its owner npub or hex key'),
    );
    expect(await run(db, 'store', 'tier', ownerKeys().pubkey, 'big')).toEqual(
      failed('No such store'),
    );
    expect(await run(db, 'store', 'tier', owner, 'gold')).toEqual(failed('No such tier: gold'));
    expect(await run(db, 'store', 'tier', owner, 'big')).toEqual(
      ok(`${npub(owner)} is already on tier big`),
    );
    // Two on sale (the third is not): over the cap of 1.
    expect(await run(db, 'store', 'tier', owner, 'small')).toEqual(
      failed(
        'This store has 2 products on sale; tier small allows 1: the merchant stops selling 1 first',
      ),
    );
    expect(await statusOf(db, owner)).toEqual({ status: 'active', tier: 'big' });
    await run(db, 'tier', 'set', 'two', '--max-products', '2');
    await db.query("update stores set status = 'halted' where owner = $1", [owner]);
    expect(await run(db, 'store', 'tier', npub(owner), 'two')).toEqual(
      ok(`${npub(owner)} moved from tier big to two (2 of 2 products on sale)`),
    );
    expect(await statusOf(db, owner)).toEqual({ status: 'halted', tier: 'two' });
    // The new cap holds for the next product put on sale.
    expect((await directory.putProduct(owner, 'c', PRODUCT)).ok).toBe(false);
    for (const status of ['suspending', 'suspended']) {
      await db.query('update stores set status = $2 where owner = $1', [owner, status]);
      expect(await run(db, 'store', 'tier', owner, 'big')).toEqual(
        failed(
          `This store is ${status}: only an active, degraded or halted store moves to another tier`,
        ),
      );
    }
    expect(await statusOf(db, owner)).toEqual({ status: 'suspended', tier: 'two' });
  });

  it('lists open alerts, by store too, and clears one', async () => {
    const db = await freshDb();
    expect(await run(db, 'alert', 'list')).toEqual(ok('No open alerts'));
    const owner = await pendingStore(db);
    const other = await pendingStore(db);
    const log = () => undefined;
    await raiseAlert(db, undefined, 'boot', 'rpc \u0007down', { now: NOW, log });
    await raiseAlert(db, owner, 'drift', 'a 10133 we never made', { now: NOW, log });
    await raiseAlert(db, owner, 'drift', 'a 10133 we never made', { now: NOW + 60, log });
    await raiseAlert(db, other, 'rail_unavailable', 'no RPC for base-devnet', { now: NOW, log });
    const ids = await db.query<{ id: number; kind: string }>(
      'select id, kind from alerts order by id',
    );
    const idOf = (kind: string) => ids.find((row) => row.kind === kind)?.id;
    const at = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
    const serverLine = `${idOf('boot')} server boot x1 ${at(NOW)} rpc ?down`;
    const driftLine = `${idOf('drift')} ${npub(owner)} drift x2 ${at(NOW + 60)} a 10133 we never made`;
    const railLine = `${idOf('rail_unavailable')} ${npub(other)} rail_unavailable x1 ${at(NOW)} no RPC for base-devnet`;
    expect(await run(db, 'alert', 'list')).toEqual(
      ok([serverLine, driftLine, railLine].join('\n')),
    );
    expect(await run(db, 'alert', 'list', '--owner', npub(owner))).toEqual(ok(driftLine));
    expect(await run(db, 'alert', 'list', '--owner', 'nope')).toEqual(
      failed('Give the store as its owner npub or hex key'),
    );
    expect(await run(db, 'alert', 'clear', String(idOf('drift')))).toEqual(
      ok(`alert ${idOf('drift')} cleared`),
    );
    expect(await run(db, 'alert', 'clear', String(idOf('drift')))).toEqual(
      failed(`No open alert ${idOf('drift')}`),
    );
    expect(await run(db, 'alert', 'clear', 'x')).toEqual(
      failed('An alert id is a positive integer (see alert list)'),
    );
    expect(await run(db, 'alert', 'list')).toEqual(ok([serverLine, railLine].join('\n')));
    // A kind is printed as safely as a message.
    await raiseAlert(db, other, 'drift\u001b[2J', 'm', { now: NOW, log });
    const escaped = await db.query<{ id: number }>(
      "select id from alerts where kind like 'drift_%'",
    );
    expect(await run(db, 'alert', 'list', '--owner', other)).toEqual(
      ok([railLine, `${escaped[0]?.id} ${npub(other)} drift?[2J x1 ${at(NOW)} m`].join('\n')),
    );
    const [cleared] = await db.query<{ cleared_at: number | null }>(
      'select cleared_at from alerts where id = $1',
      [idOf('drift')],
    );
    expect(cleared?.cleared_at).toBe(NOW);
  });

  it('stats: stores by status, orders, webhook backlog per store, open alerts by kind', async () => {
    const db = await freshDb();
    expect(await run(db, 'stats')).toEqual(
      ok(
        [
          'stores: 0',
          '  pending 0',
          '  active 0',
          '  degraded 0',
          '  halted 0',
          '  suspending 0',
          '  suspended 0',
          'orders awaiting payment: 0',
          'orders paid, not delivered: 0',
          'webhook backlog: 0',
          'open alerts: 0',
        ].join('\n'),
      ),
    );
    const busy = await pendingStore(db);
    const quiet = await pendingStore(db);
    const broken = await pendingStore(db);
    await pendingStore(db);
    await activate(db, busy);
    await activate(db, quiet, 2, 'degraded');
    await activate(db, broken, 2, 'halted');
    const paid = { signature: 'tx', amount: '1', blockTime: NOW, caip19: 'c', medium: 'm' };
    const ledger = {
      version: 5,
      orders: {
        unpaid: { createdAt: NOW - 60, reportedTxs: [] },
        expired: { createdAt: NOW - 30 * 24 * 3600, reportedTxs: [] },
        queued: { createdAt: NOW - 60, paid, webhook: { state: 'pending' } },
        queued2: { createdAt: NOW - 60, paid, deliveredAt: NOW, webhook: { state: 'pending' } },
        sent: { createdAt: NOW - 60, paid, deliveredAt: NOW, webhook: { state: 'sent' } },
      },
    };
    await db.query('update ledgers set state = $2 where owner = $1', [
      busy,
      JSON.stringify(ledger),
    ]);
    await db.query('update ledgers set state = $2 where owner = $1', [broken, 'not json']);
    const log = () => undefined;
    await raiseAlert(db, quiet, 'drift', 'x', { now: NOW, log });
    await raiseAlert(db, broken, 'rail_unavailable', 'x', { now: NOW, log });
    await raiseAlert(db, quiet, 'rail_unavailable', 'x', { now: NOW, log });
    await raiseAlert(db, undefined, 'setup_failed', 'x', { now: NOW, log });
    await raiseAlert(db, undefined, 'zz\u0007', 'x', { now: NOW, log });
    await db.query("update alerts set cleared_at = $1 where kind = 'setup_failed'", [NOW]);
    expect(await run(db, 'stats')).toEqual(
      ok(
        [
          'stores: 4',
          '  pending 1',
          '  active 1',
          '  degraded 1',
          '  halted 1',
          '  suspending 0',
          '  suspended 0',
          'orders awaiting payment: 1',
          'orders paid, not delivered: 1',
          'webhook backlog: 2',
          `  ${npub(busy)} 2`,
          'open alerts: 4',
          '  drift 1',
          '  rail_unavailable 2',
          '  zz? 1',
          'unreadable ledgers: 1',
          `  ${npub(broken)}`,
        ].join('\n'),
      ),
    );
  });
});

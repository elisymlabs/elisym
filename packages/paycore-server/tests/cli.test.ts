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
import { MASTER_KEY, NOW, RELAY, RPCS, activate, directoryFor, ownerKeys } from './stores-fixtures';

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
          'open alerts: 3',
          '  drift 1',
          '  rail_unavailable 2',
          'unreadable ledgers: 1',
          `  ${npub(broken)}`,
        ].join('\n'),
      ),
    );
  });
});

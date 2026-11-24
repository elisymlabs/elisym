import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import { verifyWebhook } from '@elisym/commerce/webhook';
import { newest } from '@merchant-node/checks';
import { OFFER_RELAYS } from '@merchant-node/constants';
import { openSecret } from '@merchant-node/keys';
import {
  type LedgerState,
  PRE_FEE_LEDGER_VERSION,
  emptyLedger,
  loadLedger,
  recordPayment,
} from '@merchant-node/ledger';
import { encryptSecret } from '@merchant-node/secret-box';
import { runSetupPass } from '@merchant-node/setup-ledger';
import { buildStoreSignedEvents, ownerEventTemplates } from '@merchant-node/store-events';
import { orderPaidBody, sendWebhook } from '@merchant-node/webhook';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CliDeps, runCli } from '../src/cli';
import type { PaycoreConfig } from '../src/config';
import type { Db } from '../src/db/db';
import { type ImportDeps, ImportRefused, type NewestOnRelays, importStore } from '../src/import';
import { healPass } from '../src/node/holder-requests';
import { loadStoreBundle } from '../src/node/load';
import { prepareOwnerEvent } from '../src/owner-events';
import { newHolderId } from '../src/state/leases';
import { PgLedgerStore } from '../src/state/ledger-store';
import {
  BASE_DEVNET_CAIP19,
  D,
  TEMPO_DEVNET_CAIP19,
  TEMPO_PAYOUT,
  type Key,
  NOW,
  PAYOUT,
  PRICE,
  RELAY,
  SOLANA_RPC,
  USDC_DEVNET_CAIP19,
  key,
  lease,
  storedLedger,
  testSetupDeps,
  vault,
} from './helpers/node-store';
import { RelayWorld } from './helpers/node-world';
import { freshDb } from './pglite-db';
import { solanaWallet } from './stores-fixtures';

// The real `openSecret`, spied on: the tests see the store key buffer import opened.
vi.mock('@merchant-node/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@merchant-node/keys')>();
  return { ...actual, openSecret: vi.fn(actual.openSecret) };
});

const TIER = 'basic';
const PASSPHRASE = 'correct horse battery staple';
const WEBHOOK_URL = 'https://hooks.example.com/paid';
const WEBHOOK_SECRET = 's'.repeat(64);
const LSM_MAINNET_CAIP19 =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:86T4G3zJaBxQAuWAbfXggE5d5XEt4bns3Y41jgVLpump';
const SETUP_FIRST = 'run `elisym-merchant setup` on the self-host node first';
/** Where the owner's secret would be: never a key, so any read of it would fail the import. */
const OWNER_SECRET_GARBAGE = 'not-an-owner-key: import must never read this';
const CONFIG: Pick<PaycoreConfig, 'inboxRelays' | 'rpcs'> = {
  inboxRelays: [RELAY],
  rpcs: { mainnet: { evm: {} }, devnet: { solana: SOLANA_RPC, evm: {} } },
};
const FULL_CONFIG: PaycoreConfig = {
  databaseUrl: 'postgres://unused',
  masterKeyHex: '11'.repeat(32),
  publicBase: 'https://paycore.example',
  port: 8790,
  trustProxy: false,
  operator: 'paycore.example',
  requiredRelay: RELAY,
  ...CONFIG,
};

interface Payout {
  caip19: string;
  address: string;
  signature?: string;
}

interface HomeOptions {
  owner?: Key;
  payouts?: Payout[];
  /** config.json's payouts when they differ from the published ones. */
  configPayouts?: Payout[];
  inboxRelays?: string[];
  webhook?: boolean;
  sealStore?: boolean;
  /** Skip the setup pass: the ledger records no payout list. */
  noSetup?: boolean;
  /** Edit the ledger after the setup pass (a paid order, say). */
  editLedger?: (state: LedgerState, store: Key) => void;
}

interface Home {
  dir: string;
  owner: Key;
  store: Key;
  world: RelayWorld;
  ledger: LedgerState;
}

const HOMES: string[] = [];

afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A stopped self-host home, as `elisym-merchant init` + `setup` leave it: the
 * setup pass ran an hour ago and published to `world` (O's self-host 10133 and
 * 30490, S's profile, 10050 and listing), the ledger records it.
 */
async function selfHostHome(options: HomeOptions = {}): Promise<Home> {
  const dir = mkdtempSync(join(tmpdir(), 'paycore-import-'));
  HOMES.push(dir);
  const owner = options.owner ?? key();
  const store = key();
  const world = new RelayWorld();
  const payouts = options.payouts ?? [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }];
  const inboxRelays = options.inboxRelays ?? [RELAY];
  const config = {
    name: 'Shop',
    network: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    inboxRelays,
    payouts: options.configPayouts ?? payouts,
    ...(options.webhook === true ? { webhook: { url: WEBHOOK_URL } } : {}),
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const storeHex = bytesToHex(store.secretKey);
  writeFileSync(
    join(dir, 'keys.json'),
    JSON.stringify({
      store: options.sealStore === true ? encryptSecret(storeHex, PASSPHRASE) : storeHex,
      owner: OWNER_SECRET_GARBAGE,
      storePubkey: store.pubkey,
      ownerPubkey: owner.pubkey,
    }),
  );
  mkdirSync(join(dir, 'products', D), { recursive: true });
  writeFileSync(
    join(dir, 'products', D, 'PRODUCT.md'),
    '---\ntitle: Course\npriceUsd: "1"\n---\nA course.\n',
  );
  const state = emptyLedger();
  if (options.noSetup !== true) {
    const at = NOW - 3600;
    await runSetupPass(state, {
      pool: world.pool(),
      relays: [...new Set([...OFFER_RELAYS, ...inboxRelays])],
      defaultRelays: OFFER_RELAYS,
      pubkeys: { storePubkey: store.pubkey, ownerPubkey: owner.pubkey },
      products: new Map([
        [
          D,
          {
            d: D,
            title: 'Course',
            description: 'A course.',
            priceUsd: '1',
            onSale: true,
            file: `products/${D}`,
          },
        ],
      ]),
      payouts,
      payoutsString: JSON.stringify(payouts),
      storeSecretKey: store.secretKey,
      sign: ({ startedAt, paytoCreatedAt }) => {
        const owned = ownerEventTemplates(
          { payouts },
          owner.pubkey,
          store.pubkey,
          paytoCreatedAt,
          startedAt,
          { mode: 'self-host' },
        );
        return {
          payoutList: finalizeEvent(owned.payoutList, owner.secretKey),
          others: [
            ...buildStoreSignedEvents(
              { name: 'Shop', inboxRelays },
              store.secretKey,
              owner.pubkey,
              startedAt,
              true,
            ),
            finalizeEvent(owned.authorization, owner.secretKey),
          ],
        };
      },
      publish: async (event) => {
        world.add(event);
        return true;
      },
      now: () => at,
    });
  }
  options.editLedger?.(state, store);
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify(state, null, 2));
  return { dir, owner, store, world, ledger: state };
}

/** The relays as `relay/newest.ts` reads them, over `world`. */
function relaysOf(world: RelayWorld): NewestOnRelays & { reads: number } {
  const read = Object.assign(
    async (owner: string, kind: number, options: { d?: string }) => {
      read.reads += 1;
      return newest(
        world.events.filter(
          (event) =>
            event.pubkey === owner &&
            event.kind === kind &&
            (options.d === undefined ||
              event.tags.some((tag) => tag[0] === 'd' && tag[1] === options.d)),
        ),
      );
    },
    { reads: 0 },
  );
  return read;
}

/** Rewrite the home's config.json: the fixture's, with `changes` over it. */
function writeConfig(home: Home, changes: Record<string, unknown>): void {
  writeFileSync(
    join(home.dir, 'config.json'),
    JSON.stringify({
      name: 'Shop',
      network: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      inboxRelays: [RELAY],
      payouts: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }],
      ...changes,
    }),
  );
}

function writeProduct(home: Home, d: string, frontmatter: string, body = 'A product.'): void {
  mkdirSync(join(home.dir, 'products', d), { recursive: true });
  writeFileSync(join(home.dir, 'products', d, 'PRODUCT.md'), `---\n${frontmatter}\n---\n${body}\n`);
}

/** The relays' own events of the fixture: its 10133 and its 30490 at d = S. */
async function servedEvents(
  home: Home,
): Promise<{ payoutList: NostrEvent; authorization: NostrEvent }> {
  const relays = relaysOf(home.world);
  const payoutList = await relays(home.owner.pubkey, KIND_PAYTO, {});
  const authorization = await relays(home.owner.pubkey, KIND_STORE_AUTH, { d: home.store.pubkey });
  if (payoutList === undefined || authorization === undefined) {
    throw new Error('the fixture published no owner events');
  }
  return { payoutList, authorization };
}

/** `event` re-signed by `signer`, its kind possibly changed: every other field kept. */
function resigned(event: NostrEvent, signer: Key, kind = event.kind): NostrEvent {
  return finalizeEvent(
    { kind, created_at: event.created_at, tags: event.tags, content: event.content },
    signer.secretKey,
  );
}

async function nothingWritten(db: Db): Promise<void> {
  const [row] = await db.query<{ rows: number }>(
    `select (select count(*) from stores) + (select count(*) from store_keys)
       + (select count(*) from store_config) + (select count(*) from products)
       + (select count(*) from ledgers) + (select count(*) from owner_events) as rows`,
  );
  expect(Number(row?.rows)).toBe(0);
}

async function withTier(db: Db, maxProducts = 10): Promise<void> {
  await db.query('insert into tiers (name, max_products) values ($1, $2)', [TIER, maxProducts]);
}

function importDeps(db: Db, home: Home, overrides: Partial<ImportDeps> = {}): ImportDeps {
  return {
    db,
    vault: vault(),
    config: CONFIG,
    readRelays: relaysOf(home.world),
    now: () => NOW,
    env: {},
    ...overrides,
  };
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ImportRefused) {
      return error.message;
    }
    throw error;
  }
  throw new Error('the import was not refused');
}

async function storeCount(db: Db): Promise<number> {
  const [row] = await db.query<{ stores: number }>('select count(*)::int as stores from stores');
  return row?.stores ?? 0;
}

function cliDeps(db: Db, home: Home, out: string[], err: string[]): CliDeps {
  return {
    db,
    vault: vault(),
    config: FULL_CONFIG,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => NOW,
    readRelays: relaysOf(home.world),
    env: {},
  };
}

describe('import (step 17)', () => {
  it("makes the store active at once on the relays' O-signed events, the owner key never read", async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['import', home.dir, '--tier', TIER, '--node-stopped'],
      cliDeps(db, home, out, err),
    );
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out[0]?.split('\n').slice(0, 3)).toEqual([
      expect.stringMatching(/^npub1[0-9a-z]+ imported, active on tier basic$/),
      `store key ${home.store.pubkey}`,
      '1 product, 0 orders, webhook secret none',
    ]);
    const [store] = await db.query<Record<string, unknown>>(
      'select status, tier, plan_source, store_pubkey from stores where owner = $1',
      [home.owner.pubkey],
    );
    expect(store).toEqual({
      status: 'active',
      tier: TIER,
      plan_source: 'operator',
      store_pubkey: home.store.pubkey,
    });
    const recorded = home.ledger.payto;
    if (recorded === undefined) {
      throw new Error('the fixture recorded no payout list');
    }
    const events = await db.query<{
      id: string;
      kind: number;
      payouts_string: string | null;
      recorded: boolean;
      published_at: number | null;
    }>(
      `select id, kind, payouts_string, recorded, published_at from owner_events
       where owner = $1 order by kind`,
      [home.owner.pubkey],
    );
    const relays = relaysOf(home.world);
    const payoutList = await relays(home.owner.pubkey, KIND_PAYTO, {});
    const authorization = await relays(home.owner.pubkey, KIND_STORE_AUTH, {
      d: home.store.pubkey,
    });
    expect(events).toEqual([
      {
        id: payoutList?.id,
        kind: KIND_PAYTO,
        payouts_string: recorded.payouts,
        recorded: true,
        published_at: NOW,
      },
      {
        id: authorization?.id,
        kind: KIND_STORE_AUTH,
        payouts_string: null,
        recorded: true,
        published_at: NOW,
      },
    ]);
    // The loader runs the store on the imported rows: S opens, the active payouts are the ledger's.
    const holder = newHolderId();
    const [leased] = await lease(db, holder);
    const bundle = await loadStoreBundle(db, vault(), home.owner.pubkey, {
      holder,
      epoch: leased?.epoch ?? 0,
      rpcs: CONFIG.rpcs,
      inboxRelayAllowlist: CONFIG.inboxRelays,
      now: () => NOW,
    });
    expect(bundle.status).toBe('active');
    expect(bundle.storeSecretKey).toEqual(home.store.secretKey);
    expect(JSON.stringify(bundle.config.payouts)).toBe(recorded.payouts);
    expect(bundle.config.rpcUrl).toBe(SOLANA_RPC);
    expect([...bundle.products.keys()]).toEqual([D]);
    expect(bundle.committed.map((event) => [event.kind, event.recorded])).toEqual([
      [KIND_PAYTO, true],
      [KIND_STORE_AUTH, true],
    ]);
  });

  it('round-trips the ledger and fills the draft from config.json, its RPC URLs dropped', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome({ webhook: true });
    const secretFile = join(home.dir, 'webhook-secret');
    writeFileSync(secretFile, `${WEBHOOK_SECRET}\n`);
    const result = await importStore(
      { home: home.dir, tier: TIER, nodeStopped: true, webhookSecretFile: secretFile },
      importDeps(db, home),
    );
    expect(result).toMatchObject({ products: 1, orders: 0, webhookSecret: true, warnings: [] });
    expect(await storedLedger(db, home.owner.pubkey)).toEqual(
      loadLedger(join(home.dir, 'ledger.json')).state,
    );
    const [config] = await db.query<Record<string, unknown>>(
      `select name, network, draft_payouts as draft, evm_credit, webhook_url, inbox_relays,
         draft_inbox_relays from store_config where owner = $1`,
      [home.owner.pubkey],
    );
    expect(config).toEqual({
      name: 'Shop',
      network: 'devnet',
      draft: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }],
      evm_credit: 'fast',
      webhook_url: WEBHOOK_URL,
      inbox_relays: [RELAY],
      draft_inbox_relays: null,
    });
    expect(JSON.stringify(config)).not.toContain('api.devnet.solana.com');
  });

  it('opens a sealed store key with the passphrase, and refuses without it', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome({ sealStore: true });
    const options = { home: home.dir, tier: TIER, nodeStopped: true };
    expect(await refusal(importStore(options, importDeps(db, home)))).toContain(
      'encrypted store key',
    );
    expect(
      await refusal(
        importStore(
          options,
          importDeps(db, home, { env: { ELISYM_MERCHANT_PASSPHRASE: 'wrong' } }),
        ),
      ),
    ).toMatch(/^the store key: /);
    expect(await storeCount(db)).toBe(0);
    await importStore(
      options,
      importDeps(db, home, { env: { ELISYM_MERCHANT_PASSPHRASE: PASSPHRASE } }),
    );
    const bundle = await loadStoreBundle(db, vault(), home.owner.pubkey, {
      holder: 'h',
      epoch: 0,
      rpcs: CONFIG.rpcs,
      inboxRelayAllowlist: CONFIG.inboxRelays,
      now: () => NOW,
    });
    expect(bundle.storeSecretKey).toEqual(home.store.secretKey);
  });

  it('is refused without --node-stopped, before anything is read', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    const relays = relaysOf(home.world);
    const out: string[] = [];
    const err: string[] = [];
    const deps = { ...cliDeps(db, home, out, err), readRelays: relays };
    expect(await runCli(['import', home.dir, '--tier', TIER], deps)).toBe(1);
    expect(err).toEqual([
      'import refused: stop the self-host node first and say so with --node-stopped: two nodes on one store send every reply and webhook twice',
    ]);
    expect(out).toEqual([]);
    expect(relays.reads).toBe(0);
    expect(await storeCount(db)).toBe(0);
  });

  it('is refused while a running node holds the home (a fresh run.lock)', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    writeFileSync(join(home.dir, 'run.lock'), 'token');
    expect(
      await refusal(
        importStore({ home: home.dir, tier: TIER, nodeStopped: true }, importDeps(db, home)),
      ),
    ).toContain('a running merchant node holds');
    expect(await storeCount(db)).toBe(0);
  });

  it('is refused when the ledger records no payout list, or there is no ledger', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome({ noSetup: true });
    const options = { home: home.dir, tier: TIER, nodeStopped: true };
    expect(await refusal(importStore(options, importDeps(db, home)))).toBe(
      'the ledger records no published payout list: run `elisym-merchant setup` on the self-host node first',
    );
    rmSync(join(home.dir, 'ledger.json'));
    expect(await refusal(importStore(options, importDeps(db, home)))).toContain(
      'ledger.json does not exist: run `elisym-merchant setup`',
    );
    expect(await storeCount(db)).toBe(0);
  });

  it("is refused when the relays' newest payout list is not the one the ledger recorded", async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    const options = { home: home.dir, tier: TIER, nodeStopped: true };
    // Nothing served (or nothing could be read).
    expect(
      await refusal(
        importStore(options, importDeps(db, home, { readRelays: async () => undefined })),
      ),
    ).toBe(
      'the relays serve no payout list by this owner: run `elisym-merchant setup` on the self-host node first',
    );
    // O signed a newer list elsewhere, the ledger never recorded it.
    const recordedAt = home.ledger.payto?.createdAt ?? 0;
    const newer = finalizeEvent(
      ownerEventTemplates(
        { payouts: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }] },
        home.owner.pubkey,
        home.store.pubkey,
        recordedAt + 60,
        recordedAt + 60,
        { mode: 'self-host' },
      ).payoutList,
      home.owner.secretKey,
    );
    home.world.add(newer);
    expect(await refusal(importStore(options, importDeps(db, home)))).toBe(
      `the relays' newest payout list is dated ${recordedAt + 60}, the ledger recorded one dated ${recordedAt}: run \`elisym-merchant setup\` on the self-host node first`,
    );
    expect(await storeCount(db)).toBe(0);
  });

  it('zeroes the opened store key on a refusal after it was opened, and on an import', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    const options = { home: home.dir, tier: TIER, nodeStopped: true };
    const opened = vi.mocked(openSecret);
    const lastOpened = (): Uint8Array => {
      const result = opened.mock.results.at(-1);
      if (result?.type !== 'return') {
        throw new Error('no store key was opened');
      }
      return result.value;
    };
    const zeroed = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);
    opened.mockClear();
    expect(
      await refusal(
        importStore(options, importDeps(db, home, { readRelays: async () => undefined })),
      ),
    ).toContain('the relays serve no payout list by this owner');
    expect(opened).toHaveBeenCalledTimes(1);
    expect(lastOpened()).toHaveLength(32);
    expect(zeroed(lastOpened())).toBe(true);
    // A refusal right after the opening (R1), before any other read.
    await db.query(
      `insert into stores (owner, store_pubkey, status, tier, plan_source, created_at)
       values ($1, $2, 'pending', $3, 'operator', $4)`,
      [home.owner.pubkey, 'f'.repeat(64), TIER, NOW],
    );
    expect(await refusal(importStore(options, importDeps(db, home)))).toBe(
      'this owner already has a store on this server (one store per owner key)',
    );
    expect(opened).toHaveBeenCalledTimes(2);
    expect(zeroed(lastOpened())).toBe(true);
    await db.query('delete from stores');
    await importStore(options, importDeps(db, home));
    expect(opened).toHaveBeenCalledTimes(3);
    expect(zeroed(lastOpened())).toBe(true);
    expect(zeroed(home.store.secretKey)).toBe(false);
  });

  it('is refused when the same-dated payout list pays other payouts, or the 30490 is revoked', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    const options = { home: home.dir, tier: TIER, nodeStopped: true };
    const relays = relaysOf(home.world);
    const recordedAt = home.ledger.payto?.createdAt ?? 0;
    const other = finalizeEvent(
      ownerEventTemplates(
        { payouts: [{ caip19: USDC_DEVNET_CAIP19, address: solanaWallet().address }] },
        home.owner.pubkey,
        home.store.pubkey,
        recordedAt,
        recordedAt,
        { mode: 'self-host' },
      ).payoutList,
      home.owner.secretKey,
    );
    const swapped: NewestOnRelays = async (owner, kind, read) =>
      kind === KIND_PAYTO ? other : relays(owner, kind, read);
    expect(await refusal(importStore(options, importDeps(db, home, { readRelays: swapped })))).toBe(
      "the relays' newest payout list does not pay the payouts the ledger recorded: run `elisym-merchant setup` on the self-host node first",
    );
    const revoked: NostrEvent = finalizeEvent(
      {
        kind: KIND_STORE_AUTH,
        created_at: NOW,
        tags: [
          ['d', home.store.pubkey],
          ['p', home.store.pubkey],
          ['mode', 'revoked'],
        ],
        content: '',
      },
      home.owner.secretKey,
    );
    home.world.add(revoked);
    expect(await refusal(importStore(options, importDeps(db, home)))).toBe(
      "the owner's newest authorization of this store key is revoked: the store cannot take orders",
    );
    expect(await storeCount(db)).toBe(0);
  });

  it('is refused on inbox relays outside the allowlist, and on a webhook off port 443', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome({ inboxRelays: ['wss://nos.lol'] });
    const message = await refusal(
      importStore({ home: home.dir, tier: TIER, nodeStopped: true }, importDeps(db, home)),
    );
    expect(message).toContain('config.json is not usable here');
    expect(message).toContain('inboxRelays: wss://nos.lol is not a relay this server allows');
    const hooked = await selfHostHome();
    writeFileSync(
      join(hooked.dir, 'config.json'),
      JSON.stringify({
        name: 'Shop',
        network: 'devnet',
        rpcUrl: 'https://api.devnet.solana.com',
        inboxRelays: [RELAY],
        payouts: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }],
        webhook: { url: 'https://hooks.example.com:8443/paid' },
      }),
    );
    expect(
      await refusal(
        importStore({ home: hooked.dir, tier: TIER, nodeStopped: true }, importDeps(db, hooked)),
      ),
    ).toContain('webhook.url: ');
    expect(await storeCount(db)).toBe(0);
  });

  it('is refused for an owner that already has a store (R1), an unknown tier and a tier too small', async () => {
    const db = await freshDb();
    await withTier(db, 1);
    const home = await selfHostHome();
    expect(
      await refusal(
        importStore({ home: home.dir, tier: 'gold', nodeStopped: true }, importDeps(db, home)),
      ),
    ).toBe('no such tier: gold');
    await db.query("insert into tiers (name, max_products) values ('tiny', 1)");
    mkdirSync(join(home.dir, 'products', 'second'), { recursive: true });
    writeFileSync(
      join(home.dir, 'products', 'second', 'PRODUCT.md'),
      '---\ntitle: Second\npriceUsd: "2"\n---\nMore.\n',
    );
    expect(
      await refusal(
        importStore({ home: home.dir, tier: 'tiny', nodeStopped: true }, importDeps(db, home)),
      ),
    ).toBe('the store sells 2 products and tier tiny allows 1: pick a larger tier');
    rmSync(join(home.dir, 'products', 'second'), { recursive: true });
    await importStore({ home: home.dir, tier: TIER, nodeStopped: true }, importDeps(db, home));
    expect(
      await refusal(
        importStore({ home: home.dir, tier: TIER, nodeStopped: true }, importDeps(db, home)),
      ),
    ).toBe('this owner already has a store on this server (one store per owner key)');
    expect(await storeCount(db)).toBe(1);
  });

  it('signs a queued webhook entry with the imported secret', async () => {
    const db = await freshDb();
    await withTier(db);
    const buyer = key();
    const home = await selfHostHome({
      webhook: true,
      editLedger: (state, store) => {
        const order = {
          key: `${buyer.pubkey}:o-1`,
          buyerPubkey: buyer.pubkey,
          orderId: 'o-1',
          rumorId: 'f'.repeat(64),
          createdAt: NOW - 120,
          reference: 'r',
          product: `30402:${store.pubkey}:${D}`,
          reportedTxs: [],
        };
        recordPayment(
          order,
          {
            signature: 'tx-1',
            amount: PRICE.toString(),
            fee: '0',
            blockTime: NOW - 100,
            caip19: USDC_DEVNET_CAIP19,
            medium: 'solana-devnet',
          },
          { storePubkey: store.pubkey, now: () => NOW - 100 },
        );
        state.orders[order.key] = order;
      },
    });
    const secretFile = join(home.dir, 'webhook-secret');
    writeFileSync(secretFile, WEBHOOK_SECRET);
    await importStore(
      { home: home.dir, tier: TIER, nodeStopped: true, webhookSecretFile: secretFile },
      importDeps(db, home),
    );
    const state = await storedLedger(db, home.owner.pubkey);
    const order = Object.values(state.orders)[0];
    if (order?.webhook === undefined) {
      throw new Error('the imported order lost its webhook entry');
    }
    expect(order.webhook.state).toBe('pending');
    const bundle = await loadStoreBundle(db, vault(), home.owner.pubkey, {
      holder: 'h',
      epoch: 0,
      rpcs: CONFIG.rpcs,
      inboxRelayAllowlist: CONFIG.inboxRelays,
      now: () => NOW,
    });
    if (bundle.webhook === undefined) {
      throw new Error('the imported store has no webhook target');
    }
    expect(bundle.webhookSecretMissing).toBe(false);
    const sent: { headers: Record<string, string>; body: string }[] = [];
    const result = await sendWebhook(
      bundle.webhook,
      {
        name: 'order.paid',
        eventId: order.webhook.eventId,
        body: orderPaidBody(order, order.webhook, { storePubkey: home.store.pubkey }),
      },
      {
        now: () => NOW,
        userAgent: 'paycore-server/test',
        fetch: async (_url, init) => {
          sent.push({
            headers: init.headers as Record<string, string>,
            body: String(init.body),
          });
          return new Response(null, { status: 200 });
        },
      },
    );
    expect(result.ok).toBe(true);
    const [request] = sent;
    if (request === undefined) {
      throw new Error('nothing was sent');
    }
    const verified = await verifyWebhook({
      secret: WEBHOOK_SECRET,
      body: request.body,
      headers: request.headers,
      now: NOW,
    });
    expect(verified.ok).toBe(true);
    expect(
      (
        await verifyWebhook({
          secret: 'x'.repeat(64),
          body: request.body,
          headers: request.headers,
          now: NOW,
        })
      ).ok,
    ).toBe(false);
  });

  it('warns when the webhook has no secret file, or config.json payouts differ from the published list', async () => {
    const db = await freshDb();
    await withTier(db);
    const draftPayouts = [{ caip19: USDC_DEVNET_CAIP19, address: solanaWallet().address }];
    const home = await selfHostHome({ webhook: true, configPayouts: draftPayouts });
    const result = await importStore(
      { home: home.dir, tier: TIER, nodeStopped: true },
      importDeps(db, home),
    );
    expect(result.warnings).toEqual([
      "config.json's payouts differ from the published payout list: they are kept as the draft; the published list stays active until the merchant signs a new one",
      'the store has a webhook and no --webhook-secret-file: webhooks queue unsent (the store runs degraded) until the merchant sets a new secret',
    ]);
    // The active payouts stay the ledger's.
    const bundle = await loadStoreBundle(db, vault(), home.owner.pubkey, {
      holder: 'h',
      epoch: 0,
      rpcs: CONFIG.rpcs,
      inboxRelayAllowlist: CONFIG.inboxRelays,
      now: () => NOW,
    });
    expect(JSON.stringify(bundle.config.payouts)).toBe(home.ledger.payto?.payouts);
    expect(bundle.webhookSecretMissing).toBe(true);
    // The imported 10133 row carries the payouts it pays (the ledger's), never the draft.
    const [payoutRow] = await db.query<{ payouts_string: string | null; draft: unknown }>(
      `select e.payouts_string, c.draft_payouts as draft from owner_events e
       join store_config c on c.owner = e.owner where e.owner = $1 and e.kind = $2`,
      [home.owner.pubkey, KIND_PAYTO],
    );
    expect(payoutRow?.draft).toEqual(draftPayouts);
    expect(payoutRow?.payouts_string).toBe(home.ledger.payto?.payouts);
    expect(payoutRow?.payouts_string).not.toBe(JSON.stringify(draftPayouts));
  });

  it('keeps the 10133 date at the first prepare when the payouts are unchanged (P9)', async () => {
    const db = await freshDb();
    await withTier(db);
    const wallet = solanaWallet();
    const owner = key();
    const signed = [
      {
        caip19: USDC_DEVNET_CAIP19,
        address: wallet.address,
        signature: wallet.prove(owner.pubkey, USDC_DEVNET_CAIP19),
      },
    ];
    const home = await selfHostHome({ owner, payouts: signed });
    await importStore({ home: home.dir, tier: TIER, nodeStopped: true }, importDeps(db, home));
    const recorded = home.ledger.payto;
    const prepared = await prepareOwnerEvent(
      { db, operator: 'paycore.example', now: () => NOW },
      owner.pubkey,
      KIND_PAYTO,
      { newestOnRelays: recorded?.createdAt },
    );
    if (!prepared.ok) {
      throw new Error(`prepare refused: ${prepared.error}`);
    }
    expect(prepared.template.created_at).toBe(recorded?.createdAt);
    expect(prepared.payoutsString).toBe(recorded?.payouts);
  });

  it('keeps imported unsigned payouts active, and a new payout list needs signatures', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    await importStore({ home: home.dir, tier: TIER, nodeStopped: true }, importDeps(db, home));
    expect(
      await prepareOwnerEvent(
        { db, operator: 'paycore.example', now: () => NOW },
        home.owner.pubkey,
        KIND_PAYTO,
        { newestOnRelays: home.ledger.payto?.createdAt },
      ),
    ).toEqual({ ok: false, error: 'unsigned_payout', message: USDC_DEVNET_CAIP19 });
    const [store] = await db.query<{ status: string }>(
      'select status from stores where owner = $1',
      [home.owner.pubkey],
    );
    expect(store?.status).toBe('active');
  });

  it('a heal pass on an imported store keeps state.payto byte-equal', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    await importStore({ home: home.dir, tier: TIER, nodeStopped: true }, importDeps(db, home));
    const before = (await storedLedger(db, home.owner.pubkey)).payto;
    const holder = newHolderId();
    const [leased] = await lease(db, holder);
    const handle = await new PgLedgerStore(db, () => NOW).open(
      home.owner.pubkey,
      leased?.epoch ?? 0,
      holder,
    );
    const versionBefore = handle.rowVersion;
    await healPass(testSetupDeps(db, vault(), home.world))(home.owner.pubkey, handle);
    expect(handle.rowVersion).toBeGreaterThan(versionBefore);
    const after = (await storedLedger(db, home.owner.pubkey)).payto;
    expect(after?.payouts).toBe(before?.payouts);
    expect(after?.createdAt).toBe(before?.createdAt);
  });

  it('refuses relay events forged, of another author or of another kind, writing nothing', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    const options = { home: home.dir, tier: TIER, nodeStopped: true };
    const { payoutList, authorization } = await servedEvents(home);
    const stranger = key();
    const relays = relaysOf(home.world);
    const serving =
      (kind: number, event: NostrEvent): NewestOnRelays =>
      async (owner, asked, read) =>
        asked === kind ? event : relays(owner, asked, read);
    const forgedPayto = { ...payoutList, sig: authorization.sig };
    const forgedAuth = { ...authorization, sig: payoutList.sig };
    for (const event of [
      forgedPayto,
      resigned(payoutList, stranger),
      resigned(payoutList, home.owner, 10050),
    ]) {
      expect(
        await refusal(
          importStore(options, importDeps(db, home, { readRelays: serving(KIND_PAYTO, event) })),
        ),
      ).toBe('the payout list the relays serve is not signed by the owner');
      await nothingWritten(db);
    }
    for (const event of [
      forgedAuth,
      resigned(authorization, stranger),
      resigned(authorization, home.owner, 30491),
    ]) {
      expect(
        await refusal(
          importStore(
            options,
            importDeps(db, home, { readRelays: serving(KIND_STORE_AUTH, event) }),
          ),
        ),
      ).toBe(`the relays serve no authorization of this store key by the owner: ${SETUP_FIRST}`);
      await nothingWritten(db);
    }
    // The same events, served as they were signed, import.
    await importStore(options, importDeps(db, home));
    expect(await storeCount(db)).toBe(1);
  });

  it("reads the 30490 at the store's address: one at another d does not count", async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    const options = { home: home.dir, tier: TIER, nodeStopped: true };
    const { authorization } = await servedEvents(home);
    const elsewhere = key().pubkey;
    home.world.events.splice(home.world.events.indexOf(authorization), 1);
    home.world.add(
      finalizeEvent(
        {
          kind: KIND_STORE_AUTH,
          created_at: authorization.created_at + 60,
          tags: authorization.tags.map((tag) =>
            tag[1] === home.store.pubkey ? [tag[0] ?? '', elsewhere, ...tag.slice(2)] : tag,
          ),
          content: authorization.content,
        },
        home.owner.secretKey,
      ),
    );
    const asked: { kind: number; d?: string }[] = [];
    const relays = relaysOf(home.world);
    const recording: NewestOnRelays = async (owner, kind, read) => {
      asked.push({ kind, ...read });
      return relays(owner, kind, read);
    };
    expect(
      await refusal(importStore(options, importDeps(db, home, { readRelays: recording }))),
    ).toBe(`the relays serve no authorization of this store key by the owner: ${SETUP_FIRST}`);
    expect(asked).toEqual([{ kind: KIND_PAYTO }, { kind: KIND_STORE_AUTH, d: home.store.pubkey }]);
    await nothingWritten(db);
  });

  it('refuses a keys.json that is malformed, from before 0.5.0, or sealed without its public key', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome({ sealStore: true });
    const keysPath = join(home.dir, 'keys.json');
    const options = { home: home.dir, tier: TIER, nodeStopped: true };
    const attempt = () => refusal(importStore(options, importDeps(db, home)));
    writeFileSync(keysPath, '{ not json');
    expect(await attempt()).toMatch(/^cannot read .*keys\.json: /);
    for (const malformed of [
      {},
      { store: 7, ownerPubkey: home.owner.pubkey },
      { store: 'x', ownerPubkey: home.owner.pubkey.toUpperCase() },
      { store: 'x', storePubkey: 'abc', ownerPubkey: home.owner.pubkey },
    ]) {
      writeFileSync(keysPath, JSON.stringify(malformed));
      expect(await attempt()).toBe(`${keysPath} holds no usable store key`);
    }
    writeFileSync(
      keysPath,
      JSON.stringify({ store: bytesToHex(home.store.secretKey), owner: OWNER_SECRET_GARBAGE }),
    );
    expect(await attempt()).toBe(
      `${keysPath} does not name the owner public key (written before 0.5.0): run \`elisym-merchant encrypt-keys\` with a current node to rewrite it`,
    );
    writeFileSync(
      keysPath,
      JSON.stringify({
        store: encryptSecret(bytesToHex(home.store.secretKey), PASSPHRASE),
        owner: OWNER_SECRET_GARBAGE,
        ownerPubkey: home.owner.pubkey,
      }),
    );
    expect(await attempt()).toBe(`${keysPath} holds a sealed store key without its public key`);
    await nothingWritten(db);
    // A plain store key without its public key is derived from it.
    writeFileSync(
      keysPath,
      JSON.stringify({
        store: bytesToHex(home.store.secretKey),
        owner: OWNER_SECRET_GARBAGE,
        ownerPubkey: home.owner.pubkey,
      }),
    );
    expect((await importStore(options, importDeps(db, home))).storePubkey).toBe(home.store.pubkey);
  });

  it('refuses a store key that already belongs to another store here', async () => {
    const db = await freshDb();
    await withTier(db);
    const first = await selfHostHome();
    await importStore({ home: first.dir, tier: TIER, nodeStopped: true }, importDeps(db, first));
    const second = await selfHostHome();
    writeFileSync(
      join(second.dir, 'keys.json'),
      JSON.stringify({
        store: bytesToHex(first.store.secretKey),
        owner: OWNER_SECRET_GARBAGE,
        storePubkey: first.store.pubkey,
        ownerPubkey: second.owner.pubkey,
      }),
    );
    expect(
      await refusal(
        importStore({ home: second.dir, tier: TIER, nodeStopped: true }, importDeps(db, second)),
      ),
    ).toBe('this store key already belongs to another store on this server');
    expect(await storeCount(db)).toBe(1);
  });

  it('counts only products on sale against the tier', async () => {
    const db = await freshDb();
    await withTier(db, 1);
    const home = await selfHostHome();
    writeProduct(home, 'retired', 'title: Retired\npriceUsd: "2"\nonSale: false');
    const result = await importStore(
      { home: home.dir, tier: TIER, nodeStopped: true },
      importDeps(db, home),
    );
    expect(result.products).toBe(2);
    const products = await db.query<{ d: string; on_sale: boolean }>(
      'select d, on_sale from products where owner = $1 order by d',
      [home.owner.pubkey],
    );
    expect(products).toEqual([
      { d: D, on_sale: true },
      { d: 'retired', on_sale: false },
    ]);
  });

  it('refuses a home that lost a product with history, or prices its payouts cannot pay', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    const options = { home: home.dir, tier: TIER, nodeStopped: true };
    rmSync(join(home.dir, 'products', D), { recursive: true });
    expect(await refusal(importStore(options, importDeps(db, home)))).toBe(
      `product ${D} has a history in this store: restore products/${D}/PRODUCT.md (set "onSale: false" to stop selling it)`,
    );
    const priced = await selfHostHome({
      editLedger: (state) => {
        if (state.payto !== undefined) {
          state.payto.payouts = JSON.stringify([{ caip19: LSM_MAINNET_CAIP19, address: PAYOUT }]);
        }
      },
    });
    expect(
      await refusal(importStore({ ...options, home: priced.dir }, importDeps(db, priced))),
    ).toBe(`the products are not usable:\n- products/${D}: LSM cannot be paid its price of 1 USD`);
    await nothingWritten(db);
  });

  it('refuses a product the admin API would refuse, with every problem', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    writeProduct(home, D, 'title: Course\npriceUsd: "1"', `A course.${String.fromCharCode(0)}`);
    writeProduct(home, 'second', 'title: Second\npriceUsd: "2"\nsummary: "x\\0"');
    const message = await refusal(
      importStore({ home: home.dir, tier: TIER, nodeStopped: true }, importDeps(db, home)),
    );
    expect(message.split('\n')).toEqual([
      'the products are not usable here:',
      expect.stringMatching(new RegExp(`^- products/${D}: description `)),
      expect.stringMatching(/^- products\/second: summary /),
    ]);
    await nothingWritten(db);
  });

  it('refuses a ledger of the version before fee support', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome({
      editLedger: (state) => {
        // Written by a node before fee support: the type only knows the current version.
        Object.assign(state, { version: PRE_FEE_LEDGER_VERSION });
      },
    });
    expect(
      await refusal(
        importStore({ home: home.dir, tier: TIER, nodeStopped: true }, importDeps(db, home)),
      ),
    ).toBe(
      `${join(home.dir, 'ledger.json')}: this home was last run by a version before protocol-fee support: run \`elisym-merchant setup\` or \`run\` once after upgrading`,
    );
    await nothingWritten(db);
  });

  it('refuses a webhook secret off its size or an empty secret file; takes both size limits', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome({ webhook: true });
    const options = { home: home.dir, tier: TIER, nodeStopped: true };
    const secretFile = join(home.dir, 'webhook-secret');
    const withSecret = (secret: string) => {
      writeFileSync(secretFile, secret);
      return refusal(
        importStore({ ...options, webhookSecretFile: secretFile }, importDeps(db, home)),
      );
    };
    const size = 'the webhook secret must be 32 to 256 bytes';
    expect(await withSecret('s'.repeat(31))).toBe(size);
    expect(await withSecret('s'.repeat(257))).toBe(size);
    // Bytes, not characters: 129 two-byte characters are 258 bytes.
    expect(await withSecret('é'.repeat(129))).toBe(size);
    expect(await withSecret('\n')).toBe(
      `--webhook-secret-file: the webhook secret file ${secretFile} is empty`,
    );
    expect(
      await refusal(importStore({ ...options, webhookSecretFile: '' }, importDeps(db, home))),
    ).toBe('--webhook-secret-file names no secret');
    await nothingWritten(db);
    for (const secret of ['s'.repeat(32), 'é'.repeat(128)]) {
      const taken = await selfHostHome({ webhook: true });
      const file = join(taken.dir, 'webhook-secret');
      writeFileSync(file, `${secret}\n`);
      const result = await importStore(
        { home: taken.dir, tier: TIER, nodeStopped: true, webhookSecretFile: file },
        importDeps(db, taken),
      );
      expect(result.webhookSecret).toBe(true);
      const [row] = await db.query<{ webhook_secret: Uint8Array | null }>(
        'select webhook_secret from store_keys where owner = $1',
        [taken.owner.pubkey],
      );
      if (row?.webhook_secret === null || row === undefined) {
        throw new Error('no sealed webhook secret');
      }
      expect(
        Buffer.from(vault().open(row.webhook_secret, taken.owner.pubkey, 'webhook')).toString(
          'utf8',
        ),
      ).toBe(secret);
    }
  });

  it('runs safe EVM credit when any chain of config.json asks for it', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    writeConfig(home, {
      evm: {
        ethereum: { rpcUrl: 'https://eth.node.example', credit: 'fast' },
        base: { rpcUrl: 'https://base.node.example', credit: 'safe' },
      },
    });
    await importStore({ home: home.dir, tier: TIER, nodeStopped: true }, importDeps(db, home));
    const [config] = await db.query<{ evm_credit: string }>(
      'select evm_credit from store_config where owner = $1',
      [home.owner.pubkey],
    );
    expect(config?.evm_credit).toBe('safe');
  });

  it('stores inbox relays in checkout spelling', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    writeConfig(home, { inboxRelays: ['wss://Inbox.Example.com//'] });
    await importStore({ home: home.dir, tier: TIER, nodeStopped: true }, importDeps(db, home));
    const [config] = await db.query<{ inbox_relays: string[] }>(
      'select inbox_relays from store_config where owner = $1',
      [home.owner.pubkey],
    );
    expect(config?.inbox_relays).toEqual([RELAY]);
  });

  it('refuses payouts, published or draft, on a chain this server has no RPC for', async () => {
    const db = await freshDb();
    await withTier(db);
    const drafted = await selfHostHome();
    writeConfig(drafted, {
      payouts: [
        { caip19: USDC_DEVNET_CAIP19, address: PAYOUT },
        { caip19: BASE_DEVNET_CAIP19, address: TEMPO_PAYOUT },
      ],
      evm: { base: { rpcUrl: 'https://base.node.example' } },
    });
    expect(
      await refusal(
        importStore({ home: drafted.dir, tier: TIER, nodeStopped: true }, importDeps(db, drafted)),
      ),
    ).toBe('config.json is not usable here:\n- payouts: this server has no RPC for base-devnet');
    const published = await selfHostHome({
      editLedger: (state) => {
        if (state.payto !== undefined) {
          state.payto.payouts = JSON.stringify([
            { caip19: TEMPO_DEVNET_CAIP19, address: TEMPO_PAYOUT },
          ]);
        }
      },
    });
    expect(
      await refusal(
        importStore(
          { home: published.dir, tier: TIER, nodeStopped: true },
          importDeps(db, published),
        ),
      ),
    ).toBe('config.json is not usable here:\n- payouts: this server has no RPC for tempo-devnet');
    await nothingWritten(db);
  });

  it('prints a refusal through the CLI line by line, control characters escaped', async () => {
    const db = await freshDb();
    await withTier(db);
    const home = await selfHostHome();
    const cli = async (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(argv, cliDeps(db, home, out, err));
      return { code, out, err };
    };
    expect(await cli('import', home.dir, '--tier', 'gold\u001b[2J', '--node-stopped')).toEqual({
      code: 1,
      out: [],
      err: ['import refused: no such tier: gold?[2J'],
    });
    writeConfig(home, { inboxRelays: ['wss://nos.lol', 'wss://relay.damus.io'] });
    const refused = await cli('import', home.dir, '--tier', TIER, '--node-stopped');
    expect(refused.code).toBe(1);
    expect(refused.err[0]?.split('\n')).toEqual([
      'import refused: config.json is not usable here:',
      expect.stringMatching(/^- inboxRelays: wss:\/\/nos\.lol is not a relay this server allows/),
      expect.stringMatching(
        /^- inboxRelays: wss:\/\/relay\.damus\.io is not a relay this server allows/,
      ),
    ]);
    await nothingWritten(db);
  });
});

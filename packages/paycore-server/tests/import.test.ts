import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import { verifyWebhook } from '@elisym/commerce/webhook';
import { newest } from '@merchant-node/checks';
import { OFFER_RELAYS } from '@merchant-node/constants';
import { type LedgerState, emptyLedger, loadLedger, recordPayment } from '@merchant-node/ledger';
import { encryptSecret } from '@merchant-node/secret-box';
import { runSetupPass } from '@merchant-node/setup-ledger';
import { buildStoreSignedEvents, ownerEventTemplates } from '@merchant-node/store-events';
import { orderPaidBody, sendWebhook } from '@merchant-node/webhook';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { afterEach, describe, expect, it } from 'vitest';
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
  D,
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

const TIER = 'basic';
const PASSPHRASE = 'correct horse battery staple';
const WEBHOOK_URL = 'https://hooks.example.com/paid';
const WEBHOOK_SECRET = 's'.repeat(64);
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
    const home = await selfHostHome({
      webhook: true,
      configPayouts: [{ caip19: USDC_DEVNET_CAIP19, address: solanaWallet().address }],
    });
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
});

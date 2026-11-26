import { emptyLedger, type LedgerState } from '@merchant-node/ledger';
import { publishTerms } from '@merchant-node/terms';
import { getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { pendingRequests } from '../src/admin/requests';
import type { Db } from '../src/db/db';
import { KeyVault } from '../src/db/keys';
import { serializeLedger } from '../src/state/ledger-store';
import {
  SUSPENDED_REFUSAL,
  StoreDirectory,
  WINDING_DOWN_REFUSAL,
  canonicalPayouts,
  hostedWebhookProblem,
} from '../src/state/stores';
import { freshDb } from './pglite-db';
import {
  MASTER_KEY,
  NOW,
  PRODUCT,
  RELAY,
  RPCS,
  USDC_DEVNET,
  activate,
  directoryFor,
  ownerKeys,
  signedPayouts,
  solanaWallet,
} from './stores-fixtures';

async function newStore(db: Db) {
  const owner = ownerKeys().pubkey;
  const directory = directoryFor(db);
  await directory.createStore(owner, { name: 'Shop', network: 'devnet' });
  return { owner, directory };
}

function configInput(owner: string, overrides: Record<string, unknown> = {}) {
  return { name: 'Shop', payouts: signedPayouts(owner), inboxRelays: [RELAY], ...overrides };
}

/** S and the webhook secret as sealed in `store_keys`, opened. */
async function openSecrets(db: Db, owner: string) {
  const vault = new KeyVault(MASTER_KEY);
  const [row] = await db.query<{ store_key: Uint8Array; webhook_secret: Uint8Array | null }>(
    'select store_key, webhook_secret from store_keys where owner = $1',
    [owner],
  );
  if (row === undefined) {
    throw new Error(`no store_keys row for ${owner}`);
  }
  return {
    storeSecretKey: vault.open(row.store_key, owner, 'store'),
    webhookSecret:
      row.webhook_secret === null
        ? undefined
        : Buffer.from(vault.open(row.webhook_secret, owner, 'webhook')).toString('utf8'),
  };
}

async function writeLedger(db: Db, owner: string, state: LedgerState): Promise<void> {
  await db.query('update ledgers set state = $2 where owner = $1', [owner, serializeLedger(state)]);
}

describe('StoreDirectory: create', () => {
  it('creates a pending store with a sealed S, an empty ledger and the allowlisted relays', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    const store = await directory.store(owner);
    expect(store).toMatchObject({ owner, status: 'pending', tier: undefined });
    const secrets = await openSecrets(db, owner);
    expect(secrets.webhookSecret).toBeUndefined();
    expect(getPublicKey(secrets.storeSecretKey)).toBe(store?.storePubkey);
    const [keys] = await db.query<{ store_key: Uint8Array }>(
      'select store_key from store_keys where owner = $1',
      [owner],
    );
    expect(Buffer.from(keys?.store_key ?? []).includes(Buffer.from(secrets.storeSecretKey))).toBe(
      false,
    );
    expect(await directory.ledgerState(owner)).toEqual(emptyLedger());
    expect(await directory.settings(owner)).toMatchObject({
      name: 'Shop',
      network: 'devnet',
      draftPayouts: [],
      inboxRelays: [RELAY],
      activeInboxRelays: [RELAY],
      evmCredit: 'fast',
    });
  });

  it('returns the existing store on a second create (one store per owner)', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    const first = await directory.store(owner);
    const again = await directory.createStore(owner, { name: 'Other', network: 'mainnet' });
    expect(again).toEqual({ created: false, store: first });
    expect((await directory.settings(owner))?.name).toBe('Shop');
  });

  it('seals S for its owner only', async () => {
    const db = await freshDb();
    const { owner } = await newStore(db);
    const [keys] = await db.query<{ store_key: Uint8Array }>(
      'select store_key from store_keys where owner = $1',
      [owner],
    );
    expect(() =>
      new KeyVault(MASTER_KEY).open(
        keys?.store_key ?? new Uint8Array(),
        ownerKeys().pubkey,
        'store',
      ),
    ).toThrow();
  });
});

describe('StoreDirectory: config', () => {
  it('stores the draft payouts in canonical form and keeps the network', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    const payouts = signedPayouts(owner);
    const [first] = payouts;
    // Keys out of order and an unknown one: the schema form drops and reorders them.
    const messy = [
      { signature: first?.signature, extra: 1, address: first?.address, caip19: first?.caip19 },
    ];
    const result = await directory.putConfig(owner, configInput(owner, { payouts: messy }));
    expect(result.ok).toBe(true);
    const settings = await directory.settings(owner);
    expect(JSON.stringify(settings?.draftPayouts)).toBe(JSON.stringify(payouts));
    expect(settings).toMatchObject({ network: 'devnet', revision: 2 });
  });

  it('refuses a payout without a wallet signature, or with one for another owner', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    const wallet = solanaWallet();
    const unsigned = await directory.putConfig(
      owner,
      configInput(owner, { payouts: [{ caip19: USDC_DEVNET, address: wallet.address }] }),
    );
    expect(unsigned).toMatchObject({ ok: false, error: 'bad_config' });
    expect(unsigned.ok ? [] : unsigned.problems).toEqual([
      'payouts.0.signature: a wallet signature of the payout address is required',
    ]);
    const forOther = await directory.putConfig(
      owner,
      configInput(owner, {
        payouts: [
          {
            caip19: USDC_DEVNET,
            address: wallet.address,
            signature: wallet.prove(ownerKeys().pubkey, USDC_DEVNET),
          },
        ],
      }),
    );
    expect(forOther.ok ? [] : forOther.problems).toEqual([
      `payouts.0.signature: does not prove ${wallet.address} for this owner and coin`,
    ]);
    expect((await directory.settings(owner))?.draftPayouts).toEqual([]);
  });

  it('refuses an inbox relay outside the allowlist', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    for (const relay of ['wss://nos.lol', 'ws://localhost:7777', 'wss://10.0.0.1']) {
      const result = await directory.putConfig(owner, configInput(owner, { inboxRelays: [relay] }));
      expect(result.ok ? [] : result.problems).toEqual([
        `inboxRelays.0: not a relay this server allows (${RELAY})`,
      ]);
    }
    // The allowlisted relay in another spelling is the same relay.
    expect(
      (await directory.putConfig(owner, configInput(owner, { inboxRelays: [`${RELAY}/`] }))).ok,
    ).toBe(true);
    expect((await directory.settings(owner))?.inboxRelays).toEqual([RELAY]);
  });

  it('refuses a webhook on port 8443, over http, or to a private host; takes https on 443', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    for (const webhookUrl of [
      'https://hooks.example:8443/paid',
      'http://hooks.example/paid',
      'https://127.0.0.1/paid',
      'https://user:pass@hooks.example/paid',
    ]) {
      const result = await directory.putConfig(owner, configInput(owner, { webhookUrl }));
      expect(result.ok, webhookUrl).toBe(false);
      expect(result.ok ? [] : result.problems?.[0], webhookUrl).toMatch(/^webhookUrl: /);
    }
    expect(hostedWebhookProblem('https://hooks.example:443/paid')).toBeUndefined();
    // Every IP literal is refused, private or public: a webhook names a public DNS host.
    for (const literal of [
      'https://10.0.0.1/paid',
      'https://169.254.169.254/paid',
      'https://[::1]/paid',
      'https://[fd00::1]/paid',
      'https://[::ffff:127.0.0.1]/paid',
      'https://8.8.8.8/paid',
      'https://0x7f000001/paid',
    ]) {
      expect(hostedWebhookProblem(literal), literal).toBeDefined();
    }
    const good = await directory.putConfig(
      owner,
      configInput(owner, { webhookUrl: 'https://hooks.example/paid' }),
    );
    expect(good.ok).toBe(true);
    expect((await directory.settings(owner))?.webhookUrl).toBe('https://hooks.example/paid');
  });

  it('refuses a coin on a chain the operator has no RPC for', async () => {
    const db = await freshDb();
    const owner = ownerKeys().pubkey;
    const directory = directoryFor(db);
    await directory.createStore(owner, { name: 'Shop', network: 'mainnet' });
    const caip19 =
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const wallet = solanaWallet();
    const result = await directory.putConfig(
      owner,
      configInput(owner, {
        payouts: [{ caip19, address: wallet.address, signature: wallet.prove(owner, caip19) }],
      }),
    );
    expect(result.ok ? [] : result.problems).toEqual([
      expect.stringMatching(/^payouts\.0\.caip19: this server takes no payments on /),
    ]);
  });

  it("runs merchant-node's own config rules (a payout on the other network)", async () => {
    const db = await freshDb();
    const owner = ownerKeys().pubkey;
    const directory = directoryFor(db);
    await directory.createStore(owner, { name: 'Shop', network: 'mainnet' });
    const result = await directory.putConfig(owner, configInput(owner));
    expect(result.ok ? [] : result.problems).toEqual([
      expect.stringContaining('is on devnet, the node runs on mainnet'),
    ]);
  });

  it('refuses a stale expected revision, and checks none without one (import)', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    const first = await directory.putConfig(owner, configInput(owner), 1);
    expect(first.ok && first.settings.revision).toBe(2);
    expect(await directory.putConfig(owner, configInput(owner, { name: 'Late' }), 1)).toEqual({
      ok: false,
      error: 'stale_config',
    });
    expect((await directory.settings(owner))?.name).toBe('Shop');
    const unchecked = await directory.putConfig(owner, configInput(owner, { name: 'Import' }));
    expect(unchecked.ok && unchecked.settings).toMatchObject({ name: 'Import', revision: 3 });
  });

  it('queues a setup for a served store, none for a pending one', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    const pending = await directory.putConfig(owner, configInput(owner));
    expect(pending).toMatchObject({ ok: true, requestId: undefined });
    await activate(db, owner);
    const active = await directory.putConfig(owner, configInput(owner));
    expect(active.ok && active.requestId).toBeTruthy();
    expect((await pendingRequests(db, owner)).map((request) => request.kind)).toEqual(['setup']);
  });

  it('refuses edits of a store being suspended or suspended', async () => {
    for (const status of ['suspending', 'suspended']) {
      const db = await freshDb();
      const { owner, directory } = await newStore(db);
      await directory.putProduct(owner, 'old', PRODUCT);
      await activate(db, owner, 2, status);
      expect(await directory.putConfig(owner, configInput(owner))).toEqual(WINDING_DOWN_REFUSAL);
      expect(await directory.putProduct(owner, 'socks', PRODUCT)).toEqual(WINDING_DOWN_REFUSAL);
      expect(await directory.deleteProduct(owner, 'old')).toEqual(WINDING_DOWN_REFUSAL);
      expect(await directory.product(owner, 'old')).toMatchObject({ onSale: true });
      expect(await pendingRequests(db, owner)).toEqual([]);
    }
  });

  it('keeps the inbox relays a draft: the active ones are what the node listens on', async () => {
    const db = await freshDb();
    const owner = ownerKeys().pubkey;
    const other = 'wss://relay.other.example';
    const directory = new StoreDirectory({
      db,
      vault: new KeyVault(MASTER_KEY),
      inboxRelays: [RELAY, other],
      rpcs: RPCS,
      now: () => NOW,
    });
    await directory.createStore(owner, { name: 'Shop', network: 'devnet' });
    await activate(db, owner);
    const [created] = await db.query<{ inbox_relays: string[]; draft: string[] | null }>(
      'select inbox_relays, draft_inbox_relays as draft from store_config where owner = $1',
      [owner],
    );
    expect(created).toEqual({ inbox_relays: [RELAY, other], draft: null });
    expect(
      (await directory.putConfig(owner, configInput(owner, { inboxRelays: [other] }))).ok,
    ).toBe(true);
    expect(await directory.settings(owner)).toMatchObject({
      inboxRelays: [other],
      activeInboxRelays: [RELAY, other],
    });
    const [edited] = await db.query<{ inbox_relays: string[]; draft: string[] | null }>(
      'select inbox_relays, draft_inbox_relays as draft from store_config where owner = $1',
      [owner],
    );
    expect(edited).toEqual({ inbox_relays: [RELAY, other], draft: [other] });
  });
});

describe('canonical payouts string (P9)', () => {
  it('is JSON.stringify of the schema-parsed payouts, in the schema key order', () => {
    const owner = ownerKeys().pubkey;
    const payouts = signedPayouts(owner);
    const reordered = payouts.map((payout) => ({
      signature: payout.signature,
      address: payout.address,
      caip19: payout.caip19,
    }));
    const canonical = canonicalPayouts(reordered);
    expect(canonical?.text).toBe(JSON.stringify(canonical?.list));
    expect(canonical?.text).toBe(JSON.stringify(payouts));
    expect(canonical?.text.indexOf('"caip19"')).toBeLessThan(
      canonical?.text.indexOf('"address"') ?? 0,
    );
    expect(canonicalPayouts([])).toBeUndefined();
  });
});

describe('StoreDirectory: products', () => {
  it('caps products on sale at the tier, before writing', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    await activate(db, owner, 2);
    expect((await directory.putProduct(owner, 'a', PRODUCT)).ok).toBe(true);
    expect((await directory.putProduct(owner, 'b', PRODUCT)).ok).toBe(true);
    expect(await directory.putProduct(owner, 'c', PRODUCT)).toEqual({
      ok: false,
      error: 'product_cap',
      problems: ['at most 2 products on sale'],
    });
    expect(await directory.product(owner, 'c')).toBeUndefined();
    // Editing one already on sale is no new product; a sold-out one does not count.
    expect((await directory.putProduct(owner, 'a', { ...PRODUCT, priceUsd: '6' })).ok).toBe(true);
    expect((await directory.putProduct(owner, 'c', { ...PRODUCT, onSale: false })).ok).toBe(true);
    expect(await directory.putProduct(owner, 'c', PRODUCT)).toMatchObject({ error: 'product_cap' });
  });

  it('caps a pending store at the pending cap', async () => {
    const db = await freshDb();
    const owner = ownerKeys().pubkey;
    const directory = directoryFor(db, { pendingMaxProducts: 1 });
    await directory.createStore(owner, { name: 'Shop', network: 'devnet' });
    expect(await directory.putProduct(owner, 'a', PRODUCT)).toMatchObject({
      ok: true,
      requestId: undefined,
    });
    expect(await directory.putProduct(owner, 'b', PRODUCT)).toMatchObject({ error: 'product_cap' });
  });

  it('refuses a price a payout coin cannot carry, and a bad product id', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    await directory.putConfig(owner, configInput(owner));
    // USDC has 6 decimals: 7 are refused by the price rule before any write.
    const result = await directory.putProduct(owner, 'a', { ...PRODUCT, priceUsd: '0.0000001' });
    expect(result.ok).toBe(false);
    expect(await directory.product(owner, 'a')).toBeUndefined();
    expect(await directory.putProduct(owner, '../x', PRODUCT)).toMatchObject({
      error: 'bad_product',
    });
  });

  it('does not count a product already on sale against the cap when it is put again', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    await activate(db, owner, 2);
    expect((await directory.putProduct(owner, 'a', PRODUCT)).ok).toBe(true);
    expect((await directory.putProduct(owner, 'b', PRODUCT)).ok).toBe(true);
    // The operator lowered the tier below what is on sale: edits go on, a new one waits.
    await db.query("update tiers set max_products = 1 where name = 'tier-2'");
    expect(await directory.putProduct(owner, 'a', { ...PRODUCT, priceUsd: '7' })).toMatchObject({
      ok: true,
      product: { priceUsd: '7', onSale: true },
    });
    expect(await directory.putProduct(owner, 'c', PRODUCT)).toMatchObject({ error: 'product_cap' });
  });

  it('checks a price against the active payouts too, with no draft yet', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    const state = emptyLedger();
    state.payto = {
      createdAt: NOW - 60,
      payouts: JSON.stringify([{ caip19: USDC_DEVNET, address: solanaWallet().address }]),
    };
    await writeLedger(db, owner, state);
    expect((await directory.settings(owner))?.draftPayouts).toEqual([]);
    const result = await directory.putProduct(owner, 'a', { ...PRODUCT, priceUsd: '0.0000001' });
    expect(result).toMatchObject({ ok: false, error: 'bad_price' });
    expect(await directory.product(owner, 'a')).toBeUndefined();
    expect((await directory.putProduct(owner, 'a', PRODUCT)).ok).toBe(true);
  });

  it('keeps sold out a product whose only history is its terms', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    await directory.putProduct(owner, 'terms-only', PRODUCT);
    const state = emptyLedger();
    state.terms = publishTerms(
      [],
      { d: 'terms-only', caip19: USDC_DEVNET, payout: solanaWallet().address, amount: '5000000' },
      NOW - 60,
      NOW - 60,
    );
    await writeLedger(db, owner, state);
    expect(await directory.deleteProduct(owner, 'terms-only')).toMatchObject({
      outcome: 'stopped',
    });
    expect(await directory.product(owner, 'terms-only')).toMatchObject({ onSale: false });
  });

  it('removes a product never published, keeps one with a history sold out', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    await directory.putProduct(owner, 'fresh', PRODUCT);
    await directory.putProduct(owner, 'old', PRODUCT);
    const state = emptyLedger();
    state.listings.old = { hash: 'h', eventId: 'e', createdAt: 1 };
    await writeLedger(db, owner, state);
    expect(await directory.deleteProduct(owner, 'fresh')).toMatchObject({ outcome: 'removed' });
    expect(await directory.deleteProduct(owner, 'old')).toMatchObject({ outcome: 'stopped' });
    expect(await directory.product(owner, 'fresh')).toBeUndefined();
    expect(await directory.product(owner, 'old')).toMatchObject({ onSale: false });
    expect(await directory.deleteProduct(owner, 'none')).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('StoreDirectory: webhook secret', () => {
  it('returns the new secret once, sealed at rest, never in a request row', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    await activate(db, owner);
    const rotated = await directory.rotateWebhookSecret(owner);
    if (!rotated.ok) {
      throw new Error('rotation refused');
    }
    expect(rotated.secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await openSecrets(db, owner)).webhookSecret).toBe(rotated.secret);
    const requests = await db.query<{ payload: string; result: string | null }>(
      'select payload, result from admin_requests where owner = $1',
      [owner],
    );
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain(rotated.secret);
    const [keys] = await db.query<{ webhook_secret: Uint8Array }>(
      'select webhook_secret from store_keys where owner = $1',
      [owner],
    );
    expect(Buffer.from(keys?.webhook_secret ?? []).toString('latin1')).not.toContain(
      rotated.secret,
    );
    const again = await directory.rotateWebhookSecret(owner);
    expect(again.ok && again.secret).not.toBe(rotated.secret);
  });
});

describe('StoreDirectory: orders and requests', () => {
  it('lists the ledger row orders with buyer emails, newest first', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    const state = emptyLedger();
    const buyer = 'b'.repeat(64);
    for (const [orderId, createdAt] of [
      ['one', 10],
      ['two\u0000', 20],
    ] as const) {
      const key = `${buyer}:${orderId}`;
      state.orders[key] = {
        key,
        buyerPubkey: buyer,
        orderId,
        rumorId: 'r',
        createdAt,
        reference: 'ref',
        email: `${orderId}@buyer.example`,
        product: `30402:s:socks`,
        reportedTxs: [],
      };
    }
    await writeLedger(db, owner, state);
    const orders = await directory.orders(owner);
    expect(orders?.orders.map((order) => [order.orderId, order.email])).toEqual([
      ['two\u0000', 'two\u0000@buyer.example'],
      ['one', 'one@buyer.example'],
    ]);
  });

  it('names the product of each order by its current title, null once the product is removed', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    await activate(db, owner);
    await directory.putProduct(owner, 'socks', { ...PRODUCT, title: 'Old socks' });
    await directory.putProduct(owner, 'socks', { ...PRODUCT, title: 'Wool socks' });
    const state = emptyLedger();
    const buyer = 'b'.repeat(64);
    for (const [orderId, d, createdAt] of [
      ['one', 'socks', 10],
      ['two', 'hats', 20],
    ] as const) {
      const key = `${buyer}:${orderId}`;
      state.orders[key] = {
        key,
        buyerPubkey: buyer,
        orderId,
        rumorId: 'r',
        createdAt,
        reference: 'ref',
        product: `30402:s:${d}`,
        reportedTxs: [],
      };
    }
    await writeLedger(db, owner, state);
    const titles = async () =>
      (await directory.orders(owner))?.orders.map((order) => [order.orderId, order.productTitle]);
    expect(await titles()).toEqual([
      ['two', null],
      ['one', 'Wool socks'],
    ]);
    // Never published: removed, so its orders lose the title.
    expect(await directory.deleteProduct(owner, 'socks')).toMatchObject({ outcome: 'removed' });
    expect(await titles()).toEqual([
      ['two', null],
      ['one', null],
    ]);
  });

  it('takes the title from the own product of the store only, never from another store with the same d', async () => {
    const db = await freshDb();
    const mine = await newStore(db);
    const theirs = await newStore(db);
    await mine.directory.putProduct(mine.owner, 'socks', { ...PRODUCT, title: 'My socks' });
    await theirs.directory.putProduct(theirs.owner, 'socks', { ...PRODUCT, title: 'Their socks' });
    await theirs.directory.putProduct(theirs.owner, 'hats', { ...PRODUCT, title: 'Their hats' });
    const state = emptyLedger();
    const buyer = 'b'.repeat(64);
    for (const [orderId, d, createdAt] of [
      ['one', 'socks', 10],
      ['two', 'hats', 20],
    ] as const) {
      const key = `${buyer}:${orderId}`;
      state.orders[key] = {
        key,
        buyerPubkey: buyer,
        orderId,
        rumorId: 'r',
        createdAt,
        reference: 'ref',
        product: `30402:s:${d}`,
        reportedTxs: [],
      };
    }
    await writeLedger(db, mine.owner, state);
    expect(
      (await mine.directory.orders(mine.owner))?.orders.map((order) => order.productTitle),
    ).toEqual([null, 'My socks']);
  });

  it('queues one suspension and refuses it for a pending store', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    expect(await directory.requestSuspend(owner)).toEqual({ ok: false, error: 'inactive' });
    await activate(db, owner);
    const first = await directory.requestSuspend(owner);
    const second = await directory.requestSuspend(owner);
    expect(first.ok && second.ok && first.requestId === second.requestId).toBe(true);
    expect(await pendingRequests(db, owner)).toHaveLength(1);
  });

  it('refuses requests no holder would apply for a suspended store; serves a suspending one', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    const key = `${'b'.repeat(64)}:x`;
    await activate(db, owner, 2, 'suspended');
    expect(await directory.requestHandAnswer(owner, key, { kind: 'complete' })).toEqual(
      SUSPENDED_REFUSAL,
    );
    expect(await directory.rotateWebhookSecret(owner)).toEqual(SUSPENDED_REFUSAL);
    expect(await directory.requestSuspend(owner)).toEqual(WINDING_DOWN_REFUSAL);
    expect(await pendingRequests(db, owner)).toEqual([]);
    expect((await openSecrets(db, owner)).webhookSecret).toBeUndefined();
    // Still winding down: open orders are answered, webhooks still go out.
    await activate(db, owner, 2, 'suspending');
    expect((await directory.requestHandAnswer(owner, key, { kind: 'complete' })).ok).toBe(true);
    expect((await directory.rotateWebhookSecret(owner)).ok).toBe(true);
    expect((await pendingRequests(db, owner)).map((request) => request.kind)).toEqual([
      'hand_answer',
      'restart',
    ]);
  });

  it('queues a hand answer with the order key, as merchant-node reads it', async () => {
    const db = await freshDb();
    const { owner, directory } = await newStore(db);
    await activate(db, owner);
    const key = `${'b'.repeat(64)}:x`;
    await directory.requestHandAnswer(owner, key, { kind: 'complete' });
    await directory.requestHandAnswer(owner, key, { kind: 'refunded', tx: 't', amount: '5' });
    expect((await pendingRequests(db, owner)).map((request) => request.payload)).toEqual([
      { key, request: { kind: 'delivered' } },
      { key, request: { kind: 'refunded', tx: 't', amount: '5' } },
    ]);
  });
});

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { KIND_PAYTO, KIND_STORE_AUTH, paytoProofMessage } from '@elisym/commerce';
import { verifyWebhook } from '@elisym/commerce/webhook';
import { type LedgerState, emptyLedger } from '@merchant-node/ledger';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import { chain, landedPayment, requestFor, signatureOf } from '../../merchant-node/tests/fixtures';
import { getRequest, submitRequest } from '../src/admin/requests';
import type { Db } from '../src/db/db';
import type { KeyVault } from '../src/db/keys';
import { HolderRequests, MAX_SETUP_ATTEMPTS } from '../src/node/holder-requests';
import type { StoreSupervisor, SupervisorDeps } from '../src/node/supervisor';
import { commitOwnerEvent, prepareOwnerEvent } from '../src/owner-events';
import { activateStore } from '../src/state/activation';
import { newHolderId } from '../src/state/leases';
import { StoreDirectory } from '../src/state/stores';
import {
  type Key,
  NOW,
  PRODUCT,
  RELAY,
  SOLANA_RPC,
  SOLANA_PAYOUTS,
  TEMPO_RPC,
  USDC_DEVNET_CAIP19,
  WEBHOOK_SECRET,
  key,
  lease,
  openAlerts,
  orderWraps,
  publishedStore,
  seedStore,
  sellingLedger,
  storeStatus,
  storedLedger,
  testHeal,
  testSetupDeps,
  testSupervisor,
  vault,
  waitFor,
} from './helpers/node-store';
import { RelayWorld } from './helpers/node-world';
import { freshDb } from './pglite-db';
import { base58 } from './stores-fixtures';

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-00000000c001';
const HOOK_URL = 'https://shop.example.com/hook';
const OPERATOR = 'paycore.test';

const supervisors: StoreSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
});

/** A Solana wallet's payout to `owner`, proven (ed25519 over the proof text). */
function provenPayout(owner: string): { caip19: string; address: string; signature: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = base58(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const secret = createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const message = Buffer.from(paytoProofMessage(owner, USDC_DEVNET_CAIP19), 'utf8');
  return { caip19: USDC_DEVNET_CAIP19, address, signature: base58(sign(null, message, secret)) };
}

interface Holder {
  db: Db;
  keys: KeyVault;
  world: RelayWorld;
  holder: string;
  supervisor: StoreSupervisor;
  requests: HolderRequests;
  logs: string[];
}

/** A holder over `db`: its supervisor (with the real heal) and its request handling. */
function holderOn(
  db: Db,
  keys: KeyVault,
  world: RelayWorld,
  overrides: Partial<SupervisorDeps> = {},
  setupOverrides: Parameters<typeof testSetupDeps>[3] = {},
): Holder {
  const holder = newHolderId();
  const { heal } = testHeal(db, keys, world);
  const { supervisor, logs } = testSupervisor(db, keys, holder, world, chain({}).rpc, {
    heal,
    ...overrides,
  });
  supervisors.push(supervisor);
  const requests = new HolderRequests({
    db,
    supervisor,
    setup: testSetupDeps(db, keys, world, setupOverrides),
    log: (line) => logs.push(line),
  });
  return { db, keys, world, holder, supervisor, requests, logs };
}

async function serveAll(holder: Holder): Promise<void> {
  holder.supervisor.reconcile(await lease(holder.db, holder.holder));
  await holder.supervisor.idle();
}

async function requestRow(db: Db, owner: string, id: string) {
  const request = await getRequest(db, owner, id);
  if (request === undefined) {
    throw new Error(`no request ${id}`);
  }
  return request;
}

async function rowVersion(db: Db, owner: string): Promise<number | undefined> {
  const [row] = await db.query<{ row_version: number }>(
    'select row_version from ledgers where owner = $1',
    [owner],
  );
  return row?.row_version;
}

/** Prepare, sign with O and commit an owner event of `kind`; resolves to the request queued. */
async function commitSigned(
  db: Db,
  owner: Key,
  kind: typeof KIND_PAYTO | typeof KIND_STORE_AUTH,
  newestOnRelays?: number,
): Promise<{ event: NostrEvent; requestId: string }> {
  const deps = { db, operator: OPERATOR, now: () => NOW };
  const relays = newestOnRelays === undefined ? {} : { newestOnRelays };
  const prepared = await prepareOwnerEvent(deps, owner.pubkey, kind, relays);
  if (!prepared.ok) {
    throw new Error(`prepare refused: ${prepared.error} ${prepared.message ?? ''}`);
  }
  const event = finalizeEvent(prepared.template, owner.secretKey);
  const committed = await commitOwnerEvent(deps, owner.pubkey, event, relays);
  if (!committed.ok || committed.requestId === undefined) {
    throw new Error(`commit refused: ${committed.ok ? 'already' : committed.error}`);
  }
  return { event, requestId: committed.requestId };
}

/** A db whose statements containing `fragment` throw once (a crash right there). */
function crashOnce(db: Db, fragment: string): Db {
  let armed = true;
  return {
    query: (sql, params) => {
      if (armed && sql.includes(fragment)) {
        armed = false;
        return Promise.reject(new Error('crash'));
      }
      return db.query(sql, params);
    },
    script: (sql) => db.script(sql),
    transaction: (work) => db.transaction(work),
    listen: (channel, onNotify) => db.listen(channel, onNotify),
    close: () => db.close(),
  };
}

describe('owner events committed and recorded by the holder (step 12)', () => {
  it('records a good commit: the terms, the publish, recorded, the active payouts switch', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    const payout = provenPayout(seed.owner.pubkey);
    await seedStore(db, keys, { ...seed, draftPayouts: [payout] });
    const node = holderOn(db, keys, world);
    await serveAll(node);
    const owner = seed.owner.pubkey;

    const { event, requestId } = await commitSigned(db, seed.owner, KIND_PAYTO, NOW - 3600);
    expect(await node.requests.drain(owner)).toEqual([requestId]);

    const stored = await storedLedger(db, owner);
    expect(stored.payto).toEqual({
      createdAt: event.created_at,
      payouts: JSON.stringify([payout]),
    });
    expect(world.events.some((known) => known.id === event.id)).toBe(true);
    const [row] = await db.query<{ recorded: boolean; published_at: number | null }>(
      'select recorded, published_at from owner_events where id = $1',
      [event.id],
    );
    expect(row).toEqual({ recorded: true, published_at: NOW });
    const request = await requestRow(db, owner, requestId);
    expect(request.state).toBe('applied');
    expect(request.result).toMatchObject({ setup: 'done', payoutListOut: true });
    expect(
      stored.terms
        .filter((period) => period.until === undefined)
        .map((period) => period.terms.payout),
    ).toEqual([payout.address]);
    expect(node.supervisor.running).toEqual([owner]);
    expect(await storeStatus(db, owner)).toBe('active');
  });

  it('marks a record request of an event already recorded without another pass', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const node = holderOn(db, keys, world);
    await serveAll(node);
    const owner = seed.owner.pubkey;
    const eventId = seed.ownerEvents?.[0]?.event.id;
    const id = await submitRequest(db, owner, 'record_owner_event', { eventId }, NOW);
    const before = world.events.length;
    expect(await node.requests.drain(owner)).toEqual([id]);
    expect(world.events.length).toBe(before);
    expect((await requestRow(db, owner, id)).result).toEqual({ recorded: true });
  });
});

describe('admin requests on the holder (step 13)', () => {
  it('lets only the lease holder apply a request', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const { owner } = await seedStore(db, keys);
    const leaseHolder = holderOn(db, keys, world);
    const other = holderOn(db, keys, world);
    await serveAll(leaseHolder);
    await serveAll(other);
    expect(other.supervisor.leased).toEqual([]);
    const id = await submitRequest(db, owner.pubkey, 'restart', {}, NOW);

    await other.requests.drainAll();
    await expect(other.requests.drain(owner.pubkey)).rejects.toThrow('not run by this holder');
    expect((await requestRow(db, owner.pubkey, id)).state).toBe('pending');

    const node = leaseHolder.supervisor.nodeOf(owner.pubkey);
    await leaseHolder.requests.drainAll();
    expect((await requestRow(db, owner.pubkey, id)).state).toBe('applied');
    expect(leaseHolder.supervisor.nodeOf(owner.pubkey)).not.toBe(node);
  });

  it('applies a setup request once across a crash between its save and the rest', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const owner = seed.owner.pubkey;
    const crashing = crashOnce(db, 'update admin_requests set result');
    const node = holderOn(db, keys, world, {}, { db: crashing });
    const requests = new HolderRequests({
      db: crashing,
      supervisor: node.supervisor,
      setup: testSetupDeps(crashing, keys, world),
    });
    await serveAll(node);
    await db.query("update products set price_usd = '2' where owner = $1", [owner]);
    const id = await submitRequest(db, owner, 'setup', {}, NOW);

    await expect(requests.drain(owner)).rejects.toThrow('crash');
    const afterCrash = await requestRow(db, owner, id);
    expect(afterCrash.state).toBe('applied');
    const version = await rowVersion(db, owner);
    const published = world.events.length;
    expect(
      (await storedLedger(db, owner)).terms.some(
        (period) => period.terms.amount === '2000000' && period.until === undefined,
      ),
    ).toBe(true);

    expect(await requests.drain(owner)).toEqual([]);
    expect(await rowVersion(db, owner)).toBe(version);
    expect(world.events.length).toBe(published);
  });

  it('keeps a setup request that cannot publish pending, then fails it with an alert', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const owner = seed.owner.pubkey;
    const node = holderOn(db, keys, world);
    await serveAll(node);
    world.refuse = () => true;
    const id = await submitRequest(db, owner, 'setup', {}, NOW);
    for (let attempt = 1; attempt < MAX_SETUP_ATTEMPTS; attempt += 1) {
      await expect(node.requests.drain(owner)).rejects.toThrow('nothing reached a relay');
      expect((await requestRow(db, owner, id)).state).toBe('pending');
    }
    expect(await node.requests.drain(owner)).toEqual([id]);
    const failed = await requestRow(db, owner, id);
    expect(failed.state).toBe('failed');
    expect(failed.result).toMatchObject({ problem: expect.stringContaining('nothing reached') });
    expect((await openAlerts(db, owner)).map((alert) => alert.kind)).toContain('setup_failed');

    world.refuse = () => false;
    await submitRequest(db, owner, 'setup', {}, NOW);
    await node.requests.drain(owner);
    expect((await openAlerts(db, owner)).map((alert) => alert.kind)).not.toContain('setup_failed');
  });

  it('marks setup requests queued before a pass as covered by it', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const owner = seed.owner.pubkey;
    const node = holderOn(db, keys, world);
    await serveAll(node);
    const first = await submitRequest(db, owner, 'setup', {}, NOW);
    const second = await submitRequest(db, owner, 'setup', {}, NOW);
    expect(await node.requests.drain(owner)).toEqual([first]);
    expect((await requestRow(db, owner, second)).result).toEqual({ coveredBy: first });
  });

  it('keeps the requests of a pending store pending, and runs the setup pass at its activation', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const owner = key();
    const payout = provenPayout(owner.pubkey);
    await seedStore(db, keys, {
      owner,
      status: 'pending',
      state: emptyLedger(),
      draftPayouts: [payout],
    });
    const node = holderOn(db, keys, world);
    await serveAll(node);
    const list = await commitSigned(db, owner, KIND_PAYTO);
    const auth = await commitSigned(db, owner, KIND_STORE_AUTH);
    await node.requests.drainAll();
    expect(node.supervisor.leased).toEqual([]);
    expect((await requestRow(db, owner.pubkey, list.requestId)).state).toBe('pending');
    expect(world.events).toEqual([]);

    const activated = await activateStore(db, owner.pubkey, { tier: 'basic', now: NOW });
    expect(activated.ok).toBe(true);
    await serveAll(node);
    await node.requests.drainAll();

    expect(world.events.some((event) => event.id === list.event.id)).toBe(true);
    expect(world.events.some((event) => event.id === auth.event.id)).toBe(true);
    expect(world.events.some((event) => event.kind === 30402)).toBe(true);
    const recorded = await db.query<{ recorded: boolean }>(
      'select recorded from owner_events where owner = $1',
      [owner.pubkey],
    );
    expect(recorded).toEqual([{ recorded: true }, { recorded: true }]);
    const states = await db.query<{ state: string }>(
      'select state from admin_requests where owner = $1',
      [owner.pubkey],
    );
    expect(states.every((row) => row.state === 'applied')).toBe(true);
    expect((await storedLedger(db, owner.pubkey)).payto?.payouts).toBe(JSON.stringify([payout]));
    expect(node.supervisor.running).toEqual([owner.pubkey]);
  });
});

/** A ledger selling `D` with an unpaid order of `buyer` and one unresolved payment on it. */
function ledgerWithOpenOrder(store: Key, buyer: Key): { state: LedgerState; orderKey: string } {
  const state = sellingLedger();
  const orderKey = `${buyer.pubkey}:${ORDER_ID}`;
  state.orders[orderKey] = {
    key: orderKey,
    buyerPubkey: buyer.pubkey,
    orderId: ORDER_ID,
    rumorId: 'r'.repeat(64),
    createdAt: NOW - 600,
    reference: 'ref',
    product: `30402:${store.pubkey}:${PRODUCT.d}`,
    reportedTxs: [],
  };
  state.unresolvedPayments.push({ key: orderKey, tx: signatureOf(3), at: NOW - 500 });
  return { state, orderKey };
}

/** The gift wraps addressed to `pubkey` on the world. */
function wrapsTo(world: RelayWorld, pubkey: string): NostrEvent[] {
  return world.events.filter(
    (event) => event.kind === 1059 && event.tags.some((tag) => tag[0] === 'p' && tag[1] === pubkey),
  );
}

describe('hand answers (step 14)', () => {
  async function storeWithOpenOrder() {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const store = key();
    const buyer = key();
    const { state, orderKey } = ledgerWithOpenOrder(store, buyer);
    const { owner } = await seedStore(db, keys, { store, state });
    return { db, keys, world, store, buyer, orderKey, owner: owner.pubkey };
  }

  it('completes an order with an unresolved payment by hand, saved before it is sent', async () => {
    const { db, keys, world, buyer, orderKey, owner } = await storeWithOpenOrder();
    const node = holderOn(db, keys, world);
    await serveAll(node);
    const id = await submitRequest(
      db,
      owner,
      'hand_answer',
      { key: orderKey, request: { kind: 'delivered' } },
      NOW,
    );
    expect(await node.requests.drain(owner)).toEqual([id]);
    const stored = await storedLedger(db, owner);
    expect(stored.orders[orderKey]).toBeUndefined();
    expect(stored.closedOrders?.[orderKey]).toBe(true);
    expect(stored.answeredByHand?.[orderKey]?.kind).toBe('delivered');
    expect(stored.unresolvedPayments).toEqual([]);
    expect(wrapsTo(world, buyer.pubkey)).toHaveLength(1);
    const request = await requestRow(db, owner, id);
    expect(request.state).toBe('applied');
    expect(request.result).toEqual({ done: true, rerun: false, taken: 1, copyTaken: 1, relays: 1 });
    expect(node.supervisor.running).toEqual([owner]);
  });

  it('records a refund sent by hand, in the only payout coin', async () => {
    const { db, keys, world, orderKey, owner } = await storeWithOpenOrder();
    const node = holderOn(db, keys, world);
    await serveAll(node);
    const tx = signatureOf(5);
    const id = await submitRequest(
      db,
      owner,
      'hand_answer',
      { key: orderKey, request: { kind: 'refunded', tx, amount: '1000000' } },
      NOW,
    );
    await node.requests.drain(owner);
    expect((await storedLedger(db, owner)).answeredByHand?.[orderKey]).toMatchObject({
      kind: 'refunded',
      tx,
      amount: '1000000',
      caip19: USDC_DEVNET_CAIP19,
    });
    expect((await requestRow(db, owner, id)).result).toMatchObject({ done: true });
  });

  it('changes nothing on a replay, and sends the stored answer again on a new request', async () => {
    const { db, keys, world, buyer, orderKey, owner } = await storeWithOpenOrder();
    const node = holderOn(db, keys, world);
    await serveAll(node);
    const payload = { key: orderKey, request: { kind: 'delivered' } };
    const first = await submitRequest(db, owner, 'hand_answer', payload, NOW);
    await node.requests.drain(owner);
    const version = await rowVersion(db, owner);

    expect(await node.requests.drain(owner)).toEqual([]);
    expect(await rowVersion(db, owner)).toBe(version);
    expect(wrapsTo(world, buyer.pubkey)).toHaveLength(1);

    const answered = await storedLedger(db, owner);
    const again = await submitRequest(db, owner, 'hand_answer', payload, NOW);
    expect(await node.requests.drain(owner)).toEqual([again]);
    // Only the restart's own save (its resume point): the answer and the close are as they were.
    const after = await storedLedger(db, owner);
    expect(after.answeredByHand).toEqual(answered.answeredByHand);
    expect(after.closedOrders).toEqual(answered.closedOrders);
    expect(wrapsTo(world, buyer.pubkey)).toHaveLength(2);
    expect((await requestRow(db, owner, again)).result).toMatchObject({ done: true, rerun: true });
    expect((await requestRow(db, owner, first)).result).toMatchObject({ rerun: false });

    const opposite = await submitRequest(
      db,
      owner,
      'hand_answer',
      { key: orderKey, request: { kind: 'refunded', tx: signatureOf(5), amount: '1' } },
      NOW,
    );
    await node.requests.drain(owner);
    const refused = await requestRow(db, owner, opposite);
    expect(refused.state).toBe('failed');
    expect(refused.result).toMatchObject({ problem: expect.stringContaining('already answered') });
  });

  it('sends a saved answer on the next drain after a crash between the save and the publish', async () => {
    const { db, keys, world, buyer, store, orderKey, owner } = await storeWithOpenOrder();
    let crash = true;
    const node = holderOn(db, keys, world);
    const pools = testSetupDeps(db, keys, world).pools;
    const requests = new HolderRequests({
      db,
      supervisor: node.supervisor,
      setup: testSetupDeps(db, keys, world, {
        pools: {
          open: (storePubkey) => {
            if (crash && storePubkey === store.pubkey) {
              crash = false;
              throw new Error('crash');
            }
            return pools.open(storePubkey);
          },
          close: (storePubkey) => pools.close(storePubkey),
        },
      }),
    });
    await serveAll(node);
    const id = await submitRequest(
      db,
      owner,
      'hand_answer',
      { key: orderKey, request: { kind: 'delivered' } },
      NOW,
    );
    await expect(requests.drain(owner)).rejects.toThrow('crash');
    const saved = await requestRow(db, owner, id);
    expect(saved.state).toBe('applied');
    expect(saved.result).toBeUndefined();
    expect((await storedLedger(db, owner)).answeredByHand?.[orderKey]?.kind).toBe('delivered');
    expect(wrapsTo(world, buyer.pubkey)).toHaveLength(0);

    expect(await requests.drain(owner)).toEqual([id]);
    expect(wrapsTo(world, buyer.pubkey)).toHaveLength(1);
    expect((await requestRow(db, owner, id)).result).toMatchObject({ done: true, rerun: true });
    expect(await requests.drain(owner)).toEqual([]);
  });
});

describe('webhook secrets and rails (decisions)', () => {
  /** A store whose buyer paid an order (the chain has the payment) and a webhook URL. */
  async function paidStore(options: { webhookSecret?: string }) {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const store = key();
    const buyer = key();
    const tx = signatureOf(7);
    const wraps = orderWraps(store, buyer, ORDER_ID, tx);
    const { rpc } = chain({
      [tx]: await landedPayment(requestFor(wraps.reference), { blockTime: NOW - 30 }),
    });
    const { owner } = await seedStore(db, keys, {
      store,
      webhookUrl: HOOK_URL,
      ...(options.webhookSecret === undefined ? {} : { webhookSecret: options.webhookSecret }),
    });
    return { db, keys, world, wraps, rpc, owner: owner.pubkey };
  }

  it('runs a store whose webhook URL has no secret: entries queue, sent once a secret is set', async () => {
    const { db, keys, world, wraps, rpc, owner } = await paidStore({});
    const sends: { headers: Record<string, string>; body: string }[] = [];
    const holder = newHolderId();
    const { supervisor } = testSupervisor(db, keys, holder, world, rpc, {
      webhookSlots: {
        forStore: () => async (_url, init) => {
          sends.push({
            headers: init.headers as Record<string, string>,
            body: String(init.body),
          });
          return new Response(null, { status: 200 });
        },
      },
    });
    supervisors.push(supervisor);
    const requests = new HolderRequests({
      db,
      supervisor,
      setup: testSetupDeps(db, keys, world),
    });
    supervisor.reconcile(await lease(db, holder));
    await supervisor.idle();
    expect(supervisor.running).toEqual([owner]);
    expect(await storeStatus(db, owner)).toBe('degraded');
    expect((await openAlerts(db, owner)).map((alert) => alert.kind)).toEqual([
      'webhook_secret_missing',
    ]);

    world.deliver(wraps.order);
    world.deliver(wraps.receipt);
    await waitFor(
      async () => (await storedLedger(db, owner)).orders[wraps.key]?.webhook?.state === 'pending',
      'the webhook queued',
    );
    expect(sends).toEqual([]);

    const directory = new StoreDirectory({
      db,
      vault: keys,
      inboxRelays: [RELAY],
      rpcs: { mainnet: { evm: {} }, devnet: { solana: SOLANA_RPC, evm: {} } },
      now: () => NOW,
    });
    const rotated = await directory.rotateWebhookSecret(owner);
    if (!rotated.ok) {
      throw new Error('rotation refused');
    }
    await requests.drain(owner);
    await waitFor(
      async () => (await storedLedger(db, owner)).orders[wraps.key]?.webhook?.state === 'sent',
      'the webhook sent',
    );
    const [send] = sends;
    const verified = await verifyWebhook({
      secret: rotated.secret,
      body: send?.body ?? '',
      headers: send?.headers ?? {},
      now: NOW,
    });
    expect(verified.ok).toBe(true);
    expect(await storeStatus(db, owner)).toBe('active');
    expect(await openAlerts(db, owner)).toEqual([]);
  });

  it('signs with the new secret only after a rotation', async () => {
    const { db, keys, world, wraps, rpc, owner } = await paidStore({
      webhookSecret: WEBHOOK_SECRET,
    });
    const sends: { headers: Record<string, string>; body: string }[] = [];
    let answer = 500;
    const holder = newHolderId();
    let clock = NOW;
    const { supervisor } = testSupervisor(db, keys, holder, world, rpc, {
      now: () => clock,
      webhookSlots: {
        forStore: () => async (_url, init) => {
          sends.push({
            headers: init.headers as Record<string, string>,
            body: String(init.body),
          });
          return new Response(null, { status: answer });
        },
      },
    });
    supervisors.push(supervisor);
    const requests = new HolderRequests({
      db,
      supervisor,
      setup: testSetupDeps(db, keys, world, { now: () => clock }),
    });
    supervisor.reconcile(await lease(db, holder));
    await supervisor.idle();
    world.deliver(wraps.order);
    world.deliver(wraps.receipt);
    await waitFor(() => sends.length === 1, 'the first send (refused)');
    const old = await verifyWebhook({
      secret: WEBHOOK_SECRET,
      body: sends[0]?.body ?? '',
      headers: sends[0]?.headers ?? {},
      now: NOW,
    });
    expect(old.ok).toBe(true);

    const directory = new StoreDirectory({
      db,
      vault: keys,
      inboxRelays: [RELAY],
      rpcs: { mainnet: { evm: {} }, devnet: { solana: SOLANA_RPC, evm: {} } },
      now: () => clock,
    });
    const rotated = await directory.rotateWebhookSecret(owner);
    if (!rotated.ok) {
      throw new Error('rotation refused');
    }
    answer = 200;
    clock = NOW + 120;
    await requests.drain(owner);
    await waitFor(() => sends.length === 2, 'the send after the rotation');
    const send = sends[1];
    const input = { body: send?.body ?? '', headers: send?.headers ?? {}, now: clock };
    expect((await verifyWebhook({ ...input, secret: rotated.secret })).ok).toBe(true);
    expect((await verifyWebhook({ ...input, secret: WEBHOOK_SECRET })).ok).toBe(false);
  });

  it('runs a store whose rail has no operator RPC without it, degraded with an alert', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const { owner } = await seedStore(db, keys);
    const node = holderOn(db, keys, world, { rpcs: { devnet: { tempo: TEMPO_RPC } } });
    await serveAll(node);
    expect(node.supervisor.running).toEqual([owner.pubkey]);
    expect(await storeStatus(db, owner.pubkey)).toBe('degraded');
    const alerts = await openAlerts(db, owner.pubkey);
    expect(alerts.map((alert) => alert.kind)).toEqual(['rail_unavailable']);
    expect(alerts[0]?.message).toContain('solana-devnet');
    expect(SOLANA_PAYOUTS[0]?.caip19).toBe(USDC_DEVNET_CAIP19);
  });
});

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { KIND_PAYTO, KIND_STORE_AUTH, paytoProofMessage } from '@elisym/commerce';
import { verifyWebhook } from '@elisym/commerce/webhook';
import { OFFER_RELAYS } from '@merchant-node/constants';
import { type LedgerState, emptyLedger } from '@merchant-node/ledger';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OTHER_TREASURY,
  chain,
  landedPayment,
  requestFor,
  signatureOf,
} from '../../merchant-node/tests/fixtures';
import { getRequest } from '../src/admin/requests';
import type { Db } from '../src/db/db';
import type { KeyVault } from '../src/db/keys';
import { HolderRequests, MAX_SETUP_ATTEMPTS } from '../src/node/holder-requests';
import { RequestPump } from '../src/node/request-pump';
import {
  DRIFT_CHECK_SECS,
  type StoreSupervisor,
  type SupervisorDeps,
} from '../src/node/supervisor';
import { commitOwnerEvent, prepareOwnerEvent } from '../src/owner-events';
import { activateStore } from '../src/state/activation';
import { newHolderId } from '../src/state/leases';
import { StoreDirectory } from '../src/state/stores';
import { submitRequest } from './helpers/node-requests';
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
  insertOwnerEvent,
  key,
  lease,
  openAlerts,
  orderWraps,
  ownerEvents,
  publishedStore,
  seedStore,
  sellingLedger,
  storeStatus,
  storedLedger,
  testHeal,
  testSetupDeps,
  settle,
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
const NEXT_PAYOUTS = [{ caip19: USDC_DEVNET_CAIP19, address: OTHER_TREASURY }];

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

describe('record requests replaced or refused (step 12)', () => {
  it('marks a record request of an event a newer committed one replaced, without a pass (H7)', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const owner = seed.owner.pubkey;
    const older = ownerEvents(seed.owner, seed.store, NEXT_PAYOUTS, NOW - 120).payoutList;
    const newer = ownerEvents(seed.owner, seed.store, SOLANA_PAYOUTS, NOW - 60).payoutList;
    await insertOwnerEvent(db, owner, older, JSON.stringify(NEXT_PAYOUTS), false);
    await db.query('update owner_events set committed_at = $2 where id = $1', [older.id, NOW - 1]);
    await insertOwnerEvent(db, owner, newer, JSON.stringify(SOLANA_PAYOUTS), false);
    const node = holderOn(db, keys, world);
    await serveAll(node);
    const id = await submitRequest(db, owner, 'record_owner_event', { eventId: older.id }, NOW);
    const version = await rowVersion(db, owner);
    expect(await node.requests.drain(owner)).toEqual([id]);
    const request = await requestRow(db, owner, id);
    expect(request.state).toBe('applied');
    expect(request.result).toEqual({ recorded: false, replacedBy: newer.id });
    expect(world.events.some((event) => event.id === older.id || event.id === newer.id)).toBe(
      false,
    );
    expect(await rowVersion(db, owner)).toBe(version);
  });

  it('names the remedy in the setup_failed alert when the relays serve a newer payout list (minor 5)', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const owner = seed.owner.pubkey;
    const committed = ownerEvents(seed.owner, seed.store, NEXT_PAYOUTS, NOW - 120).payoutList;
    await insertOwnerEvent(db, owner, committed, JSON.stringify(NEXT_PAYOUTS), false);
    // R1 drift: a newer list by O that the server never committed.
    world.add(ownerEvents(seed.owner, seed.store, SOLANA_PAYOUTS, NOW - 60).payoutList);
    let clock = NOW;
    const node = holderOn(db, keys, world, {}, { now: () => clock });
    await serveAll(node);
    const id = await submitRequest(db, owner, 'record_owner_event', { eventId: committed.id }, NOW);
    for (let attempt = 1; attempt < MAX_SETUP_ATTEMPTS; attempt += 1) {
      await expect(node.requests.drain(owner)).rejects.toThrow('the signed payout list');
      clock += 30 * 2 ** (attempt - 1);
    }
    await node.requests.drain(owner);
    expect((await requestRow(db, owner, id)).state).toBe('failed');
    const alert = (await openAlerts(db, owner)).find((entry) => entry.kind === 'setup_failed');
    expect(alert?.message).toContain('the signed payout list');
    expect(alert?.message).toContain('re-signs the payout list in the admin');
  });

  it('names no payout-list remedy for another setup failure', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const owner = seed.owner.pubkey;
    let clock = NOW;
    const node = holderOn(db, keys, world, {}, { now: () => clock });
    await serveAll(node);
    world.refuse = () => true;
    await submitRequest(db, owner, 'setup', {}, NOW);
    for (let attempt = 1; attempt <= MAX_SETUP_ATTEMPTS; attempt += 1) {
      await node.requests.drain(owner).catch(() => undefined);
      clock += 30 * 2 ** (attempt - 1);
    }
    const alert = (await openAlerts(db, owner)).find((entry) => entry.kind === 'setup_failed');
    expect(alert?.message).toContain('nothing reached');
    expect(alert?.message).not.toContain('Remedy');
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

  it('keeps a setup request that cannot publish pending, retried with backoff, then fails it with an alert', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const owner = seed.owner.pubkey;
    let clock = NOW;
    const node = holderOn(db, keys, world, {}, { now: () => clock });
    await serveAll(node);
    world.refuse = () => true;
    const id = await submitRequest(db, owner, 'setup', {}, NOW);
    for (let attempt = 1; attempt < MAX_SETUP_ATTEMPTS; attempt += 1) {
      await expect(node.requests.drain(owner)).rejects.toThrow('nothing reached a relay');
      expect((await requestRow(db, owner, id)).state).toBe('pending');
      // Not due yet: the drain leaves it alone.
      expect(await node.requests.drain(owner)).toEqual([]);
      clock += 30 * 2 ** (attempt - 1);
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

  it('keeps a record request pending while its committed payout list reaches no relay', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const owner = seed.owner.pubkey;
    let clock = NOW;
    const node = holderOn(db, keys, world, {}, { now: () => clock });
    await serveAll(node);
    const next = ownerEvents(seed.owner, seed.store, NEXT_PAYOUTS, NOW - 60);
    await insertOwnerEvent(db, owner, next.payoutList, JSON.stringify(NEXT_PAYOUTS), false);
    const id = await submitRequest(
      db,
      owner,
      'record_owner_event',
      { eventId: next.payoutList.id },
      NOW,
    );
    await db.query("update products set price_usd = '2' where owner = $1", [owner]);
    let listAttempts = 0;
    world.refuse = (event) => {
      if (event.id !== next.payoutList.id) {
        return false;
      }
      listAttempts += 1;
      return true;
    };

    await expect(node.requests.drain(owner)).rejects.toThrow('payout list reached no relay');
    expect((await requestRow(db, owner, id)).state).toBe('pending');
    const saved = await storedLedger(db, owner);
    // What did go out (the new price) is recorded; the active list is the old one.
    expect(
      saved.terms.some((period) => period.terms.amount === '2000000' && period.until === undefined),
    ).toBe(true);
    expect(JSON.parse(saved.payto?.payouts ?? '')).toEqual(SOLANA_PAYOUTS);
    const tried = listAttempts;
    expect(await node.requests.drain(owner)).toEqual([]);
    expect(listAttempts).toBe(tried);

    clock += 30;
    // Only the payout list could go out now: nothing reached a relay, still pending.
    await expect(node.requests.drain(owner)).rejects.toThrow('nothing reached a relay');
    expect(listAttempts).toBeGreaterThan(tried);
    expect((await requestRow(db, owner, id)).state).toBe('pending');

    world.refuse = () => false;
    clock += 60;
    expect(await node.requests.drain(owner)).toEqual([id]);
    expect((await requestRow(db, owner, id)).result).toMatchObject({ payoutListOut: true });
    expect(JSON.parse((await storedLedger(db, owner)).payto?.payouts ?? '')).toEqual(NEXT_PAYOUTS);
    const [row] = await db.query<{ recorded: boolean }>(
      'select recorded from owner_events where id = $1',
      [next.payoutList.id],
    );
    expect(row?.recorded).toBe(true);
  });

  it('keeps a setup request pending while the 10050 naming new inbox relays reaches no default relay', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const owner = seed.owner.pubkey;
    const newRelay = 'wss://inbox-two.example.com';
    const allowlist = [RELAY, newRelay];
    await db.query('update store_config set draft_inbox_relays = $2 where owner = $1', [
      owner,
      [newRelay],
    ]);
    let clock = NOW;
    const node = holderOn(
      db,
      keys,
      world,
      { inboxRelayAllowlist: allowlist },
      { inboxRelayAllowlist: allowlist, now: () => clock },
    );
    await serveAll(node);
    world.refuse = (event, relay) => event.kind === 10050 && OFFER_RELAYS.includes(relay);
    const activeRelays = async () =>
      (
        await db.query<{ inbox_relays: string[] }>(
          'select inbox_relays from store_config where owner = $1',
          [owner],
        )
      )[0]?.inbox_relays;

    const id = await submitRequest(db, owner, 'setup', {}, NOW);
    await expect(node.requests.drain(owner)).rejects.toThrow('reached no default relay');
    expect((await requestRow(db, owner, id)).state).toBe('pending');
    expect(await activeRelays()).toEqual([RELAY]);
    // Not due yet: left alone.
    expect(await node.requests.drain(owner)).toEqual([]);

    world.refuse = () => false;
    clock += 30;
    expect(await node.requests.drain(owner)).toEqual([id]);
    expect((await requestRow(db, owner, id)).state).toBe('applied');
    expect(await activeRelays()).toEqual([newRelay]);

    // A move that never gets out fails for good after MAX_SETUP_ATTEMPTS, with an alert.
    await db.query('update store_config set draft_inbox_relays = $2 where owner = $1', [
      owner,
      [RELAY],
    ]);
    world.refuse = (event, relay) => event.kind === 10050 && OFFER_RELAYS.includes(relay);
    const next = await submitRequest(db, owner, 'setup', {}, NOW);
    for (let attempt = 1; attempt < MAX_SETUP_ATTEMPTS; attempt += 1) {
      await expect(node.requests.drain(owner)).rejects.toThrow('reached no default relay');
      expect((await requestRow(db, owner, next)).state).toBe('pending');
      clock += 30 * 2 ** (attempt - 1);
    }
    expect(await node.requests.drain(owner)).toEqual([next]);
    expect((await requestRow(db, owner, next)).state).toBe('failed');
    expect((await openAlerts(db, owner)).map((alert) => alert.kind)).toContain('setup_failed');
  });

  it('applies a hand answer while an earlier setup request keeps failing', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const buyer = key();
    const orderKey = `${buyer.pubkey}:${ORDER_ID}`;
    const state = seed.state ?? sellingLedger();
    state.orders[orderKey] = {
      key: orderKey,
      buyerPubkey: buyer.pubkey,
      orderId: ORDER_ID,
      rumorId: 'r'.repeat(64),
      createdAt: NOW - 600,
      reference: 'ref',
      product: `30402:${seed.store.pubkey}:${PRODUCT.d}`,
      reportedTxs: [],
    };
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, { ...seed, state });
    const owner = seed.owner.pubkey;
    const node = holderOn(db, keys, world);
    await serveAll(node);
    // Every setup publish is refused; the buyer's answer (a gift wrap) is taken.
    world.refuse = (event) => event.kind !== 1059;
    const setup = await submitRequest(db, owner, 'setup', {}, NOW);
    const second = await submitRequest(db, owner, 'setup', {}, NOW);
    const hand = await submitRequest(
      db,
      owner,
      'hand_answer',
      { key: orderKey, request: { kind: 'delivered' } },
      NOW,
    );
    await expect(node.requests.drain(owner)).rejects.toThrow('nothing reached a relay');
    expect((await requestRow(db, owner, hand)).state).toBe('applied');
    expect(wrapsTo(world, buyer.pubkey)).toHaveLength(1);
    expect((await requestRow(db, owner, setup)).state).toBe('pending');
    // The setup lane keeps its order: the later setup request waits behind the failing one.
    expect((await requestRow(db, owner, second)).state).toBe('pending');
  });

  it('holds the later setup-lane requests while the first waits for its backoff (H12)', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const owner = seed.owner.pubkey;
    let clock = NOW;
    const node = holderOn(db, keys, world, {}, { now: () => clock });
    await serveAll(node);
    world.refuse = () => true;
    const setup = await submitRequest(db, owner, 'setup', {}, NOW);
    // Applies without a pass (its event is recorded), but only in its turn.
    const record = await submitRequest(
      db,
      owner,
      'record_owner_event',
      { eventId: seed.ownerEvents?.[0]?.event.id },
      NOW,
    );
    await expect(node.requests.drain(owner)).rejects.toThrow('nothing reached a relay');
    expect((await requestRow(db, owner, record)).state).toBe('pending');
    expect(await node.requests.drain(owner)).toEqual([]);
    expect((await requestRow(db, owner, record)).state).toBe('pending');

    world.refuse = () => false;
    clock += 30;
    expect(await node.requests.drain(owner)).toEqual([setup, record]);
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

describe('stores drained on their own (M2)', () => {
  it("never delays a store's requests behind another store's control task that hangs", async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const store = key();
    const buyer = key();
    const { state, orderKey } = ledgerWithOpenOrder(store, buyer);
    const healthy = await seedStore(db, keys, { store, state });
    const stuck = await seedStore(db, keys);
    const stuckKeys = [stuck.owner.pubkey, stuck.store.pubkey];
    let release: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = false;
    let hanging = false;
    let clock = NOW;
    const node = holderOn(db, keys, world, {
      now: () => clock,
      // The stuck store's periodic check never gets its public read answered.
      publicReads: () => {
        const pool = world.pool();
        const query = pool.querySync.bind(pool);
        pool.querySync = async (relays, filter) => {
          if (armed && filter.authors?.some((author) => stuckKeys.includes(author)) === true) {
            hanging = true;
            await hung;
          }
          return query(relays, filter);
        };
        return pool;
      },
    });
    await serveAll(node);
    const pump = new RequestPump({ db, holder: node.requests, log: () => undefined });
    let stuckRestart = '';
    try {
      armed = true;
      clock += DRIFT_CHECK_SECS;
      // The poll's round ends although the stuck store's check (a control task) hangs.
      await pump.kick(true);
      await waitFor(() => hanging, 'the stuck check');

      stuckRestart = await submitRequest(db, stuck.owner.pubkey, 'restart', {}, NOW);
      const hand = await submitRequest(
        db,
        healthy.owner.pubkey,
        'hand_answer',
        { key: orderKey, request: { kind: 'delivered' } },
        NOW,
      );
      await pump.kick(false);
      await waitFor(
        async () => (await requestRow(db, healthy.owner.pubkey, hand)).result !== undefined,
        'the hand answer sent',
      );
      expect(wrapsTo(world, buyer.pubkey)).toHaveLength(1);

      // A later notify starts a new round while the stuck store still hangs.
      const restart = await submitRequest(db, healthy.owner.pubkey, 'restart', {}, NOW);
      await pump.kick(false);
      await waitFor(
        async () => (await requestRow(db, healthy.owner.pubkey, restart)).state === 'applied',
        'the second request applied',
      );
      expect((await requestRow(db, stuck.owner.pubkey, stuckRestart)).state).toBe('pending');
    } finally {
      // Never leave the stuck queue hanging (the supervisor's shutdown waits for it).
      release?.();
      await node.requests.idle();
      await pump.stop();
    }
    expect((await requestRow(db, stuck.owner.pubkey, stuckRestart)).state).toBe('applied');
  });

  it('folds a kick during a drain into one more drain right after it', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const { owner: ownerKey } = await seedStore(db, keys);
    const owner = ownerKey.pubkey;
    const node = holderOn(db, keys, world);
    await serveAll(node);
    let release: (() => void) | undefined;
    const held = node.supervisor.applyControl(
      owner,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await waitFor(() => release !== undefined, 'the held queue');
    const first = await submitRequest(db, owner, 'restart', {}, NOW);
    const drained = node.requests.kick(owner);
    // The drain read its requests and waits on the queue; a request queued now is not among them.
    await settle(100);
    const second = await submitRequest(db, owner, 'restart', {}, NOW);
    expect(node.requests.kick(owner)).toBe(drained);
    release?.();
    await held;
    await drained;
    expect((await requestRow(db, owner, first)).state).toBe('applied');
    expect((await requestRow(db, owner, second)).state).toBe('applied');
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

describe('hand answers whose publish throws (M3)', () => {
  it('writes the failure once, never holds the pending requests and never restarts the node again for it', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const store = key();
    const buyer = key();
    const { state, orderKey } = ledgerWithOpenOrder(store, buyer);
    const { owner: ownerKey } = await seedStore(db, keys, { store, state });
    const owner = ownerKey.pubkey;
    const node = holderOn(db, keys, world);
    const pools = testSetupDeps(db, keys, world).pools;
    const requests = new HolderRequests({
      db,
      supervisor: node.supervisor,
      setup: testSetupDeps(db, keys, world, {
        pools: {
          open: (storePubkey) => {
            if (storePubkey === store.pubkey) {
              throw new Error('relays down');
            }
            return pools.open(storePubkey);
          },
          close: (storePubkey) => pools.close(storePubkey),
        },
      }),
      log: () => undefined,
    });
    await serveAll(node);
    const hand = await submitRequest(
      db,
      owner,
      'hand_answer',
      { key: orderKey, request: { kind: 'delivered' } },
      NOW,
    );
    const restart = await submitRequest(db, owner, 'restart', {}, NOW);

    await expect(requests.drain(owner)).rejects.toThrow('relays down');
    expect((await requestRow(db, owner, hand)).state).toBe('applied');
    // Its lane keeps its order (H1): the restart queued after it waits.
    expect((await requestRow(db, owner, restart)).state).toBe('pending');

    // The next drain sends it again once: the failure is its outcome, the restart applied.
    expect(await requests.drain(owner)).toEqual([restart]);
    expect((await requestRow(db, owner, hand)).result).toEqual({
      done: false,
      problem: 'relays down',
    });
    expect((await requestRow(db, owner, restart)).state).toBe('applied');

    const node1 = node.supervisor.nodeOf(owner);
    expect(await requests.drain(owner)).toEqual([]);
    expect(node.supervisor.nodeOf(owner)).toBe(node1);
    expect(wrapsTo(world, buyer.pubkey)).toHaveLength(0);
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

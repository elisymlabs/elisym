/**
 * Smoke (phase 2 step 12): the hosted admin's browser client and its local
 * logic (`merchant-admin/src/hosted/lib`) through the real admin API on
 * pglite with a real owner key, the whole way: create -> config with real
 * wallet proofs -> 10133 -> 30490 -> operator activation -> setup pass ->
 * a product -> an order in the ledger -> the orders view -> a hand answer the
 * holder applies.
 */
import { KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import { type HostedApi, createHostedApi } from '@hosted-admin/api';
import { handInput } from '@hosted-admin/hand-answer';
import { orderEntries } from '@hosted-admin/orders';
import { checkOwnerTemplate } from '@hosted-admin/owner-event-check';
import { finishCommit, requestOutcome } from '@hosted-admin/owner-flow';
import { secretKeySigner } from '@hosted-admin/signer';
import type { OwnerEventKind, Payout } from '@hosted-admin/types';
import { afterEach, describe, expect, it } from 'vitest';
import { chain } from '../../merchant-node/tests/fixtures';
import { createAdminApi } from '../src/admin/api';
import type { Db } from '../src/db/db';
import type { KeyVault } from '../src/db/keys';
import { HolderRequests } from '../src/node/holder-requests';
import type { StoreSupervisor } from '../src/node/supervisor';
import { activateStore } from '../src/state/activation';
import { newHolderId } from '../src/state/leases';
import { serializeLedger } from '../src/state/ledger-store';
import { StoreDirectory } from '../src/state/stores';
import {
  NOW,
  RELAY,
  SOLANA_RPC,
  USDC_DEVNET_CAIP19,
  key,
  lease,
  storedLedger,
  testHeal,
  testSetupDeps,
  testSupervisor,
  vault,
} from './helpers/node-store';
import { RelayWorld } from './helpers/node-world';
import { freshDb } from './pglite-db';
import { BASE, OPERATOR, solanaWallet } from './stores-fixtures';

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-00000000c0de';

const supervisors: StoreSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
});

/** The admin client over the real admin API; queued requests answer at once (202), the test drains them. */
function client(db: Db, keys: KeyVault, secretKey: Uint8Array): HostedApi {
  const directory = new StoreDirectory({
    db,
    vault: keys,
    inboxRelays: [RELAY],
    rpcs: { mainnet: { evm: {} }, devnet: { solana: SOLANA_RPC, evm: {} } },
    now: () => NOW,
  });
  const admin = createAdminApi({
    directory,
    db,
    publicBase: BASE,
    operator: OPERATOR,
    now: () => NOW,
    requestWaitMs: 0,
  });
  return createHostedApi({
    base: BASE,
    signer: secretKeySigner(secretKey),
    localNow: () => NOW,
    fetch: async (input, init) => {
      const answer =
        (await admin({ request: new Request(input, init), clientAddress: '203.0.113.7' })) ??
        new Response('{"error":"not_found"}', { status: 404 });
      const headers = new Headers(answer.headers);
      headers.set('date', new Date(NOW * 1000).toUTCString());
      return new Response(await answer.text(), { status: answer.status, headers });
    },
  });
}

/** A holder over `db`: its supervisor serves every store it leases, its requests drain on demand. */
async function holderOn(db: Db, keys: KeyVault, world: RelayWorld): Promise<HolderRequests> {
  const holder = newHolderId();
  const { heal } = testHeal(db, keys, world);
  const { supervisor, logs } = testSupervisor(db, keys, holder, world, chain({}).rpc, { heal });
  supervisors.push(supervisor);
  const requests = new HolderRequests({
    db,
    supervisor,
    setup: testSetupDeps(db, keys, world),
    log: (line) => logs.push(line),
  });
  supervisor.reconcile(await lease(db, holder));
  await supervisor.idle();
  return requests;
}

describe('the hosted admin, end to end against the real server', () => {
  it('creates, configures, signs, activates, sells, and answers an order by hand', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const owner = key();
    const signer = secretKeySigner(owner.secretKey);
    const api = client(db, keys, owner.secretKey);

    // Create, then the first config with a real wallet proof.
    const created = await api.createStore({ name: 'Smoke shop', network: 'devnet' });
    expect(created.status).toBe('pending');
    const wallet = solanaWallet();
    const payouts: Payout[] = [
      {
        caip19: USDC_DEVNET_CAIP19,
        address: wallet.address,
        signature: wallet.prove(owner.pubkey, USDC_DEVNET_CAIP19),
      },
    ];
    await api.putConfig({
      name: 'Smoke shop',
      payouts,
      inboxRelays: [RELAY],
      expectedRevision: created.config?.revision ?? -1,
    });

    // Both owner events: prepared by the server, checked locally, signed with O, committed.
    const signOwnerEvent = async (kind: OwnerEventKind) => {
      const { template } = await api.prepareOwnerEvent(kind);
      const checked = checkOwnerTemplate({
        kind,
        template,
        payouts,
        storePubkey: created.storePubkey,
        operator: OPERATOR,
        localNow: NOW,
      });
      if (!checked.ok) {
        throw new Error(`the real template of kind ${kind} failed the check: ${checked.problem}`);
      }
      const event = await signer.signEvent(checked.template);
      const answer = await api.commitOwnerEvent(event);
      expect(requestOutcome(answer.request, true)).toEqual({ kind: 'on_activation' });
      return event;
    };
    const paytoEvent = await signOwnerEvent(KIND_PAYTO);
    const authEvent = await signOwnerEvent(KIND_STORE_AUTH);

    // The operator activates; a holder's setup pass publishes both.
    await db.query("insert into tiers (name, max_products) values ('basic', 10)");
    expect((await activateStore(db, owner.pubkey, { tier: 'basic', now: NOW })).ok).toBe(true);
    const first = await holderOn(db, keys, world);
    await first.drainAll();
    const live = await api.store();
    expect(live.status).toBe('active');
    expect(live.ownerEvents).toMatchObject({
      payto: { event: paytoEvent, publishedAt: NOW },
      auth: { event: authEvent, publishedAt: NOW },
    });

    // A product, through the client, published by the holder.
    const put = await api.putProduct('socks', {
      title: 'Warm socks',
      description: 'Wool.',
      priceUsd: '12.50',
      onSale: true,
    });
    expect(put.product).toMatchObject({ d: 'socks', title: 'Warm socks', onSale: true });
    await first.drainAll();
    expect(
      world.events.some(
        (event) =>
          event.kind === 30402 && event.tags.some((tag) => tag[0] === 'd' && tag[1] === 'socks'),
      ),
    ).toBe(true);
    await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));

    // A buyer's order with a payment the node could not match, in the ledger as a node writes it.
    const buyer = key();
    const orderKey = `${buyer.pubkey}:${ORDER_ID}`;
    const state = await storedLedger(db, owner.pubkey);
    state.orders[orderKey] = {
      key: orderKey,
      buyerPubkey: buyer.pubkey,
      orderId: ORDER_ID,
      rumorId: 'r'.repeat(64),
      createdAt: NOW - 600,
      reference: 'ref',
      product: `30402:${created.storePubkey}:socks`,
      email: 'buyer@example.com',
      reportedTxs: [],
    };
    state.unresolvedPayments.push({ key: orderKey, tx: '3'.repeat(88), at: NOW - 500 });
    await db.query('update ledgers set state = $2 where owner = $1', [
      owner.pubkey,
      serializeLedger(state),
    ]);

    // The orders view, through the client, as the Orders tab reads it.
    const [entry] = orderEntries(await api.orders());
    expect(entry).toMatchObject({
      key: orderKey,
      orderId: ORDER_ID,
      state: 'unresolved',
      order: { productTitle: 'Warm socks', email: 'buyer@example.com' },
      unresolved: [{ tx: '3'.repeat(88) }],
    });

    // The hand answer, built as the form builds it; a new holder serves the store and applies it.
    const built = handInput({ kind: 'complete', tx: '', amount: '', caip19: '' });
    if (!built.ok) {
      throw new Error(built.message);
    }
    const answer = await api.handAnswer(orderKey, built.input);
    expect(answer.request.state).toBe('pending');
    const second = await holderOn(db, keys, world);
    await second.drainAll();
    const finished = await finishCommit(api, requestOutcome(answer.request, false), {
      sleep: async () => undefined,
    });
    expect(finished).toMatchObject({ tone: 'info' });
    expect(finished.stillId).toBeUndefined();

    const after = await api.orders();
    expect(after.answeredByHand[orderKey]).toEqual({ kind: 'delivered' });
    expect(after.unresolvedPayments).toEqual([]);
    expect(orderEntries(after).map((answered) => [answered.orderId, answered.state])).toEqual([
      [ORDER_ID, 'answered'],
    ]);
    expect(
      world.events.some(
        (event) =>
          event.kind === 1059 &&
          event.tags.some((tag) => tag[0] === 'p' && tag[1] === buyer.pubkey),
      ),
    ).toBe(true);
  });
});

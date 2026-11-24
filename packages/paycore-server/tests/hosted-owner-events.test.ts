/**
 * The hosted admin's owner-event flow (A13) against the real server: its
 * browser client and its local template check (`merchant-admin/src/hosted/lib`)
 * through the real admin API on pglite, a pending store's commits answered 202,
 * then the operator's activation and a holder's setup pass publishing them.
 */
import { KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import { type HostedApi, createHostedApi } from '@hosted-admin/api';
import { checkOwnerTemplate } from '@hosted-admin/owner-event-check';
import { secretKeySigner } from '@hosted-admin/signer';
import type { Payout } from '@hosted-admin/types';
import { afterEach, describe, expect, it } from 'vitest';
import { chain } from '../../merchant-node/tests/fixtures';
import { createAdminApi } from '../src/admin/api';
import type { Db } from '../src/db/db';
import { HolderRequests } from '../src/node/holder-requests';
import type { StoreSupervisor } from '../src/node/supervisor';
import { activateStore } from '../src/state/activation';
import { newHolderId } from '../src/state/leases';
import { StoreDirectory } from '../src/state/stores';
import {
  NOW,
  RELAY,
  SOLANA_RPC,
  USDC_DEVNET_CAIP19,
  key,
  lease,
  testHeal,
  testSetupDeps,
  testSupervisor,
  vault,
} from './helpers/node-store';
import { RelayWorld } from './helpers/node-world';
import { freshDb } from './pglite-db';
import { BASE, OPERATOR, solanaWallet } from './stores-fixtures';

const supervisors: StoreSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
});

/** The admin client over the real admin API, answers dated by the server clock. */
function client(db: Db, secretKey: Uint8Array): HostedApi {
  const directory = new StoreDirectory({
    db,
    vault: vault(),
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
  });
  return createHostedApi({
    base: BASE,
    signer: secretKeySigner(secretKey),
    localNow: () => NOW,
    fetch: async (input, init) => {
      const answer =
        (await admin({ request: new Request(input, init), clientAddress: '203.0.113.9' })) ??
        new Response('{"error":"not_found"}', { status: 404 });
      const headers = new Headers(answer.headers);
      headers.set('date', new Date(NOW * 1000).toUTCString());
      return new Response(await answer.text(), { status: answer.status, headers });
    },
  });
}

describe('the hosted owner-event flow against the real server', () => {
  it('checks, signs and commits both owner events of a pending store; activation publishes them', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const owner = key();
    const signer = secretKeySigner(owner.secretKey);
    const api = client(db, owner.secretKey);

    const created = await api.createStore({ name: 'Shop', network: 'devnet' });
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
      name: 'Shop',
      payouts,
      inboxRelays: [RELAY],
      expectedRevision: created.config?.revision ?? -1,
    });
    expect((await api.store()).payouts).toEqual({ needsSigning: true });

    const check = (
      kind: typeof KIND_PAYTO | typeof KIND_STORE_AUTH,
      template: unknown,
      operator = OPERATOR,
    ) =>
      checkOwnerTemplate({
        kind,
        template,
        payouts,
        storePubkey: created.storePubkey,
        operator,
        localNow: NOW,
      });

    const payto = await api.prepareOwnerEvent(KIND_PAYTO);
    const paytoChecked = check(KIND_PAYTO, payto.template);
    if (!paytoChecked.ok) {
      throw new Error(`the real payout list failed the check: ${paytoChecked.problem}`);
    }
    // A payout list that is not the rows is refused, the real one is not.
    expect(
      checkOwnerTemplate({
        kind: KIND_PAYTO,
        template: payto.template,
        payouts: [{ ...payouts[0], address: wallet.address.toLowerCase() } as Payout],
        storePubkey: created.storePubkey,
        operator: OPERATOR,
        localNow: NOW,
      }),
    ).toEqual({ ok: false, problem: 'payouts' });
    const paytoEvent = await signer.signEvent(paytoChecked.template);
    // A pending store: the commit is taken and waits for activation.
    expect(await api.commitOwnerEvent(paytoEvent)).toEqual({
      id: paytoEvent.id,
      request: { id: expect.any(String), state: 'pending' },
    });

    const auth = await api.prepareOwnerEvent(KIND_STORE_AUTH);
    expect(check(KIND_STORE_AUTH, auth.template, 'other.example')).toEqual({
      ok: false,
      problem: 'operator',
    });
    const authChecked = check(KIND_STORE_AUTH, auth.template);
    if (!authChecked.ok) {
      throw new Error(`the real authorization failed the check: ${authChecked.problem}`);
    }
    const authEvent = await signer.signEvent(authChecked.template);
    expect((await api.commitOwnerEvent(authEvent)).request?.state).toBe('pending');

    const pending = await api.store();
    expect(pending.payouts).toEqual({ needsSigning: false });
    expect(pending.ownerEvents).toMatchObject({
      payto: { event: paytoEvent, publishedAt: null },
      auth: { event: authEvent, publishedAt: null },
    });

    await db.query("insert into tiers (name, max_products) values ('basic', 10)");
    expect((await activateStore(db, owner.pubkey, { tier: 'basic', now: NOW })).ok).toBe(true);
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
    await requests.drainAll();

    const live = await api.store();
    expect(live.status).toBe('active');
    expect(live.ownerEvents).toMatchObject({
      payto: { event: paytoEvent, publishedAt: NOW },
      auth: { event: authEvent, publishedAt: NOW },
    });
    expect(world.events.some((event) => event.id === paytoEvent.id)).toBe(true);
    expect(world.events.some((event) => event.id === authEvent.id)).toBe(true);
  });
});

import { KIND_PAYTO, KIND_STORE_AUTH, buildStoreRevocationEvent } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { pendingRequests } from '../src/admin/requests';
import { type Db, STORES_CHANNEL } from '../src/db/db';
import { commitOwnerEvent, prepareOwnerEvent } from '../src/owner-events';
import { acquireLeases } from '../src/state/leases';
import { StoreMovedError } from '../src/state/move-rows';
import { moveStore, prepareMove, samePayoutSet } from '../src/state/moves';
import {
  VAULT,
  insertOwnerEvent,
  latestMoveRow,
  movableStore,
  moveDeps,
  moved,
  preparedMove,
  provenPayouts,
  signMove,
  testClock,
} from './move-fixtures';
import { freshDb } from './pglite-db';
import {
  NOW,
  OPERATOR,
  USDC_DEVNET,
  directoryFor,
  ownerKeys,
  solanaWallet,
} from './stores-fixtures';

const CHILD_TABLES = [
  'store_keys',
  'store_config',
  'products',
  'ledgers',
  'leases',
  'admin_requests',
  'owner_events',
];

async function countOf(db: Db, table: string, owner: string): Promise<number> {
  const [row] = await db.query<{ count: number }>(
    `select count(*)::int as count from ${table} where owner = $1`,
    [owner],
  );
  return row?.count ?? 0;
}

/** A Db whose transactions report every statement (sql and params) to `onQuery`. */
function recording(db: Db, onQuery: (sql: string, params: unknown[]) => void): Db {
  return {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          ...tx,
          query: (sql, params) => {
            onQuery(sql, params ?? []);
            return tx.query(sql, params);
          },
        }),
      ),
  };
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !check(); turn += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

describe('store move: the happy path', () => {
  it('rekeys every row to the new owner, reseals the secrets, keeps O events and queues a setup', async () => {
    const db = await freshDb();
    const store = await movableStore(db, { webhook: true });
    const O = store.owner.pubkey;
    await acquireLeases(db, 'holder', NOW);
    const [lease] = await db.query<{ holder: string; epoch: number }>(
      'select holder, epoch from leases where owner = $1',
      [O],
    );
    const [revisionBefore] = await db.query<{ revision: number }>(
      'select revision from store_config where owner = $1',
      [O],
    );
    let notified = 0;
    const unlisten = await db.listen(STORES_CHANNEL, () => {
      notified += 1;
    });
    const to = ownerKeys();
    const deps = moveDeps(db, store.directory);
    // An owner-event draft of O's: it goes with O.
    expect(
      await prepareOwnerEvent({ db, operator: OPERATOR, now: () => NOW }, O, KIND_STORE_AUTH),
    ).toMatchObject({ ok: true });
    const { templates, result } = await moved(deps, store, to);

    expect(result).toMatchObject({
      ok: true,
      alreadyMoved: false,
      owner: to.pubkey,
      storePubkey: store.storePubkey,
      pending: false,
      switching: true,
    });
    for (const table of CHILD_TABLES) {
      expect(await countOf(db, table, O), table).toBe(0);
      expect(await countOf(db, table, to.pubkey), table).toBeGreaterThan(0);
    }
    // No draft of O's follows the store to O'.
    expect(await db.query('select owner from store_move_drafts')).toEqual([]);
    expect(await db.query('select owner from owner_event_drafts')).toEqual([]);
    // The lease keeps its holder and epoch: the old run stops on its owner fence.
    expect(
      await db.query('select holder, epoch from leases where owner = $1', [to.pubkey]),
    ).toEqual([lease]);
    // The secrets open under O' only.
    const [keys] = await db.query<{ store_key: Uint8Array; webhook_secret: Uint8Array }>(
      'select store_key, webhook_secret from store_keys where owner = $1',
      [to.pubkey],
    );
    if (keys === undefined) {
      throw new Error('no keys');
    }
    expect(getPublicKey(VAULT.open(keys.store_key, to.pubkey, 'store'))).toBe(store.storePubkey);
    expect(() => VAULT.open(keys.store_key, O, 'store')).toThrow();
    expect(Buffer.from(VAULT.open(keys.webhook_secret, to.pubkey, 'webhook')).length).toBe(64);
    expect(() => VAULT.open(keys.webhook_secret, O, 'webhook')).toThrow();
    // O's events kept aside; O''s committed unrecorded.
    const row = await latestMoveRow(db, store.storePubkey);
    expect(row?.old_events.map((event) => event.id).sort()).toEqual(
      [store.events.payto?.id, store.events.auth?.id].sort(),
    );
    expect(row).toMatchObject({
      from_owner: O,
      to_owner: to.pubkey,
      moved_at: NOW,
      switched_at: null,
      revocation_published_at: null,
    });
    expect(row?.revocation?.pubkey).toBe(O);
    const events = await db.query<{
      kind: number;
      recorded: boolean;
      payouts_string: string | null;
    }>('select kind, recorded, payouts_string from owner_events where owner = $1 order by kind', [
      to.pubkey,
    ]);
    expect(events).toEqual([
      {
        kind: KIND_PAYTO,
        recorded: false,
        payouts_string: JSON.stringify(provenPayouts(store.wallet, to.pubkey)),
      },
      { kind: KIND_STORE_AUTH, recorded: false, payouts_string: null },
    ]);
    expect(templates.payto.created_at).toBe(NOW);
    // The draft is the proven list; the revision moved on.
    const settings = await store.directory.settings(to.pubkey);
    expect(settings?.draftPayouts).toEqual(provenPayouts(store.wallet, to.pubkey));
    expect(settings?.revision).toBe((revisionBefore?.revision ?? 0) + 1);
    const queued = await pendingRequests(db, to.pubkey);
    expect(queued.map((request) => [request.kind, request.payload])).toEqual([
      ['setup', { moveFrom: O }],
    ]);
    expect(result.ok && result.requestId).toBe(queued[0]?.id);
    // The operator's `moved` alert stays on O; O' runs on, its alerts untouched.
    expect(
      await db.query('select owner, kind, cleared_at from alerts where kind = $1', ['moved']),
    ).toEqual([{ owner: O, kind: 'moved', cleared_at: null }]);
    expect(await store.directory.openAlertKinds(to.pubkey)).toEqual([]);
    expect((await store.directory.store(to.pubkey))?.status).toBe('active');
    await waitUntil(() => notified >= 2);
    expect(notified).toBe(2);
    await unlisten();
  });

  it('moves a store whose webhook secret was never set (it stays unset)', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const to = ownerKeys();
    const { result } = await moved(moveDeps(db, store.directory), store, to);
    expect(result.ok).toBe(true);
    expect(
      await db.query('select webhook_secret from store_keys where owner = $1', [to.pubkey]),
    ).toEqual([{ webhook_secret: null }]);
  });

  it('dates the new payout list after the active one and the revocation after every O authorization', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    await db.query(
      'update ledgers set state = jsonb_set(state::jsonb, $2, $3)::text where owner = $1',
      [store.owner.pubkey, '{payto,createdAt}', JSON.stringify(NOW + 2)],
    );
    const prepared = await preparedMove(moveDeps(db, store.directory), store, ownerKeys(), {
      newestAuthByOwner: NOW + 5,
    });
    // A same-second payout list would be refused by the setup pass (signedPayoutListProblem).
    expect(prepared.payto.created_at).toBe(NOW + 3);
    expect(prepared.revocation?.created_at).toBe(NOW + 6);
    expect(prepared.revocation?.tags).toEqual([
      ['d', store.storePubkey],
      ['p', store.storePubkey],
      ['mode', 'revoked'],
    ]);
    expect(prepared.auth.tags).toContainEqual(['mode', 'hosted', OPERATOR]);
  });

  it('answers the same move again with alreadyMoved and its setup request; another key gets moved', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const to = ownerKeys();
    const deps = moveDeps(db, store.directory);
    const { templates, result } = await moved(deps, store, to);
    const signed = signMove(templates, store.owner, to);
    const again = await moveStore(deps, store.owner.pubkey, { to: to.pubkey, ...signed });
    expect(again).toEqual({
      ok: true,
      alreadyMoved: true,
      owner: to.pubkey,
      storePubkey: store.storePubkey,
      pending: false,
      switching: true,
      requestId: result.ok ? result.requestId : 'none',
    });
    const other = ownerKeys();
    expect(
      await moveStore(deps, store.owner.pubkey, {
        to: other.pubkey,
        ...signMove(templates, store.owner, other),
      }),
    ).toMatchObject({ ok: false, error: 'moved' });
    expect(
      await prepareMove(deps, store.owner.pubkey, {
        to: other.pubkey,
        payouts: provenPayouts(store.wallet, other.pubkey),
      }),
    ).toMatchObject({ ok: false, error: 'moved' });
  });
});

describe('store move: refusals', () => {
  it('refuses a new key that has a store, moved one away, is a store key, or is O', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const deps = moveDeps(db, store.directory);
    const live = await movableStore(db);
    const former = await movableStore(db);
    const formerTo = ownerKeys();
    expect((await moved(moveDeps(db, former.directory), former, formerTo)).result.ok).toBe(true);
    const prepare = (to: string) =>
      prepareMove(deps, store.owner.pubkey, {
        to,
        payouts: provenPayouts(store.wallet, to),
      });
    for (const to of [
      live.owner.pubkey,
      former.owner.pubkey,
      store.storePubkey,
      live.storePubkey,
      store.owner.pubkey,
    ]) {
      expect(await prepare(to)).toMatchObject({ ok: false, error: 'taken' });
    }
  });

  it('refuses a commit whose new key got a store after the prepare (taken)', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const deps = moveDeps(db, store.directory);
    const to = ownerKeys();
    const templates = await preparedMove(deps, store, to);
    await store.directory.createStore(to.pubkey, { name: 'Mine', network: 'devnet' });
    expect(
      await moveStore(deps, store.owner.pubkey, {
        to: to.pubkey,
        ...signMove(templates, store.owner, to),
      }),
    ).toMatchObject({ ok: false, error: 'taken' });
  });

  it('refuses a key the relays already serve a payout list of, at prepare and from the facts read before the commit', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const deps = moveDeps(db, store.directory);
    const to = ownerKeys();
    expect(
      await prepareMove(
        deps,
        store.owner.pubkey,
        { to: to.pubkey, payouts: provenPayouts(store.wallet, to.pubkey) },
        { newestPaytoByTo: NOW - 10 },
      ),
    ).toMatchObject({ ok: false, error: 'key_in_use' });
    const templates = await preparedMove(deps, store, to);
    expect(
      await moveStore(
        deps,
        store.owner.pubkey,
        { to: to.pubkey, ...signMove(templates, store.owner, to) },
        { newestPaytoByTo: NOW - 10 },
      ),
    ).toMatchObject({ ok: false, error: 'key_in_use' });
  });

  it('refuses busy (a request pending), suspended, an expired draft, mismatched events and wrong authors', async () => {
    const db = await freshDb();
    const clock = testClock();
    const store = await movableStore(db, {}, clock.now);
    const deps = moveDeps(db, store.directory, clock.now);
    const to = ownerKeys();
    const templates = await preparedMove(deps, store, to);
    const signed = signMove(templates, store.owner, to);
    const commit = (input: Partial<typeof signed>) =>
      moveStore(deps, store.owner.pubkey, { to: to.pubkey, ...signed, ...input });

    expect(
      await commit({ payto: finalizeEvent({ ...templates.payto, content: 'x' }, to.secret) }),
    ).toMatchObject({ error: 'mismatch' });
    expect(
      await commit({ auth: finalizeEvent({ ...templates.auth, created_at: NOW + 1 }, to.secret) }),
    ).toMatchObject({ error: 'mismatch' });
    expect(
      await moveStore(deps, store.owner.pubkey, {
        to: to.pubkey,
        payto: signed.payto,
        auth: signed.auth,
      }),
    ).toMatchObject({ error: 'mismatch' });
    expect(
      await commit({ payto: finalizeEvent({ ...templates.payto }, store.owner.secret) }),
    ).toMatchObject({ error: 'author' });
    expect(
      await commit({ auth: finalizeEvent({ ...templates.auth }, store.owner.secret) }),
    ).toMatchObject({
      error: 'author',
    });
    if (templates.revocation === null) {
      throw new Error('a published store needs a revocation');
    }
    expect(
      await commit({ revocation: finalizeEvent({ ...templates.revocation }, to.secret) }),
    ).toMatchObject({ error: 'author' });
    expect(await commit({ payto: { ...signed.payto, sig: 'f'.repeat(128) } })).toMatchObject({
      error: 'signature',
    });
    expect(await commit({ payto: { kind: KIND_PAYTO } as unknown as NostrEvent })).toMatchObject({
      error: 'malformed',
    });

    await db.query(
      `insert into admin_requests (id, owner, kind, payload, created_at) values ('ab', $1, 'restart', '{}', $2)`,
      [store.owner.pubkey, NOW],
    );
    expect(await commit({})).toMatchObject({ error: 'busy' });
    await db.query("update admin_requests set state = 'applied' where id = 'ab'");

    clock.set(templates.expiresAt);
    expect(await commit({})).toMatchObject({ error: 'expired' });
    clock.set(NOW);

    await db.query("update stores set status = 'suspending' where owner = $1", [
      store.owner.pubkey,
    ]);
    expect(await commit({})).toMatchObject({ error: 'suspended' });
    expect(
      await prepareMove(deps, store.owner.pubkey, {
        to: to.pubkey,
        payouts: provenPayouts(store.wallet, to.pubkey),
      }),
    ).toMatchObject({ error: 'suspended' });
    await db.query("update stores set status = 'active' where owner = $1", [store.owner.pubkey]);

    expect(await commit({})).toMatchObject({ ok: true });
  });

  it('refuses a commit for another key than the draft, and without a draft', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const deps = moveDeps(db, store.directory);
    const to = ownerKeys();
    const other = ownerKeys();
    const templates = await preparedMove(deps, store, to);
    expect(
      await moveStore(deps, store.owner.pubkey, {
        to: other.pubkey,
        ...signMove(templates, store.owner, other),
      }),
    ).toMatchObject({ error: 'no_draft' });
    await db.query('delete from store_move_drafts');
    expect(
      await moveStore(deps, store.owner.pubkey, {
        to: to.pubkey,
        ...signMove(templates, store.owner, to),
      }),
    ).toMatchObject({ error: 'no_draft' });
  });

  it('refuses payouts other than the active ones, none at all, and a chain the server does not serve', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const deps = moveDeps(db, store.directory);
    const to = ownerKeys();
    const otherWallet = solanaWallet();
    expect(
      await prepareMove(deps, store.owner.pubkey, {
        to: to.pubkey,
        payouts: provenPayouts(otherWallet, to.pubkey),
      }),
    ).toMatchObject({ error: 'payouts_differ' });
    // Proven for O, not for the new key.
    expect(
      await prepareMove(deps, store.owner.pubkey, {
        to: to.pubkey,
        payouts: provenPayouts(store.wallet, store.owner.pubkey),
      }),
    ).toMatchObject({ error: 'bad_payouts' });
    const baseSepolia = 'eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e';
    const unserved = await prepareMove(deps, store.owner.pubkey, {
      to: to.pubkey,
      payouts: [
        {
          caip19: baseSepolia,
          address: '0x5696da2cecea22f127948458382ac2c59bc8e4bb',
          signature: '0x00',
        },
      ],
    });
    expect(unserved).toMatchObject({ ok: false, error: 'bad_payouts' });
    expect(
      !unserved.ok && unserved.problems?.some((problem) => problem.includes('takes no payments')),
    ).toBe(true);

    const empty = await movableStore(db, { status: 'pending', draft: 'none' });
    expect(
      await prepareMove(moveDeps(db, empty.directory), empty.owner.pubkey, {
        to: to.pubkey,
        payouts: provenPayouts(empty.wallet, to.pubkey),
      }),
    ).toMatchObject({ error: 'no_payouts' });
  });

  it('refuses payouts that changed between the prepare and the commit (payouts_differ)', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const deps = moveDeps(db, store.directory);
    const to = ownerKeys();
    const templates = await preparedMove(deps, store, to);
    const otherWallet = solanaWallet();
    await db.query(
      `update ledgers set state = jsonb_set(state::jsonb, '{payto,payouts}', to_jsonb($2::text))::text
       where owner = $1`,
      [store.owner.pubkey, JSON.stringify(provenPayouts(otherWallet, store.owner.pubkey))],
    );
    expect(
      await moveStore(deps, store.owner.pubkey, {
        to: to.pubkey,
        ...signMove(templates, store.owner, to),
      }),
    ).toMatchObject({ error: 'payouts_differ' });
  });

  it('refuses a stale revocation: an O authorization committed, or served, at or after its date', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const deps = moveDeps(db, store.directory);
    const to = ownerKeys();
    const templates = await preparedMove(deps, store, to);
    const revocationAt = templates.revocation?.created_at ?? 0;
    const signed = signMove(templates, store.owner, to);
    const commit = (relays = {}) =>
      moveStore(deps, store.owner.pubkey, { to: to.pubkey, ...signed }, relays);
    expect(await commit({ newestAuthByOwner: revocationAt })).toMatchObject({ error: 'stale' });
    const newer = finalizeEvent(
      { ...templates.auth, created_at: revocationAt, tags: [['d', store.storePubkey]] },
      store.owner.secret,
    );
    await insertOwnerEvent(db, store.owner.pubkey, newer, undefined, false);
    expect(await commit()).toMatchObject({ error: 'stale' });
    await db.query('delete from owner_events where id = $1', [newer.id]);
    expect(await commit({ newestAuthByOwner: revocationAt - 1 })).toMatchObject({ ok: true });
  });

  it('refuses a commit without a revocation once an O authorization went out (stale)', async () => {
    const db = await freshDb();
    const store = await movableStore(db, { authEvent: 'none' });
    const deps = moveDeps(db, store.directory);
    const to = ownerKeys();
    const templates = await preparedMove(deps, store, to);
    expect(templates.revocation).toBeNull();
    expect(
      await moveStore(
        deps,
        store.owner.pubkey,
        { to: to.pubkey, ...signMove(templates, store.owner, to) },
        { newestAuthByOwner: NOW - 100 },
      ),
    ).toMatchObject({ error: 'stale' });
  });

  it('refuses a move while the store still switches to its last new key (switching), prepare and commit', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const deps = moveDeps(db, store.directory);
    const next = ownerKeys();
    expect((await moved(deps, store, next)).result.ok).toBe(true);
    const third = ownerKeys();
    const chained = { owner: next, wallet: store.wallet };
    expect(
      await prepareMove(deps, next.pubkey, {
        to: third.pubkey,
        payouts: provenPayouts(store.wallet, third.pubkey),
      }),
    ).toMatchObject({ ok: false, error: 'switching' });
    await db.query('update store_moves set switched_at = moved_at');
    await db.query("update admin_requests set state = 'applied'");
    const templates = await preparedMove(deps, chained, third);
    await db.query('update store_moves set switched_at = null');
    expect(
      await moveStore(deps, next.pubkey, { to: third.pubkey, ...signMove(templates, next, third) }),
    ).toMatchObject({ ok: false, error: 'switching' });
  });
});

describe('store move: when it switches at once', () => {
  it('a pending store: its pending owner-event requests are superseded, no revocation, switched at the move', async () => {
    const db = await freshDb();
    // Pending alone decides: even with a payout list in its ledger, nothing of it was ever served.
    const store = await movableStore(db, {
      status: 'pending',
      payto: true,
      paytoEvent: 'none',
      authEvent: 'none',
    });
    const O = store.owner.pubkey;
    const ownerEvents = { db, operator: OPERATOR, now: () => NOW };
    const prepared = await prepareOwnerEvent(ownerEvents, O, KIND_PAYTO);
    if (!prepared.ok) {
      throw new Error(prepared.error);
    }
    const committed = await commitOwnerEvent(
      ownerEvents,
      O,
      finalizeEvent({ ...prepared.template }, store.owner.secret),
    );
    expect(committed).toMatchObject({ ok: true });
    const recordId = committed.ok ? committed.requestId : undefined;
    const to = ownerKeys();
    const deps = moveDeps(db, store.directory);
    const { templates, result } = await moved(deps, store, to);
    expect(templates.revocation).toBeNull();
    expect(result).toMatchObject({
      ok: true,
      pending: true,
      switching: false,
      requestId: undefined,
    });
    const row = await latestMoveRow(db, store.storePubkey);
    expect(row?.switched_at).toBe(row?.moved_at);
    expect(row?.revocation).toBeNull();
    const [request] = await db.query<{ state: string; result: string }>(
      'select state, result from admin_requests where id = $1',
      [recordId],
    );
    expect(request).toEqual({ state: 'failed', result: JSON.stringify({ problem: 'superseded' }) });
    expect(await pendingRequests(db, to.pubkey)).toEqual([]);
  });

  it('an active store with no O authorization: no revocation, and still held back for the switch', async () => {
    const db = await freshDb();
    const store = await movableStore(db, { authEvent: 'none' });
    const { templates, result } = await moved(moveDeps(db, store.directory), store, ownerKeys());
    expect(templates.revocation).toBeNull();
    expect(result).toMatchObject({ ok: true, switching: true });
    const row = await latestMoveRow(db, store.storePubkey);
    expect(row?.switched_at).toBeNull();
    expect(row?.revocation).toBeNull();
  });

  it('no active payout list but a recorded O event: not switched at the move', async () => {
    const db = await freshDb();
    const store = await movableStore(db, {
      payto: false,
      paytoEvent: 'recorded',
      authEvent: 'none',
    });
    const { result } = await moved(moveDeps(db, store.directory), store, ownerKeys());
    expect(result).toMatchObject({ ok: true, switching: true });
    expect((await latestMoveRow(db, store.storePubkey))?.switched_at).toBeNull();
  });

  it('a store never published (no payout list, nothing recorded): switched at the move', async () => {
    const db = await freshDb();
    const store = await movableStore(db, {
      payto: false,
      paytoEvent: 'unrecorded',
      authEvent: 'none',
    });
    await db.query("update admin_requests set state = 'applied'");
    const { result } = await moved(moveDeps(db, store.directory), store, ownerKeys());
    expect(result).toMatchObject({ ok: true, switching: false });
    const row = await latestMoveRow(db, store.storePubkey);
    expect(row?.switched_at).toBe(NOW);
  });
});

describe('store move: owner events during the switch', () => {
  it('refuses a new payout list (prepare and commit) while switching; an authorization is still prepared', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const to = ownerKeys();
    expect((await moved(moveDeps(db, store.directory), store, to)).result.ok).toBe(true);
    await db.query("update admin_requests set state = 'applied'");
    const ownerEvents = { db, operator: OPERATOR, now: () => NOW };
    expect(await prepareOwnerEvent(ownerEvents, to.pubkey, KIND_PAYTO)).toMatchObject({
      ok: false,
      error: 'switching',
    });
    expect(await prepareOwnerEvent(ownerEvents, to.pubkey, KIND_STORE_AUTH)).toMatchObject({
      ok: true,
    });
    // A list prepared some other way still cannot be committed during the switch.
    const [committed] = await db.query<{ event: NostrEvent; payouts_string: string }>(
      'select event, payouts_string from owner_events where owner = $1 and kind = $2',
      [to.pubkey, KIND_PAYTO],
    );
    const template = {
      kind: KIND_PAYTO,
      created_at: NOW + 10,
      tags: committed?.event.tags ?? [],
      content: '',
    };
    await db.query(
      `insert into owner_event_drafts (owner, kind, template, payouts_string, expires_at)
       values ($1, $2, $3::jsonb, $4, $5)`,
      [to.pubkey, KIND_PAYTO, JSON.stringify(template), committed?.payouts_string, NOW + 600],
    );
    expect(
      await commitOwnerEvent(ownerEvents, to.pubkey, finalizeEvent({ ...template }, to.secret)),
    ).toMatchObject({ ok: false, error: 'switching' });
    await db.query('update store_moves set switched_at = $1', [NOW]);
    expect(
      await commitOwnerEvent(ownerEvents, to.pubkey, finalizeEvent({ ...template }, to.secret)),
    ).toMatchObject({ ok: true });
  });
});

describe('store move: creation, import and concurrency', () => {
  it('a moved key never opens a store again; its new key opens the moved store', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const to = ownerKeys();
    expect((await moved(moveDeps(db, store.directory), store, to)).result.ok).toBe(true);
    await expect(
      store.directory.createStore(store.owner.pubkey, { name: 'Again', network: 'devnet' }),
    ).rejects.toBeInstanceOf(StoreMovedError);
    const opened = await store.directory.createStore(to.pubkey, { name: 'X', network: 'devnet' });
    expect(opened).toMatchObject({ created: false, store: { storePubkey: store.storePubkey } });
  });

  it('a creation for the new key racing the move: one store per key, whichever commits first', async () => {
    for (const createFirst of [true, false]) {
      const db = await freshDb();
      const store = await movableStore(db);
      const deps = moveDeps(db, store.directory);
      const to = ownerKeys();
      const templates = await preparedMove(deps, store, to);
      const move = () =>
        moveStore(deps, store.owner.pubkey, {
          to: to.pubkey,
          ...signMove(templates, store.owner, to),
        });
      const create = () =>
        store.directory.createStore(to.pubkey, { name: 'Mine', network: 'devnet' });
      const [moveResult, created] = createFirst
        ? await Promise.all([create(), move()]).then(([made, result]) => [result, made] as const)
        : await Promise.all([move(), create()]);
      const stores = await db.query<{ store_pubkey: string }>(
        'select store_pubkey from stores where owner = $1',
        [to.pubkey],
      );
      expect(stores).toHaveLength(1);
      if (moveResult.ok) {
        expect(created.store.storePubkey).toBe(store.storePubkey);
      } else {
        expect(moveResult.error).toBe('taken');
        expect(created.created).toBe(true);
      }
    }
  });

  it('locks both keys in one order, then the store, ledger, requests and owner events', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    let to = ownerKeys();
    // A new key that sorts before O: an unsorted order would lock O first.
    while (to.pubkey > store.owner.pubkey) {
      to = ownerKeys();
    }
    const deps = moveDeps(db, store.directory);
    const templates = await preparedMove(deps, store, to);
    const locks: string[] = [];
    const watched = recording(db, (sql, params) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        locks.push(`key:${String(params[0])}`);
      }
      const locked = /from (stores|ledgers|admin_requests|owner_events)\b[^]*for update/.exec(sql);
      if (locked?.[1] !== undefined) {
        locks.push(locked[1]);
      }
    });
    const result = await moveStore({ ...deps, db: watched }, store.owner.pubkey, {
      to: to.pubkey,
      ...signMove(templates, store.owner, to),
    });
    expect(result.ok).toBe(true);
    expect(locks).toEqual([
      `key:${to.pubkey}`,
      `key:${store.owner.pubkey}`,
      'stores',
      'ledgers',
      'admin_requests',
      'owner_events',
    ]);
  });

  it('two opposite moves both end (no deadlock): each new key has a store', async () => {
    const db = await freshDb();
    const first = await movableStore(db);
    const second = await movableStore(db);
    const firstDeps = moveDeps(db, first.directory);
    const secondDeps = moveDeps(db, second.directory);
    const [left, right] = await Promise.all([
      prepareMove(firstDeps, first.owner.pubkey, {
        to: second.owner.pubkey,
        payouts: provenPayouts(first.wallet, second.owner.pubkey),
      }),
      prepareMove(secondDeps, second.owner.pubkey, {
        to: first.owner.pubkey,
        payouts: provenPayouts(second.wallet, first.owner.pubkey),
      }),
    ]);
    expect([left, right]).toMatchObject([
      { ok: false, error: 'taken' },
      { ok: false, error: 'taken' },
    ]);
    const firstTo = ownerKeys();
    const secondTo = ownerKeys();
    const [firstMoved, secondMoved] = await Promise.all([
      moved(firstDeps, first, firstTo),
      moved(secondDeps, second, secondTo),
    ]);
    expect([firstMoved.result.ok, secondMoved.result.ok]).toEqual([true, true]);
  });

  it('a move racing a holder save: a deadlock rolls the first try back and the move is retried once', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const to = ownerKeys();
    const deps = moveDeps(db, store.directory);
    const templates = await preparedMove(deps, store, to);
    let tries = 0;
    let deadlocks = 0;
    const racing = recording(db, (sql) => {
      if (/from ledgers where owner = \$1 for update/.test(sql)) {
        tries += 1;
        if (deadlocks === 0) {
          deadlocks += 1;
          throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
        }
      }
    });
    const result = await moveStore({ ...deps, db: racing }, store.owner.pubkey, {
      to: to.pubkey,
      ...signMove(templates, store.owner, to),
    });
    expect(result).toMatchObject({ ok: true });
    expect(tries).toBe(2);
    expect(await db.query('select count(*)::int as count from store_moves')).toEqual([
      { count: 1 },
    ]);

    // A second deadlock in a row is not retried again.
    const other = await movableStore(db);
    const otherTo = ownerKeys();
    const otherDeps = moveDeps(db, other.directory);
    const otherTemplates = await preparedMove(otherDeps, other, otherTo);
    const always = recording(db, (sql) => {
      if (/from ledgers where owner = \$1 for update/.test(sql)) {
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      }
    });
    await expect(
      moveStore({ ...otherDeps, db: always }, other.owner.pubkey, {
        to: otherTo.pubkey,
        ...signMove(otherTemplates, other.owner, otherTo),
      }),
    ).rejects.toThrow('deadlock');
  });
});

describe('store move: chained moves', () => {
  it("moves O -> O' -> O'' once the first switched: one moved alert row per move", async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const deps = moveDeps(db, store.directory);
    const next = ownerKeys();
    const last = ownerKeys();
    expect((await moved(deps, store, next)).result.ok).toBe(true);
    await db.query('update store_moves set switched_at = $1', [NOW]);
    // The move's setup request was applied by the holder meanwhile.
    await db.query("update admin_requests set state = 'applied'");
    const { result } = await moved(deps, { owner: next, wallet: store.wallet }, last);
    expect(result).toMatchObject({ ok: true, owner: last.pubkey, switching: true });
    expect(
      await db.query<{ from_owner: string; to_owner: string }>(
        'select from_owner, to_owner from store_moves order by id',
      ),
    ).toEqual([
      { from_owner: store.owner.pubkey, to_owner: next.pubkey },
      { from_owner: next.pubkey, to_owner: last.pubkey },
    ]);
    expect(
      await db.query(
        "select owner from alerts where kind = 'moved' and cleared_at is null order by id",
      ),
    ).toEqual([{ owner: store.owner.pubkey }, { owner: next.pubkey }]);
    expect(await store.directory.openAlertKinds(last.pubkey)).toEqual([]);
  });

  it('clears the drift alerts of the store at the move; other alerts follow the store', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    for (const kind of ['drift', 'rail_unavailable']) {
      await db.query(
        `insert into alerts (owner, kind, message, created_at, last_seen_at) values ($1, $2, 'm', $3, $3)`,
        [store.owner.pubkey, kind, NOW - 10],
      );
    }
    const to = ownerKeys();
    expect((await moved(moveDeps(db, store.directory), store, to)).result.ok).toBe(true);
    expect(await store.directory.openAlertKinds(to.pubkey)).toEqual(['rail_unavailable']);
    expect(await store.directory.openAlertKinds(store.owner.pubkey)).toEqual(['moved']);
  });
});

describe('store move: the draft', () => {
  it('a payout proof for the new key is what the new payout list carries (D4)', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const to = ownerKeys();
    const templates = await preparedMove(moveDeps(db, store.directory), store, to);
    const accept = templates.payto.tags.filter((tag) => tag[0] !== 'd');
    expect(JSON.stringify(accept)).toContain(store.wallet.address);
    expect(JSON.stringify(accept)).toContain(store.wallet.prove(to.pubkey, USDC_DEVNET));
  });
});

describe('store move: review round 1', () => {
  it('refuses a new payout list dated at or before the active one (stale): the setup pass would never take it', async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    const deps = moveDeps(db, store.directory);
    const to = ownerKeys();
    const templates = await preparedMove(deps, store, to);
    // A setup pass recorded the same payouts again, dated as the prepared list.
    await db.query(
      `update ledgers set state = jsonb_set(state::jsonb, '{payto,createdAt}', to_jsonb($2::bigint))::text
       where owner = $1`,
      [store.owner.pubkey, templates.payto.created_at],
    );
    const commit = () =>
      moveStore(deps, store.owner.pubkey, {
        to: to.pubkey,
        ...signMove(templates, store.owner, to),
      });
    expect(await commit()).toMatchObject({ ok: false, error: 'stale' });
    await db.query(
      `update ledgers set state = jsonb_set(state::jsonb, '{payto,createdAt}', to_jsonb($2::bigint))::text
       where owner = $1`,
      [store.owner.pubkey, templates.payto.created_at - 1],
    );
    expect(await commit()).toMatchObject({ ok: true });
  });

  it('compares payout sets by size too: a strict subset or superset differs', () => {
    const one = { caip19: USDC_DEVNET, address: 'a' };
    const two = { caip19: USDC_DEVNET, address: 'b' };
    expect(samePayoutSet([one], [one, two])).toBe(false);
    expect(samePayoutSet([one, two], [one])).toBe(false);
    expect(samePayoutSet([two, one], [one, two])).toBe(true);
  });

  it('revokes an O authorization only the relays serve (never committed here)', async () => {
    const db = await freshDb();
    const store = await movableStore(db, { authEvent: 'none' });
    const prepared = await preparedMove(moveDeps(db, store.directory), store, ownerKeys(), {
      newestAuthByOwner: NOW - 50,
    });
    expect(prepared.revocation).toMatchObject({ created_at: NOW });
  });

  it('refuses a signed revocation the draft does not hold (mismatch)', async () => {
    const db = await freshDb();
    const store = await movableStore(db, { authEvent: 'none' });
    const deps = moveDeps(db, store.directory);
    const to = ownerKeys();
    const templates = await preparedMove(deps, store, to);
    expect(templates.revocation).toBeNull();
    const revocation = finalizeEvent(
      buildStoreRevocationEvent(store.storePubkey, NOW + 1),
      store.owner.secret,
    );
    expect(
      await moveStore(deps, store.owner.pubkey, {
        to: to.pubkey,
        ...signMove(templates, store.owner, to),
        revocation,
      }),
    ).toMatchObject({ ok: false, error: 'mismatch' });
  });

  it("refuses new payouts the node's rules or the products' prices refuse (bad_payouts)", async () => {
    const db = await freshDb();
    const store = await movableStore(db);
    // A price no USDC amount can pay (below its smallest unit).
    await db.query("update products set price_usd = '0.0000001' where owner = $1", [
      store.owner.pubkey,
    ]);
    const to = ownerKeys();
    const refused = await prepareMove(moveDeps(db, store.directory), store.owner.pubkey, {
      to: to.pubkey,
      payouts: provenPayouts(store.wallet, to.pubkey),
    });
    expect(refused).toMatchObject({ ok: false, error: 'bad_payouts' });
    expect(!refused.ok && (refused.problems ?? []).length).toBeGreaterThan(0);
  });

  it('createStore takes the owner key lock before it looks for a move of that key', async () => {
    const db = await freshDb();
    const owner = ownerKeys().pubkey;
    const statements: { sql: string; params: unknown[] }[] = [];
    const watched: Db = {
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            ...tx,
            query: (sql, params) => {
              statements.push({ sql, params: params ?? [] });
              return tx.query(sql, params);
            },
          }),
        ),
    };
    await directoryFor(watched).createStore(owner, { name: 'Shop', network: 'devnet' });
    const lockAt = statements.findIndex(
      (statement) =>
        statement.sql.includes('pg_advisory_xact_lock') && statement.params[0] === owner,
    );
    const lookAt = statements.findIndex((statement) => statement.sql.includes('store_moves'));
    const insertAt = statements.findIndex((statement) =>
      statement.sql.includes('insert into stores'),
    );
    expect(lockAt).toBe(0);
    expect(lookAt).toBeGreaterThan(lockAt);
    expect(insertAt).toBeGreaterThan(lookAt);
  });
});

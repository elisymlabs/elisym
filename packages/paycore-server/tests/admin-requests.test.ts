import { emptyLedger } from '@merchant-node/ledger';
import { describe, expect, it } from 'vitest';
import {
  getRequest,
  markRequest,
  newRequestId,
  pendingRequests,
  setRequestResult,
  waitResult,
} from '../src/admin/requests';
import { REQUESTS_CHANNEL } from '../src/db/db';
import { acquireLeases } from '../src/state/leases';
import { PgLedgerStore } from '../src/state/ledger-store';
import { submitRequest } from './helpers/node-requests';
import { freshDb } from './pglite-db';
import { NOW, activate, directoryFor, ownerKeys } from './stores-fixtures';

async function servedStore() {
  const db = await freshDb();
  const owner = ownerKeys().pubkey;
  await directoryFor(db).createStore(owner, { name: 'Shop', network: 'devnet' });
  await activate(db, owner);
  return { db, owner };
}

describe('admin requests', () => {
  it('ids sort in creation order', () => {
    const ids = Array.from({ length: 50 }, () => newRequestId(1_000));
    expect([...ids].sort()).toEqual(ids);
    expect(newRequestId(2_000) > newRequestId(1_000)).toBe(true);
  });

  it('notifies the owner on the requests channel when the row commits', async () => {
    const { db, owner } = await servedStore();
    let notified = 0;
    const stop = await db.listen(REQUESTS_CHANNEL, () => {
      notified += 1;
    });
    const id = await submitRequest(db, owner, 'restart', {}, NOW);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stop();
    expect(notified).toBe(1);
    expect(await getRequest(db, owner, id)).toMatchObject({
      kind: 'restart',
      state: 'pending',
      payload: {},
    });
    // Another owner never sees it.
    expect(await getRequest(db, ownerKeys().pubkey, id)).toBeUndefined();
  });

  it('keeps a NUL escape in the payload (JSON text, not jsonb)', async () => {
    const { db, owner } = await servedStore();
    const id = await submitRequest(db, owner, 'hand_answer', { key: 'b:\u0000\ud800' }, NOW);
    expect((await getRequest(db, owner, id))?.payload).toEqual({ key: 'b:\u0000\ud800' });
  });

  it('waitResult answers once applied, or undefined at the deadline', async () => {
    const { db, owner } = await servedStore();
    const id = await submitRequest(db, owner, 'suspend', {}, NOW);
    expect(await waitResult(db, owner, id, 30, { pollMs: 10 })).toBeUndefined();
    setTimeout(() => {
      void markRequest(db, owner, id, 'applied', NOW, { done: true });
    }, 30);
    expect(await waitResult(db, owner, id, 2_000, { pollMs: 10 })).toMatchObject({
      state: 'applied',
      result: { done: true },
      appliedAt: NOW,
    });
  });

  it('lists pending requests oldest first, per owner', async () => {
    const { db, owner } = await servedStore();
    const ids: string[] = [];
    for (const kind of ['setup', 'record_owner_event', 'restart'] as const) {
      ids.push(await submitRequest(db, owner, kind, { kind }, NOW));
    }
    const other = ownerKeys().pubkey;
    await directoryFor(db).createStore(other, { name: 'Other', network: 'devnet' });
    await submitRequest(db, other, 'setup', {}, NOW);
    expect((await pendingRequests(db, owner)).map((request) => request.id)).toEqual(ids);
    await markRequest(db, owner, ids[0] ?? '', 'applied', NOW);
    expect((await pendingRequests(db, owner)).map((request) => request.id)).toEqual(ids.slice(1));
    expect(await pendingRequests(db, other)).toHaveLength(1);
  });

  it("marks only a pending request, and only its owner's", async () => {
    const { db, owner } = await servedStore();
    const id = await submitRequest(db, owner, 'restart', {}, NOW);
    expect(await markRequest(db, ownerKeys().pubkey, id, 'failed', NOW + 1)).toBe(false);
    expect(await markRequest(db, owner, id, 'applied', NOW, { first: true })).toBe(true);
    // Applied once: a second mark (applied or failed) changes nothing.
    expect(await markRequest(db, owner, id, 'failed', NOW + 5, { second: true })).toBe(false);
    expect(await getRequest(db, owner, id)).toMatchObject({
      state: 'applied',
      appliedAt: NOW,
      result: { first: true },
    });
  });

  it("writes a result only on its owner's applied request", async () => {
    const { db, owner } = await servedStore();
    const id = await submitRequest(db, owner, 'hand_answer', {}, NOW);
    expect(await setRequestResult(db, owner, id, { sent: 1 })).toBe(false);
    expect(await getRequest(db, owner, id)).toMatchObject({ state: 'pending', result: undefined });
    await markRequest(db, owner, id, 'applied', NOW);
    expect(await setRequestResult(db, ownerKeys().pubkey, id, { sent: 2 })).toBe(false);
    expect(await setRequestResult(db, owner, id, { sent: 3 })).toBe(true);
    expect((await getRequest(db, owner, id))?.result).toEqual({ sent: 3 });
    const failed = await submitRequest(db, owner, 'setup', {}, NOW);
    await markRequest(db, owner, failed, 'failed', NOW, { problem: 'x' });
    expect(await setRequestResult(db, owner, failed, { sent: 4 })).toBe(false);
    expect((await getRequest(db, owner, failed))?.result).toEqual({ problem: 'x' });
  });

  it('a request marked in the fenced save is applied once, also across a crash before the mark', async () => {
    const { db, owner } = await servedStore();
    const holder = 'holder-1';
    const [lease] = await acquireLeases(db, holder, NOW);
    const id = await submitRequest(db, owner, 'setup', {}, NOW);
    const ledgers = new PgLedgerStore(db, () => NOW);
    let effects = 0;
    let crash = true;
    const apply = async (request: { id: string }) => {
      const handle = await ledgers.open(owner, lease?.epoch ?? 0, holder);
      const next = { ...emptyLedger(), resumeAt: (handle.state.resumeAt ?? 0) + 1 };
      effects += 1;
      if (crash) {
        throw new Error('crash before the save');
      }
      await handle.save(next, { appliedRequest: request.id });
    };
    const drain = async () => {
      const pending = await pendingRequests(db, owner);
      for (const request of pending) {
        await apply(request);
      }
      return pending.map((request) => request.id);
    };
    await expect(drain()).rejects.toThrow('crash');
    expect((await getRequest(db, owner, id))?.state).toBe('pending');
    crash = false;
    expect(await drain()).toEqual([id]);
    expect(await drain()).toEqual([]);
    expect(effects).toBe(2);
    expect((await getRequest(db, owner, id))?.state).toBe('applied');
    expect((await ledgers.open(owner, lease?.epoch ?? 0, holder)).state.resumeAt).toBe(1);
  });
});

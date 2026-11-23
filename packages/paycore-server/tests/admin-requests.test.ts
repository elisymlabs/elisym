import { emptyLedger } from '@merchant-node/ledger';
import { describe, expect, it } from 'vitest';
import {
  type AdminRequest,
  drainRequests,
  getRequest,
  markRequest,
  newRequestId,
  pendingRequests,
  submitRequest,
  waitResult,
} from '../src/admin/requests';
import { REQUESTS_CHANNEL } from '../src/db/db';
import { acquireLeases } from '../src/state/leases';
import { PgLedgerStore } from '../src/state/ledger-store';
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

  it('drains pending requests in order, one at a time, and never applies one twice', async () => {
    const { db, owner } = await servedStore();
    const ids: string[] = [];
    for (const kind of ['setup', 'record_owner_event', 'restart'] as const) {
      ids.push(await submitRequest(db, owner, kind, { kind }, NOW));
    }
    const other = ownerKeys().pubkey;
    await directoryFor(db).createStore(other, { name: 'Other', network: 'devnet' });
    await submitRequest(db, other, 'setup', {}, NOW);
    const seen: string[] = [];
    let running = 0;
    const apply = async (request: AdminRequest) => {
      running += 1;
      expect(running).toBe(1);
      seen.push(request.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await markRequest(db, owner, request.id, 'applied', NOW);
      running -= 1;
    };
    const [first, second] = await Promise.all([
      drainRequests(db, owner, apply),
      drainRequests(db, owner, apply),
    ]);
    expect(first).toEqual(ids);
    expect(second).toEqual([]);
    expect(seen).toEqual(ids);
    expect(await drainRequests(db, owner, apply)).toEqual([]);
    expect(await pendingRequests(db, owner)).toEqual([]);
    expect(await pendingRequests(db, other)).toHaveLength(1);
  });

  it('stops at a throw so later requests never overtake, and resumes there', async () => {
    const { db, owner } = await servedStore();
    const first = await submitRequest(db, owner, 'setup', {}, NOW);
    const second = await submitRequest(db, owner, 'restart', {}, NOW);
    let fail = true;
    const seen: string[] = [];
    const apply = async (request: AdminRequest) => {
      seen.push(request.id);
      if (fail) {
        throw new Error('relay down');
      }
      await markRequest(db, owner, request.id, 'applied', NOW);
    };
    await expect(drainRequests(db, owner, apply)).rejects.toThrow('relay down');
    expect(seen).toEqual([first]);
    fail = false;
    expect(await drainRequests(db, owner, apply)).toEqual([first, second]);
  });

  it('a request marked in the fenced save is applied once, also across a crash before the mark', async () => {
    const { db, owner } = await servedStore();
    const holder = 'holder-1';
    const [lease] = await acquireLeases(db, holder, NOW);
    const id = await submitRequest(db, owner, 'setup', {}, NOW);
    const ledgers = new PgLedgerStore(db, () => NOW);
    let effects = 0;
    let crash = true;
    const apply = async (request: AdminRequest) => {
      const handle = await ledgers.open(owner, lease?.epoch ?? 0, holder);
      const next = { ...emptyLedger(), resumeAt: (handle.state.resumeAt ?? 0) + 1 };
      effects += 1;
      if (crash) {
        throw new Error('crash before the save');
      }
      await handle.save(next, { appliedRequest: request.id });
    };
    await expect(drainRequests(db, owner, apply)).rejects.toThrow('crash');
    expect((await getRequest(db, owner, id))?.state).toBe('pending');
    crash = false;
    expect(await drainRequests(db, owner, apply)).toEqual([id]);
    expect(await drainRequests(db, owner, apply)).toEqual([]);
    expect(effects).toBe(2);
    expect((await getRequest(db, owner, id))?.state).toBe('applied');
    expect((await ledgers.open(owner, lease?.epoch ?? 0, holder)).state.resumeAt).toBe(1);
  });
});

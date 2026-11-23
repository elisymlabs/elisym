import { KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import { emptyLedger } from '@merchant-node/ledger';
import type { EventTemplate } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { markRequest, pendingRequests } from '../src/admin/requests';
import type { Db } from '../src/db/db';
import {
  DRAFT_TTL_SECS,
  type OwnerEventKind,
  commitOwnerEvent,
  prepareOwnerEvent,
} from '../src/owner-events';
import { serializeLedger } from '../src/state/ledger-store';
import { canonicalPayouts } from '../src/state/stores';
import { freshDb } from './pglite-db';
import { NOW, OPERATOR, RELAY, directoryFor, ownerKeys, signedPayouts } from './stores-fixtures';

async function storeWithDraft(db: Db) {
  const owner = ownerKeys();
  const directory = directoryFor(db);
  await directory.createStore(owner.pubkey, { name: 'Shop', network: 'devnet' });
  const put = await directory.putConfig(owner.pubkey, {
    name: 'Shop',
    payouts: signedPayouts(owner.pubkey),
    inboxRelays: [RELAY],
  });
  expect(put.ok).toBe(true);
  return { owner, directory };
}

function deps(db: Db, now = NOW) {
  return { db, operator: OPERATOR, now: () => now };
}

async function prepared(db: Db, owner: string, kind: OwnerEventKind, newestOnRelays?: number) {
  const result = await prepareOwnerEvent(
    deps(db),
    owner,
    kind,
    newestOnRelays === undefined ? {} : { newestOnRelays },
  );
  if (!result.ok) {
    throw new Error(`prepare refused: ${result.error}`);
  }
  return result;
}

/** O's event of `kind` committed directly (another tab), dated `createdAt`. */
async function insertCommitted(
  db: Db,
  owner: { secret: Uint8Array; pubkey: string },
  kind: OwnerEventKind,
  createdAt: number,
  tags: string[][] = [['t', 'other']],
) {
  const event = finalizeEvent({ kind, created_at: createdAt, tags, content: '' }, owner.secret);
  await db.query(
    `insert into owner_events (id, owner, kind, event, payouts_string, committed_at)
     values ($1, $2, $3, $4::jsonb, $5, $6)`,
    [event.id, owner.pubkey, kind, JSON.stringify(event), kind === KIND_PAYTO ? '[]' : null, NOW],
  );
  return event;
}

async function setPayto(db: Db, owner: string, payto: { createdAt: number; payouts: string }) {
  const state = emptyLedger();
  state.payto = payto;
  await db.query('update ledgers set state = $2 where owner = $1', [owner, serializeLedger(state)]);
}

describe('prepare', () => {
  it('builds the 10133 from the draft and keeps the exact draft string', async () => {
    const db = await freshDb();
    const { owner, directory } = await storeWithDraft(db);
    const result = await prepared(db, owner.pubkey, KIND_PAYTO);
    const draftText = canonicalPayouts(
      (await directory.settings(owner.pubkey))?.draftPayouts,
    )?.text;
    expect(result.payoutsString).toBe(draftText);
    expect(result.template).toMatchObject({ kind: KIND_PAYTO, created_at: NOW, content: '' });
    const [row] = await db.query<{ payouts_string: string; expires_at: number }>(
      'select payouts_string, expires_at from owner_event_drafts where owner = $1 and kind = $2',
      [owner.pubkey, KIND_PAYTO],
    );
    expect(row).toEqual({ payouts_string: draftText, expires_at: NOW + DRAFT_TTL_SECS });
  });

  it('keeps the recorded date of an unchanged list the relays still serve', async () => {
    const db = await freshDb();
    const { owner, directory } = await storeWithDraft(db);
    const text =
      canonicalPayouts((await directory.settings(owner.pubkey))?.draftPayouts)?.text ?? '';
    await setPayto(db, owner.pubkey, { createdAt: NOW - 500, payouts: text });
    expect((await prepared(db, owner.pubkey, KIND_PAYTO, NOW - 500)).template.created_at).toBe(
      NOW - 500,
    );
    // Not knowing what the relays serve, or a newer list there: a new date after both.
    expect((await prepared(db, owner.pubkey, KIND_PAYTO)).template.created_at).toBe(NOW);
    expect((await prepared(db, owner.pubkey, KIND_PAYTO, NOW + 3)).template.created_at).toBe(
      NOW + 4,
    );
  });

  it('dates a changed list after the recorded one, and refuses a date the clock is far behind', async () => {
    const db = await freshDb();
    const { owner } = await storeWithDraft(db);
    await setPayto(db, owner.pubkey, { createdAt: NOW, payouts: '[]' });
    expect((await prepared(db, owner.pubkey, KIND_PAYTO)).template.created_at).toBe(NOW + 1);
    await setPayto(db, owner.pubkey, { createdAt: NOW + 3600, payouts: '[]' });
    expect(await prepareOwnerEvent(deps(db), owner.pubkey, KIND_PAYTO)).toMatchObject({
      ok: false,
      error: 'clock',
    });
  });

  it('dates an unchanged list after a list committed since, never at its recorded date', async () => {
    const db = await freshDb();
    const { owner, directory } = await storeWithDraft(db);
    const text =
      canonicalPayouts((await directory.settings(owner.pubkey))?.draftPayouts)?.text ?? '';
    await setPayto(db, owner.pubkey, { createdAt: NOW - 500, payouts: text });
    // Another list was committed after the recorded one, and the merchant went back.
    await insertCommitted(db, owner, KIND_PAYTO, NOW - 100);
    expect((await prepared(db, owner.pubkey, KIND_PAYTO, NOW - 500)).template.created_at).toBe(
      NOW - 99,
    );
  });

  it('dates a 30490 after the last committed one, even one dated ahead of the clock', async () => {
    const db = await freshDb();
    const { owner } = await storeWithDraft(db);
    await insertCommitted(db, owner, KIND_STORE_AUTH, NOW + 5);
    expect((await prepared(db, owner.pubkey, KIND_STORE_AUTH)).template.created_at).toBe(NOW + 6);
    expect((await prepared(db, owner.pubkey, KIND_STORE_AUTH, NOW + 20)).template.created_at).toBe(
      NOW + 21,
    );
  });

  it('refuses a 10133 without draft payouts', async () => {
    const db = await freshDb();
    const owner = ownerKeys().pubkey;
    await directoryFor(db).createStore(owner, { name: 'Shop', network: 'devnet' });
    expect(await prepareOwnerEvent(deps(db), owner, KIND_PAYTO)).toMatchObject({
      ok: false,
      error: 'no_payouts',
    });
    expect(await prepareOwnerEvent(deps(db), ownerKeys().pubkey, KIND_PAYTO)).toMatchObject({
      error: 'no_store',
    });
  });

  it('builds a hosted 30490 naming the operator, with no expiry (R2)', async () => {
    const db = await freshDb();
    const { owner, directory } = await storeWithDraft(db);
    const storePubkey = (await directory.store(owner.pubkey))?.storePubkey ?? '';
    const { template } = await prepared(db, owner.pubkey, KIND_STORE_AUTH);
    expect(template).toEqual({
      kind: KIND_STORE_AUTH,
      created_at: NOW,
      tags: [
        ['d', storePubkey],
        ['p', storePubkey],
        ['mode', 'hosted', OPERATOR],
      ],
      content: '',
    });
  });
});

describe('commit', () => {
  it('stores the signed 10133 with the draft string byte-equal and queues its recording', async () => {
    const db = await freshDb();
    const { owner } = await storeWithDraft(db);
    const draft = await prepared(db, owner.pubkey, KIND_PAYTO);
    const event = finalizeEvent(draft.template, owner.secret);
    const result = await commitOwnerEvent(deps(db, NOW + 10), owner.pubkey, event);
    expect(result).toMatchObject({ ok: true, id: event.id, alreadyCommitted: false });
    const [row] = await db.query<{ payouts_string: string; recorded: boolean; event: unknown }>(
      'select payouts_string, recorded, event from owner_events where id = $1',
      [event.id],
    );
    expect(row?.payouts_string).toBe(draft.payoutsString);
    expect(row?.recorded).toBe(false);
    expect(row?.event).toEqual(JSON.parse(JSON.stringify(event)));
    expect(
      await db.query('select 1 from owner_event_drafts where owner = $1', [owner.pubkey]),
    ).toEqual([]);
    const requests = await pendingRequests(db, owner.pubkey);
    expect(requests.map((request) => [request.kind, request.payload])).toEqual([
      ['record_owner_event', { eventId: event.id }],
    ]);
    // The same event again changes nothing.
    expect(await commitOwnerEvent(deps(db, NOW + 11), owner.pubkey, event)).toMatchObject({
      ok: true,
      alreadyCommitted: true,
      requestId: undefined,
    });
    expect(await pendingRequests(db, owner.pubkey)).toHaveLength(1);
  });

  it('commits a 30490 without a payouts string', async () => {
    const db = await freshDb();
    const { owner } = await storeWithDraft(db);
    const draft = await prepared(db, owner.pubkey, KIND_STORE_AUTH);
    const event = finalizeEvent(draft.template, owner.secret);
    expect((await commitOwnerEvent(deps(db), owner.pubkey, event)).ok).toBe(true);
    const [row] = await db.query<{ payouts_string: string | null }>(
      'select payouts_string from owner_events where id = $1',
      [event.id],
    );
    expect(row?.payouts_string).toBeNull();
  });

  it('refuses the wrong author, a broken signature and a malformed event', async () => {
    const db = await freshDb();
    const { owner } = await storeWithDraft(db);
    const draft = await prepared(db, owner.pubkey, KIND_PAYTO);
    const other = finalizeEvent(draft.template, ownerKeys().secret);
    expect(await commitOwnerEvent(deps(db), owner.pubkey, other)).toEqual({
      ok: false,
      error: 'author',
    });
    const event = finalizeEvent(draft.template, owner.secret);
    const forged = {
      ...event,
      sig: `${event.sig.slice(0, -1)}${event.sig.endsWith('0') ? '1' : '0'}`,
    };
    expect(await commitOwnerEvent(deps(db), owner.pubkey, forged)).toMatchObject({
      error: 'signature',
    });
    expect(await commitOwnerEvent(deps(db), owner.pubkey, { ...event, kind: 1 })).toMatchObject({
      error: 'malformed',
    });
    expect(await db.query('select 1 from owner_events')).toEqual([]);
  });

  it('refuses any changed byte: date, tags or content', async () => {
    const db = await freshDb();
    const { owner } = await storeWithDraft(db);
    const draft = await prepared(db, owner.pubkey, KIND_PAYTO);
    const variants: EventTemplate[] = [
      { ...draft.template, created_at: draft.template.created_at + 1 },
      { ...draft.template, content: ' ' },
      { ...draft.template, tags: [...draft.template.tags, ['t', 'x']] },
      {
        ...draft.template,
        tags: draft.template.tags.map((tag) => tag.map((value) => value.replace('a', 'b'))),
      },
    ];
    for (const variant of variants) {
      expect(
        await commitOwnerEvent(deps(db), owner.pubkey, finalizeEvent(variant, owner.secret)),
      ).toEqual({ ok: false, error: 'mismatch' });
    }
  });

  it('refuses an expired draft, and with no draft at all', async () => {
    const db = await freshDb();
    const { owner } = await storeWithDraft(db);
    const draft = await prepared(db, owner.pubkey, KIND_PAYTO);
    const event = finalizeEvent(draft.template, owner.secret);
    expect(await commitOwnerEvent(deps(db, NOW + DRAFT_TTL_SECS), owner.pubkey, event)).toEqual({
      ok: false,
      error: 'expired',
    });
    const auth = finalizeEvent(
      { kind: KIND_STORE_AUTH, created_at: NOW, tags: [], content: '' },
      owner.secret,
    );
    expect(await commitOwnerEvent(deps(db), owner.pubkey, auth)).toEqual({
      ok: false,
      error: 'no_draft',
    });
  });

  it('refuses a stale date: a newer list on the relays, or committed since', async () => {
    const db = await freshDb();
    const { owner } = await storeWithDraft(db);
    const draft = await prepared(db, owner.pubkey, KIND_PAYTO);
    const event = finalizeEvent(draft.template, owner.secret);
    expect(
      await commitOwnerEvent(deps(db), owner.pubkey, event, { newestOnRelays: NOW + 1 }),
    ).toEqual({ ok: false, error: 'stale' });
    // Dated as the relays' newest, without keeping the recorded date: a tie relays may lose.
    expect(await commitOwnerEvent(deps(db), owner.pubkey, event, { newestOnRelays: NOW })).toEqual({
      ok: false,
      error: 'stale',
    });
    // Another list was committed since (another tab), dated at or after this one.
    const otherEvent = finalizeEvent({ ...draft.template, created_at: NOW + 2 }, owner.secret);
    await db.query(
      `insert into owner_events (id, owner, kind, event, payouts_string, committed_at)
       values ($1, $2, $3, $4::jsonb, $5, $6)`,
      [otherEvent.id, owner.pubkey, KIND_PAYTO, JSON.stringify(otherEvent), '[]', NOW],
    );
    expect(await commitOwnerEvent(deps(db), owner.pubkey, event)).toEqual({
      ok: false,
      error: 'stale',
    });
  });

  it('refuses a list dated the same second as another committed one', async () => {
    const db = await freshDb();
    const { owner } = await storeWithDraft(db);
    const draft = await prepared(db, owner.pubkey, KIND_PAYTO);
    const event = finalizeEvent(draft.template, owner.secret);
    await insertCommitted(db, owner, KIND_PAYTO, event.created_at);
    expect(await commitOwnerEvent(deps(db), owner.pubkey, event)).toEqual({
      ok: false,
      error: 'stale',
    });
  });

  it('queues the recording again for an unrecorded event whose request failed', async () => {
    const db = await freshDb();
    const { owner } = await storeWithDraft(db);
    const draft = await prepared(db, owner.pubkey, KIND_PAYTO);
    const event = finalizeEvent(draft.template, owner.secret);
    const first = await commitOwnerEvent(deps(db), owner.pubkey, event);
    if (!first.ok || first.requestId === undefined) {
      throw new Error('commit refused');
    }
    await markRequest(db, owner.pubkey, first.requestId, 'failed', NOW, { problem: 'relays down' });
    const again = await commitOwnerEvent(deps(db, NOW + 1), owner.pubkey, event);
    expect(again).toMatchObject({ ok: true, id: event.id, alreadyCommitted: true });
    const requests = await pendingRequests(db, owner.pubkey);
    expect(requests.map((request) => [request.id, request.kind, request.payload])).toEqual([
      [again.ok ? again.requestId : '', 'record_owner_event', { eventId: event.id }],
    ]);
    // Pending already: nothing more is queued.
    expect(await commitOwnerEvent(deps(db, NOW + 2), owner.pubkey, event)).toMatchObject({
      alreadyCommitted: true,
      requestId: undefined,
    });
    // Recorded: nothing to do.
    await db.query('update owner_events set recorded = true where id = $1', [event.id]);
    await markRequest(db, owner.pubkey, again.ok ? (again.requestId ?? '') : '', 'failed', NOW);
    expect(await commitOwnerEvent(deps(db, NOW + 3), owner.pubkey, event)).toMatchObject({
      alreadyCommitted: true,
      requestId: undefined,
    });
    expect(await pendingRequests(db, owner.pubkey)).toEqual([]);
  });

  it('refuses owner events for a store winding down', async () => {
    for (const status of ['suspending', 'suspended']) {
      const db = await freshDb();
      const { owner } = await storeWithDraft(db);
      const draft = await prepared(db, owner.pubkey, KIND_PAYTO);
      const event = finalizeEvent(draft.template, owner.secret);
      await db.query("insert into tiers (name, max_products) values ('t', 1)");
      await db.query("update stores set status = $2, tier = 't' where owner = $1", [
        owner.pubkey,
        status,
      ]);
      expect(await prepareOwnerEvent(deps(db), owner.pubkey, KIND_STORE_AUTH)).toMatchObject({
        ok: false,
        error: 'suspended',
      });
      expect(await commitOwnerEvent(deps(db), owner.pubkey, event)).toMatchObject({
        ok: false,
        error: 'suspended',
      });
      expect(await db.query('select 1 from owner_events')).toEqual([]);
      expect(await pendingRequests(db, owner.pubkey)).toEqual([]);
    }
  });

  it('accepts a list that keeps its recorded date, the relays serving that date', async () => {
    const db = await freshDb();
    const { owner, directory } = await storeWithDraft(db);
    const text =
      canonicalPayouts((await directory.settings(owner.pubkey))?.draftPayouts)?.text ?? '';
    await setPayto(db, owner.pubkey, { createdAt: NOW - 50, payouts: text });
    const draft = await prepared(db, owner.pubkey, KIND_PAYTO, NOW - 50);
    const event = finalizeEvent(draft.template, owner.secret);
    expect(
      await commitOwnerEvent(deps(db), owner.pubkey, event, { newestOnRelays: NOW - 50 }),
    ).toMatchObject({ ok: true });
  });
});

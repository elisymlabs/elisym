import { KIND_PAYTO } from '@elisym/commerce';
import { describe, expect, it, vi } from 'vitest';
import { createAdminApi } from '../src/admin/api';
import { prepareOwnerEvent } from '../src/owner-events';
import { freshDb } from './pglite-db';
import {
  BASE,
  NOW,
  OPERATOR,
  RELAY,
  authHeader,
  directoryFor,
  ownerKeys,
  signedPayouts,
} from './stores-fixtures';

const BUILDER_TEXT = 'EIP-55 checksum mismatch, likely a typo: 0xAbC';

vi.mock('@merchant-node/store-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@merchant-node/store-events')>();
  return {
    ...actual,
    ownerEventTemplates: () => {
      throw new Error(BUILDER_TEXT);
    },
  };
});

describe('prepare: a payout list the builder refuses (A15)', () => {
  it('answers bad_payouts with no message, never the builder text', async () => {
    const db = await freshDb();
    const owner = ownerKeys();
    const directory = directoryFor(db);
    await directory.createStore(owner.pubkey, { name: 'Shop', network: 'devnet' });
    expect(
      (
        await directory.putConfig(owner.pubkey, {
          name: 'Shop',
          payouts: signedPayouts(owner.pubkey),
          inboxRelays: [RELAY],
        })
      ).ok,
    ).toBe(true);
    const result = await prepareOwnerEvent(
      { db, operator: OPERATOR, now: () => NOW },
      owner.pubkey,
      KIND_PAYTO,
    );
    expect(result).toEqual({ ok: false, error: 'bad_payouts' });
    expect(await db.query('select 1 from owner_event_drafts')).toEqual([]);
  });

  it('answers 409 with exactly the code over the admin route', async () => {
    const db = await freshDb();
    const owner = ownerKeys();
    const directory = directoryFor(db);
    await directory.createStore(owner.pubkey, { name: 'Shop', network: 'devnet' });
    await directory.putConfig(owner.pubkey, {
      name: 'Shop',
      payouts: signedPayouts(owner.pubkey),
      inboxRelays: [RELAY],
    });
    const api = createAdminApi({
      directory,
      db,
      publicBase: `${BASE}/`,
      operator: OPERATOR,
      now: () => NOW,
    });
    const path = '/v1/admin/owner-events/prepare';
    const body = JSON.stringify({ kind: KIND_PAYTO });
    const request = new Request(`http://internal${path}`, {
      method: 'POST',
      headers: {
        authorization: authHeader({
          secret: owner.secret,
          method: 'POST',
          url: `${BASE}${path}`,
          body,
        }),
      },
      body,
    });
    const response = await api({ request, clientAddress: '203.0.113.7' });
    expect(response?.status).toBe(409);
    expect(await response?.text()).toBe(JSON.stringify({ error: 'bad_payouts' }));
  });
});

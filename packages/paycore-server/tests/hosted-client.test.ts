/**
 * The hosted admin's browser client (`merchant-admin/src/hosted/lib`) against
 * the real admin API: its NIP-98 headers through the real `checkNip98`, the
 * real routes on pglite, `/v1/meta` as the server builds it, and the clock
 * offset the client learns from `Date`.
 */
import { type HostedApi, createHostedApi } from '@hosted-admin/api';
import { secretKeySigner } from '@hosted-admin/signer';
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../src/admin/api';
import { metaView } from '../src/admin/meta';
import type { Db } from '../src/db/db';
import { META_PATH } from '../src/gateway/http';
import { freshDb } from './pglite-db';
import {
  BASE,
  NOW,
  OPERATOR,
  RELAY,
  RPCS,
  directoryFor,
  ownerKeys,
  signedPayouts,
} from './stores-fixtures';

interface Harness {
  api: HostedApi;
  owner: { secret: Uint8Array; pubkey: string };
  /** Every request the client sent, as the server received it. */
  sent: Request[];
  /** Hand a request to the server again, unchanged. */
  resend: (request: Request) => Promise<Response>;
}

/** A client whose `fetch` hands each request to the real handler, answers dated by the server clock. */
function harness(db: Db, localNow: () => number): Harness {
  const directory = directoryFor(db);
  const admin = createAdminApi({
    directory,
    db,
    publicBase: BASE,
    operator: OPERATOR,
    now: () => NOW,
  });
  const meta = metaView(
    { publicBase: BASE, operator: OPERATOR, rpcs: RPCS, inboxRelays: [RELAY], storeMoves: false },
    directory.pendingMaxProducts,
  );
  const sent: Request[] = [];
  const handle = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const answer =
      path === META_PATH && request.method === 'GET'
        ? new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } })
        : ((await admin({ request, clientAddress: '203.0.113.9' })) ??
          new Response('{"error":"not_found"}', { status: 404 }));
    const headers = new Headers(answer.headers);
    headers.set('date', new Date(NOW * 1000).toUTCString());
    return new Response(await answer.text(), { status: answer.status, headers });
  };
  const owner = ownerKeys();
  const api = createHostedApi({
    base: BASE,
    signer: secretKeySigner(owner.secret),
    localNow,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      sent.push(request.clone());
      return handle(request);
    },
  });
  return { api, owner, sent, resend: (request) => handle(request.clone()) };
}

describe('hosted admin client against the real admin API', () => {
  it('reads /v1/meta as the server builds it', async () => {
    const db = await freshDb();
    const { api } = harness(db, () => NOW);
    expect(await api.meta()).toEqual({
      publicBase: BASE,
      operator: OPERATOR,
      networks: {
        mainnet: { coins: [] },
        devnet: {
          coins: [
            'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
          ],
        },
      },
      inboxRelays: [RELAY],
      pendingMaxProducts: 20,
      storeMoves: false,
    });
  });

  it('creates, reads and configures a store; a replayed authorization is refused', async () => {
    const db = await freshDb();
    const { api, owner, sent, resend } = harness(db, () => NOW);
    const created = await api.createStore({ name: 'Shop', network: 'devnet' });
    expect(created).toMatchObject({ owner: owner.pubkey, status: 'pending', maxProducts: 20 });
    const view = await api.store();
    expect(view.config).toMatchObject({ name: 'Shop', revision: 1 });
    const payouts = signedPayouts(owner.pubkey);
    const put = await api.putConfig({
      name: 'Shop',
      payouts,
      inboxRelays: [RELAY],
      expectedRevision: 1,
    });
    expect(put.config).toMatchObject({ draftPayouts: payouts, revision: 2 });
    expect((await api.store()).payouts).toEqual({ needsSigning: true });
    await expect(
      api.putConfig({ name: 'Late', payouts, inboxRelays: [RELAY], expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 409, code: 'stale_config' });
    const read = sent.find((request) => request.method === 'GET');
    if (read === undefined) {
      throw new Error('no GET was sent');
    }
    const replayed = await resend(read);
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toEqual({ error: 'unauthorized', reason: 'replay' });
  });

  it('dates its authorizations by the server clock: one stale refusal, then signed again', async () => {
    const db = await freshDb();
    // The local clock runs 10 minutes behind the server's.
    const { api, sent } = harness(db, () => NOW - 600);
    await api.createStore({ name: 'Shop', network: 'devnet' });
    expect(sent.map((request) => request.method)).toEqual(['POST', 'POST']);
    const signedAt = (request: Request | undefined) => {
      const header = request?.headers.get('authorization') ?? '';
      const event: unknown = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'));
      return typeof event === 'object' && event !== null && 'created_at' in event
        ? event.created_at
        : undefined;
    };
    expect(signedAt(sent[0])).toBe(NOW - 600);
    expect(signedAt(sent[1])).toBe(NOW);
    // The offset stays learned: the next call is right the first time.
    await api.store();
    expect(sent).toHaveLength(3);
    expect(signedAt(sent[2])).toBe(NOW);
  });
});

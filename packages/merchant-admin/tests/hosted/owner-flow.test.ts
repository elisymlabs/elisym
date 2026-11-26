import { describe, expect, it, vi } from 'vitest';
import { checklist } from '../../src/hosted/lib/checklist';
import { commitSigned, followRequest } from '../../src/hosted/lib/owner-flow';
import { expectedPayouts, payoutsOf } from '../../src/hosted/lib/payout-rows';
import type { RequestView } from '../../src/hosted/lib/types';
import { storeView } from './fakes';
import {
  NOW,
  SOLANA_ADDRESS,
  SOLANA_USDC,
  authorizationTemplate,
  fakeSession,
  payoutListTemplate,
  signed,
  storeConfig,
} from './store-fakes';

function view(id: string, state: RequestView['state']): { request: RequestView } {
  return {
    request: {
      id,
      kind: 'record_owner_event',
      state,
      result: null,
      createdAt: NOW,
      appliedAt: null,
    },
  };
}

const instant = async () => undefined;

describe('following a request', () => {
  it('skips a read that fails and goes on to the applied one', async () => {
    let reads = 0;
    const request = vi.fn(async (id: string) => {
      reads += 1;
      if (reads === 1) {
        throw new Error('offline');
      }
      return view(id, 'applied');
    });
    expect(await followRequest({ request }, 'r1', { sleep: instant })).toEqual({ kind: 'done' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reads nothing more once its signal is aborted', async () => {
    const controller = new AbortController();
    const request = vi.fn(async (id: string) => view(id, 'pending'));
    const sleep = async () => {
      if (request.mock.calls.length === 2) {
        controller.abort();
      }
    };
    expect(await followRequest({ request }, 'r1', { sleep, signal: controller.signal })).toEqual({
      kind: 'still',
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('a commit answered with no request (committed before)', () => {
  it('is done on an active store, and waits for the activation on a pending one', async () => {
    const event = signed(authorizationTemplate());
    const { api } = fakeSession({
      commitOwnerEvent: async () => ({ id: event.id, alreadyCommitted: true }),
    });
    expect(await commitSigned(api, event, false)).toEqual({ kind: 'done' });
    expect(await commitSigned(api, event, true)).toEqual({ kind: 'on_activation' });
  });
});

describe('payout rows', () => {
  it('saves an address trimmed', () => {
    expect(
      payoutsOf([{ caip19: SOLANA_USDC, address: `  ${SOLANA_ADDRESS} `, signature: 's' }]),
    ).toEqual({
      ok: true,
      payouts: [{ caip19: SOLANA_USDC, address: SOLANA_ADDRESS, signature: 's' }],
    });
  });

  it('expects what this page saved up to its revision, then the draft', () => {
    const saved = { payouts: [{ caip19: SOLANA_USDC, address: 'mine' }], revision: 3 };
    const draft = [{ caip19: SOLANA_USDC, address: 'theirs' }];
    expect(expectedPayouts(saved, storeConfig({ draftPayouts: draft, revision: 2 }))).toBe(
      saved.payouts,
    );
    expect(expectedPayouts(saved, storeConfig({ draftPayouts: draft, revision: 3 }))).toBe(
      saved.payouts,
    );
    expect(expectedPayouts(saved, storeConfig({ draftPayouts: draft, revision: 4 }))).toBe(draft);
    expect(expectedPayouts(undefined, storeConfig({ draftPayouts: draft, revision: 1 }))).toBe(
      draft,
    );
  });
});

describe('the checklist', () => {
  it('calls a signed event published only once it has a publish date', () => {
    const payto = { event: signed(payoutListTemplate([])), committedAt: NOW, publishedAt: null };
    const auth = { event: signed(authorizationTemplate()), committedAt: NOW, publishedAt: null };
    const states = Object.fromEntries(
      checklist(storeView({ ownerEvents: { payto, auth } }), undefined).map((item) => [
        item.id,
        item.state,
      ]),
    );
    expect(states).toMatchObject({
      'payto-signed': 'done',
      'payto-published': 'todo',
      'auth-signed': 'done',
      'auth-published': 'todo',
    });
  });
});

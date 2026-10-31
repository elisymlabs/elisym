import { MAX_FUTURE_SKEW_SECS, storeAuthAddress } from '@elisym/commerce';
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { createConsoleApi } from '../../src/cloud/lib/api';
import {
  CLOCK_SKEW_SECS,
  SHOWN_AHEAD_SECS,
  SIGN_AHEAD_SECS,
  type OwnerEventsRead,
  currentPayoutList,
  decisionText,
  newest,
  readOwnerEvents,
  revocationInForce,
  signingDecision,
} from '../../src/cloud/lib/owner-events';
import { OwnerKey } from '../../src/cloud/lib/owner-key';

const NOW = 1_800_000_000;
const OWNER = OwnerKey.create();
const OTHER = OwnerKey.create();
const STORE = '1'.repeat(64);
const OTHER_STORE = '2'.repeat(64);

function list(key: OwnerKey, createdAt: number): NostrEvent {
  return key.sign({
    kind: 10133,
    created_at: createdAt,
    tags: [['accept', 'x', 'y']],
    content: '',
  });
}

function revocation(key: OwnerKey, createdAt: number, store = STORE): NostrEvent {
  return key.sign({
    kind: 30490,
    created_at: createdAt,
    tags: [
      ['d', store],
      ['mode', 'revoked'],
    ],
    content: '',
  });
}

function deletion(key: OwnerKey, createdAt: number, address: string): NostrEvent {
  return key.sign({ kind: 5, created_at: createdAt, tags: [['a', address]], content: '' });
}

function hostedAuth(key: OwnerKey, createdAt: number, store = STORE): NostrEvent {
  return key.sign({
    kind: 30490,
    created_at: createdAt,
    tags: [
      ['d', store],
      ['p', store],
      ['mode', 'hosted'],
    ],
    content: '',
  });
}

/** What the relays held: lists, revocations, AUTHs. */
function seen(
  payoutLists: NostrEvent[] = [],
  revocations: NostrEvent[] = [],
  auths: NostrEvent[] = [],
): OwnerEventsRead {
  return { payoutLists, revocations, auths };
}

const EMPTY = seen();

describe("reading the owner's events in the page", () => {
  it('asks for the lists, this store AUTH and deletions of its address; keeps only the valid ones of the owner', async () => {
    const address = storeAuthAddress(OWNER.pubkey, STORE);
    const good = list(OWNER, NOW - 10);
    // As a relay hands it over (JSON: no cached verification), tampered after signing.
    const forged: NostrEvent = {
      ...JSON.parse(JSON.stringify(list(OWNER, NOW - 5))),
      content: 'tampered',
    };
    const revoked = revocation(OWNER, NOW - 20);
    const hosted = hostedAuth(OWNER, NOW - 30);
    // Expired, or malformed (no `p`) with this store's address: buyers still take them as the newest AUTH.
    const expired = OWNER.sign({
      kind: 30490,
      created_at: NOW - 35,
      tags: [
        ['d', STORE],
        ['p', STORE],
        ['mode', 'hosted'],
        // Expired on the real clock too (the read judges status by it).
        ['expiration', '1000'],
      ],
      content: '',
    });
    const noP = OWNER.sign({
      kind: 30490,
      created_at: NOW - 36,
      tags: [
        ['d', STORE],
        ['mode', 'hosted'],
      ],
      content: '',
    });
    const deleted = deletion(OWNER, NOW - 40, address);
    const asked: Filter[] = [];
    const answers: Record<number, NostrEvent[]> = {
      10133: [good, forged, list(OTHER, NOW)],
      30490: [
        revoked,
        hosted,
        expired,
        noP,
        // Matched by the relay on its second `d`, but buyers take it as the other store's AUTH.
        OWNER.sign({
          kind: 30490,
          created_at: NOW - 37,
          tags: [
            ['d', OTHER_STORE],
            ['d', STORE],
            ['p', OTHER_STORE],
            ['mode', 'hosted'],
          ],
          content: '',
        }),
        revocation(OWNER, NOW, OTHER_STORE),
        hostedAuth(OWNER, NOW, OTHER_STORE),
        revocation(OTHER, NOW),
        hostedAuth(OTHER, NOW),
      ],
      5: [
        deleted,
        deletion(OWNER, NOW, storeAuthAddress(OWNER.pubkey, OTHER_STORE)),
        deletion(OTHER, NOW, address),
      ],
    };
    const read = await readOwnerEvents(
      async (filter) => {
        asked.push(filter);
        return answers[filter.kinds?.[0] ?? -1] ?? [];
      },
      OWNER.pubkey,
      STORE,
    );
    expect(asked).toEqual([
      { kinds: [10133], authors: [OWNER.pubkey] },
      { kinds: [30490], authors: [OWNER.pubkey], '#d': [STORE] },
      { kinds: [5], authors: [OWNER.pubkey], '#a': [address] },
    ]);
    expect(read.payoutLists).toEqual([good]);
    expect(read.revocations).toEqual([revoked, deleted]);
    expect(read.auths).toEqual([hosted, expired, noP]);
  });

  it('the three reads go out side by side', async () => {
    let open = 0;
    let most = 0;
    await readOwnerEvents(
      async () => {
        open += 1;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open -= 1;
        return [];
      },
      OWNER.pubkey,
      STORE,
    );
    expect(most).toBe(3);
  });

  it('the newest is the latest, and of two in one second the lowest id', () => {
    const early = list(OWNER, NOW - 1);
    const one = list(OWNER, NOW);
    const other = OWNER.sign({
      kind: 10133,
      created_at: NOW,
      tags: [['accept', 'z', 'w']],
      content: '',
    });
    const lower = one.id < other.id ? one : other;
    const higher = lower === one ? other : one;
    expect(newest([early, higher, lower])).toBe(lower);
    expect(newest([lower, higher, early])).toBe(lower);
    expect(newest([])).toBeUndefined();
  });

  it('the list shown as current is the newest not more than 15 minutes ahead of the local clock', () => {
    expect(SHOWN_AHEAD_SECS).toBe(MAX_FUTURE_SKEW_SECS);
    const now = list(OWNER, NOW - 60);
    const atLimit = list(OWNER, NOW + SHOWN_AHEAD_SECS);
    const beyond = list(OWNER, NOW + SHOWN_AHEAD_SECS + 1);
    expect(currentPayoutList(seen([now, beyond]), NOW)).toBe(now);
    expect(currentPayoutList(seen([now, atLimit, beyond]), NOW)).toBe(atLimit);
    expect(currentPayoutList(EMPTY, NOW)).toBeUndefined();
  });
});

describe('a revocation in force', () => {
  it('is the newest revocation not older than the newest AUTH buyers take, or with no AUTH', () => {
    const revoked = revocation(OWNER, NOW - 100);
    expect(revocationInForce(seen([], [revoked]), NOW)).toBe(revoked);
    // Re-authorized after it: superseded.
    expect(
      revocationInForce(seen([], [revoked], [hostedAuth(OWNER, NOW - 50)]), NOW),
    ).toBeUndefined();
    // One second later is enough to supersede it.
    expect(
      revocationInForce(seen([], [revoked], [hostedAuth(OWNER, NOW - 99)]), NOW),
    ).toBeUndefined();
    // In the same second: the revocation wins, as the node and buyers judge.
    expect(revocationInForce(seen([], [revoked], [hostedAuth(OWNER, NOW - 100)]), NOW)).toBe(
      revoked,
    );
    // An older AUTH does not supersede it.
    expect(revocationInForce(seen([], [revoked], [hostedAuth(OWNER, NOW - 200)]), NOW)).toBe(
      revoked,
    );
    // An AUTH buyers would skip (more than 15 min ahead) supersedes nothing.
    expect(
      revocationInForce(seen([], [revoked], [hostedAuth(OWNER, NOW + SHOWN_AHEAD_SECS + 1)]), NOW),
    ).toBe(revoked);
    expect(
      revocationInForce(seen([], [revoked], [hostedAuth(OWNER, NOW + SHOWN_AHEAD_SECS)]), NOW),
    ).toBeUndefined();
    // An expired AUTH after it supersedes it too (buyers then say expired, not revoked).
    const expiredAuth = OWNER.sign({
      kind: 30490,
      created_at: NOW - 50,
      tags: [
        ['d', STORE],
        ['p', STORE],
        ['mode', 'hosted'],
        ['expiration', '1000'],
      ],
      content: '',
    });
    expect(revocationInForce(seen([], [revoked], [expiredAuth]), NOW)).toBeUndefined();
    // Relays answer in any order: the newest revocation and the newest AUTH decide, wherever they are.
    const recent = revocation(OWNER, NOW - 10);
    const old = deletion(OWNER, NOW - 200, storeAuthAddress(OWNER.pubkey, STORE));
    expect(revocationInForce(seen([], [recent, old], [hostedAuth(OWNER, NOW - 50)]), NOW)).toBe(
      recent,
    );
    expect(
      revocationInForce(
        seen([], [revoked], [hostedAuth(OWNER, NOW - 50), hostedAuth(OWNER, NOW - 200)]),
        NOW,
      ),
    ).toBeUndefined();
    expect(
      revocationInForce(
        seen([], [revoked], [hostedAuth(OWNER, NOW - 200), hostedAuth(OWNER, NOW - 50)]),
        NOW,
      ),
    ).toBeUndefined();
    // A deletion of the AUTH address, re-authorized after: superseded as well.
    const deleted = deletion(OWNER, NOW - 100, storeAuthAddress(OWNER.pubkey, STORE));
    expect(
      revocationInForce(seen([], [deleted], [hostedAuth(OWNER, NOW - 50)]), NOW),
    ).toBeUndefined();
    expect(revocationInForce(seen([], [deleted], [hostedAuth(OWNER, NOW - 150)]), NOW)).toBe(
      deleted,
    );
    // The newest of several revocations counts.
    const later = deletion(OWNER, NOW - 10, storeAuthAddress(OWNER.pubkey, STORE));
    expect(revocationInForce(seen([], [revoked, later], [hostedAuth(OWNER, NOW - 50)]), NOW)).toBe(
      later,
    );
    expect(revocationInForce(EMPTY, NOW)).toBeUndefined();
  });
});

describe('the date rules for signing', () => {
  const decide = (
    read: OwnerEventsRead,
    extra: { serverNow?: number | undefined; reauthorize?: boolean } = {},
  ) =>
    signingDecision({
      localNow: NOW,
      serverNow: 'serverNow' in extra ? extra.serverNow : NOW,
      read,
      reauthorize: extra.reauthorize ?? false,
    });

  it('refuses while the clocks are more than 2 minutes apart; says so when the server time is not known yet', () => {
    expect(CLOCK_SKEW_SECS).toBe(120);
    expect(decide(EMPTY, { serverNow: NOW - 121 })).toEqual({ kind: 'fix-clock', skewSecs: 121 });
    expect(decide(EMPTY, { serverNow: NOW + 121 })).toEqual({ kind: 'fix-clock', skewSecs: -121 });
    expect(decide(EMPTY, { serverNow: undefined })).toEqual({ kind: 'server-time-unknown' });
    expect(decide(EMPTY, { serverNow: NOW - 120 })).toEqual({ kind: 'sign', createdAt: NOW });
    expect(decide(EMPTY, { serverNow: NOW + 120 })).toEqual({ kind: 'sign', createdAt: NOW });
  });

  it('signs at the local clock when every event of the owner is older', () => {
    expect(decide(seen([list(OWNER, NOW - 1)]))).toEqual({ kind: 'sign', createdAt: NOW });
  });

  it('a list dated now or later waits for its date + 1 s; more than 14 minutes ahead is explained', () => {
    expect(SIGN_AHEAD_SECS).toBe(14 * 60);
    expect(decide(seen([list(OWNER, NOW)]))).toEqual({
      kind: 'wait',
      what: 'payout list',
      until: NOW + 1,
    });
    expect(decide(seen([list(OWNER, NOW + SIGN_AHEAD_SECS)]))).toEqual({
      kind: 'wait',
      what: 'payout list',
      until: NOW + SIGN_AHEAD_SECS + 1,
    });
    // With no future filter: a list buyers would not show yet still decides.
    expect(decide(seen([list(OWNER, NOW + SIGN_AHEAD_SECS + 1)]))).toEqual({
      kind: 'ahead',
      what: 'payout list',
      date: NOW + SIGN_AHEAD_SECS + 1,
    });
    expect(decide(seen([list(OWNER, NOW - 5), list(OWNER, NOW + 3600)]))).toMatchObject({
      kind: 'ahead',
    });
  });

  it('a revocation in force is named first, and signed past only on the explicit choice', () => {
    const older = revocation(OWNER, NOW - 100);
    expect(decide(seen([], [older]))).toEqual({ kind: 'revoked', date: NOW - 100 });
    expect(decide(seen([], [older]), { reauthorize: true })).toEqual({
      kind: 'sign',
      createdAt: NOW,
    });
    // Dated ahead (another device's fast clock): still named first, its date rule after the choice.
    const ahead = revocation(OWNER, NOW + 10);
    expect(decide(seen([], [ahead]))).toEqual({ kind: 'revoked', date: NOW + 10 });
    expect(decide(seen([], [ahead]), { reauthorize: true })).toEqual({
      kind: 'wait',
      what: 'revocation',
      until: NOW + 11,
    });
    expect(
      decide(seen([list(OWNER, NOW)], [revocation(OWNER, NOW + SIGN_AHEAD_SECS + 1)]), {
        reauthorize: true,
      }),
    ).toEqual({ kind: 'ahead', what: 'revocation', date: NOW + SIGN_AHEAD_SECS + 1 });
    // A list that must also wait: its rule still holds after re-authorizing.
    expect(decide(seen([list(OWNER, NOW + 10)], [older]), { reauthorize: true })).toEqual({
      kind: 'wait',
      what: 'payout list',
      until: NOW + 11,
    });
    // Several revocations: the newest decides (an older one listed first).
    expect(
      decide(
        seen(
          [],
          [
            deletion(OWNER, NOW - 40, storeAuthAddress(OWNER.pubkey, STORE)),
            revocation(OWNER, NOW + 10),
          ],
        ),
        { reauthorize: true },
      ),
    ).toEqual({ kind: 'wait', what: 'revocation', until: NOW + 11 });
    // The clock comes before everything.
    expect(decide(seen([], [older]), { serverNow: NOW + 500 })).toMatchObject({
      kind: 'fix-clock',
    });
  });

  it('a revocation the owner already re-authorized past is not named again', () => {
    expect(
      decide(
        seen([list(OWNER, NOW - 5)], [revocation(OWNER, NOW - 100)], [hostedAuth(OWNER, NOW - 50)]),
      ),
    ).toEqual({ kind: 'sign', createdAt: NOW });
    expect(
      decide(seen([], [revocation(OWNER, NOW - 100)], [hostedAuth(OWNER, NOW - 100)])),
    ).toEqual({
      kind: 'revoked',
      date: NOW - 100,
    });
  });
});

describe("the server's clock as the client learned it", () => {
  it('is unknown before any answer, then the local clock plus the offset of the last Date', async () => {
    let local = NOW;
    const client = createConsoleApi({
      apiOrigin: 'https://api.cloud.test',
      signer: OwnerKey.create(),
      fetcher: async () =>
        Response.json({}, { headers: { date: new Date((NOW + 300) * 1000).toUTCString() } }),
      localNow: () => local,
    });
    expect(client.serverNow()).toBeUndefined();
    await client.request('GET', '/owner');
    expect(client.serverNow()).toBe(NOW + 300);
    local = NOW + 10;
    expect(client.serverNow()).toBe(NOW + 310);
  });

  it('a Date equal to the local clock is learned (an offset of 0)', async () => {
    const client = createConsoleApi({
      apiOrigin: 'https://api.cloud.test',
      signer: OwnerKey.create(),
      fetcher: async () =>
        Response.json({}, { headers: { date: new Date(NOW * 1000).toUTCString() } }),
      localNow: () => NOW,
    });
    await client.request('GET', '/owner');
    expect(client.serverNow()).toBe(NOW);
  });

  it('an answer with no Date keeps what was learned; none at all stays unknown', async () => {
    let withDate = true;
    const client = createConsoleApi({
      apiOrigin: 'https://api.cloud.test',
      signer: OwnerKey.create(),
      fetcher: async () =>
        withDate
          ? Response.json({}, { headers: { date: new Date((NOW + 300) * 1000).toUTCString() } })
          : Response.json({}),
      localNow: () => NOW,
    });
    await client.request('GET', '/owner');
    withDate = false;
    await client.request('GET', '/owner');
    expect(client.serverNow()).toBe(NOW + 300);
    const never = createConsoleApi({
      apiOrigin: 'https://api.cloud.test',
      signer: OwnerKey.create(),
      fetcher: async () => Response.json({}),
      localNow: () => NOW,
    });
    await never.request('GET', '/owner');
    expect(never.serverNow()).toBeUndefined();
  });
});

describe('a decision in the merchant words', () => {
  const at = (seconds: number) =>
    `${new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

  it('says nothing to sign now; else what holds it and until when, to the second', () => {
    expect(decisionText({ kind: 'sign', createdAt: NOW })).toBeUndefined();
    expect(decisionText({ kind: 'server-time-unknown' })).toBe(
      "The console could not read the cloud's time yet: try again in a moment.",
    );
    expect(decisionText({ kind: 'fix-clock', skewSecs: -150 })).toBe(
      'Your device clock is 150 seconds off: set it right, then sign.',
    );
    expect(decisionText({ kind: 'wait', what: 'payout list', until: NOW + 61 })).toBe(
      `A payout list of yours is dated ${at(NOW + 60)}: you can sign from ${at(NOW + 61)}.`,
    );
    expect(decisionText({ kind: 'ahead', what: 'revocation', date: NOW + 3600 })).toBe(
      `A revocation of yours dated ${at(NOW + 3600)} is on the relays and outranks anything signed before then.`,
    );
    expect(decisionText({ kind: 'revoked', date: NOW - 100 })).toBe(
      `You revoked this store on ${at(NOW - 100)}. Re-authorize it to sign, or withdraw it.`,
    );
    expect(at(1_800_000_000)).toBe('2027-01-15 08:00:00 UTC');
  });
});

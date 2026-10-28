import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KIND_DELETION,
  KIND_STORE_AUTH,
  MAX_FUTURE_SKEW_SECS,
  buildPaytoEvent,
  buildStoreAuthEvent,
  buildStoreRevocationEvent,
  storeAuthAddress,
} from '@elisym/commerce';
import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { emptyLedger } from '../src/ledger';
import {
  OwnerRefusal,
  checkOwnerEvents,
  payoutListRefusal,
  readOwnerEventsFile,
  readStoreAuthHistory,
  revocationDate,
  revocationRefusal,
  supersedingAuthRefusal,
} from '../src/owner-events';
import { PAYOUT, T0, TREASURY, USDC_DEVNET_CAIP19 } from './fixtures';

const PAYOUTS: { caip19: string; address: string }[] = [
  { caip19: USDC_DEVNET_CAIP19, address: PAYOUT },
];

function owner() {
  const secret = generateSecretKey();
  const store = getPublicKey(generateSecretKey());
  const pubkey = getPublicKey(secret);
  const payoutList = (createdAt: number, payouts = PAYOUTS) =>
    finalizeEvent(buildPaytoEvent({ ownerPubkey: pubkey, accept: payouts, createdAt }), secret);
  const auth = (createdAt: number, mode: 'hosted' | 'self-host' = 'hosted', expiresAt?: number) =>
    finalizeEvent(
      buildStoreAuthEvent({
        storePubkey: store,
        mode,
        createdAt,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }),
      secret,
    );
  return { secret, pubkey, store, payoutList, auth };
}

function refusalOf(run: () => void): OwnerRefusal | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof OwnerRefusal) {
      return error;
    }
    throw error;
  }
  return undefined;
}

describe('the owner events of a store-only home', () => {
  it('accepts the owner, signed, with exactly the configured payouts and a standing AUTH', () => {
    const ownerKeys = owner();
    const expected = {
      ownerPubkey: ownerKeys.pubkey,
      storePubkey: ownerKeys.store,
      payouts: PAYOUTS,
      now: T0,
    };
    expect(() =>
      checkOwnerEvents(
        { payoutList: ownerKeys.payoutList(T0), auth: ownerKeys.auth(T0) },
        expected,
      ),
    ).not.toThrow();
    expect(() =>
      checkOwnerEvents(
        { payoutList: ownerKeys.payoutList(T0), auth: ownerKeys.auth(T0, 'self-host') },
        expected,
      ),
    ).not.toThrow();
  });

  it('refuses another signer, a wrong kind, a broken signature', () => {
    const ownerKeys = owner();
    const stranger = owner();
    const expected = {
      ownerPubkey: ownerKeys.pubkey,
      storePubkey: ownerKeys.store,
      payouts: PAYOUTS,
      now: T0,
    };
    // A changed date breaks the signature (through JSON: a spread would keep the cached verdict).
    const tampered: NostrEvent = {
      ...JSON.parse(JSON.stringify(ownerKeys.payoutList(T0))),
      created_at: T0 + 1,
    };
    for (const events of [
      { payoutList: stranger.payoutList(T0), auth: ownerKeys.auth(T0) },
      { payoutList: ownerKeys.auth(T0), auth: ownerKeys.auth(T0) },
      { payoutList: tampered, auth: ownerKeys.auth(T0) },
      { payoutList: ownerKeys.payoutList(T0), auth: ownerKeys.payoutList(T0) },
    ]) {
      expect(refusalOf(() => checkOwnerEvents(events, expected))?.reason).toBe('owner-resign');
    }
  });

  it('refuses a payout list that is not config.json payouts', () => {
    const ownerKeys = owner();
    const expected = {
      ownerPubkey: ownerKeys.pubkey,
      storePubkey: ownerKeys.store,
      payouts: PAYOUTS,
      now: T0,
    };
    const otherPayouts = [{ caip19: USDC_DEVNET_CAIP19, address: TREASURY }];
    expect(
      refusalOf(() =>
        checkOwnerEvents(
          { payoutList: ownerKeys.payoutList(T0, otherPayouts), auth: ownerKeys.auth(T0) },
          expected,
        ),
      )?.message,
    ).toMatch(/not config.json payouts/);
  });

  it('refuses a payout list whose content is not the one commerce builds', () => {
    const ownerKeys = owner();
    const expected = {
      ownerPubkey: ownerKeys.pubkey,
      storePubkey: ownerKeys.store,
      payouts: PAYOUTS,
      now: T0,
    };
    const withContent = finalizeEvent(
      {
        ...buildPaytoEvent({ ownerPubkey: ownerKeys.pubkey, accept: PAYOUTS, createdAt: T0 }),
        content: 'x',
      },
      ownerKeys.secret,
    );
    expect(
      refusalOf(() =>
        checkOwnerEvents({ payoutList: withContent, auth: ownerKeys.auth(T0) }, expected),
      )?.reason,
    ).toBe('owner-resign');
  });

  it('a revoking AUTH is refused as revoked even with a wrong payout list', () => {
    const ownerKeys = owner();
    const expected = {
      ownerPubkey: ownerKeys.pubkey,
      storePubkey: ownerKeys.store,
      payouts: PAYOUTS,
      now: T0,
    };
    const revoking = finalizeEvent(
      buildStoreRevocationEvent(ownerKeys.store, T0),
      ownerKeys.secret,
    );
    const otherPayouts = [{ caip19: USDC_DEVNET_CAIP19, address: TREASURY }];
    expect(
      refusalOf(() =>
        checkOwnerEvents(
          { payoutList: ownerKeys.payoutList(T0, otherPayouts), auth: revoking },
          expected,
        ),
      )?.reason,
    ).toBe('owner-revoked');
  });

  it('refuses an AUTH for another store, expired, or revoking', () => {
    const ownerKeys = owner();
    const expected = {
      ownerPubkey: ownerKeys.pubkey,
      storePubkey: ownerKeys.store,
      payouts: PAYOUTS,
      now: T0,
    };
    const otherStore = finalizeEvent(
      buildStoreAuthEvent({ storePubkey: getPublicKey(generateSecretKey()), mode: 'hosted' }),
      ownerKeys.secret,
    );
    expect(
      refusalOf(() =>
        checkOwnerEvents({ payoutList: ownerKeys.payoutList(T0), auth: otherStore }, expected),
      )?.reason,
    ).toBe('owner-resign');
    expect(
      refusalOf(() =>
        checkOwnerEvents(
          {
            payoutList: ownerKeys.payoutList(T0),
            auth: ownerKeys.auth(T0 - 100, 'hosted', T0 - 1),
          },
          expected,
        ),
      )?.reason,
    ).toBe('owner-resign');
    const revoking = finalizeEvent(
      buildStoreRevocationEvent(ownerKeys.store, T0),
      ownerKeys.secret,
    );
    expect(
      refusalOf(() =>
        checkOwnerEvents({ payoutList: ownerKeys.payoutList(T0), auth: revoking }, expected),
      )?.reason,
    ).toBe('owner-revoked');
  });

  it('reads the file, and says when it is missing or broken', () => {
    const ownerKeys = owner();
    const dir = mkdtempSync(join(tmpdir(), 'owner-events-'));
    const path = join(dir, 'owner-events.json');
    expect(() => readOwnerEventsFile(path)).toThrow(/has no owner-events.json/);
    writeFileSync(path, '{');
    expect(() => readOwnerEventsFile(path)).toThrow(/is not JSON/);
    writeFileSync(path, JSON.stringify({ payoutList: {} }));
    expect(() => readOwnerEventsFile(path)).toThrow(/no usable events/);
    const events = { payoutList: ownerKeys.payoutList(T0), auth: ownerKeys.auth(T0) };
    writeFileSync(path, JSON.stringify(events));
    expect(readOwnerEventsFile(path)).toEqual(JSON.parse(JSON.stringify(events)));
  });
});

describe('the date rule of a signed payout list', () => {
  const payouts = JSON.stringify(PAYOUTS);

  it('passes a first list, a newer one, an unchanged one, and a retry of one already published', () => {
    const ownerKeys = owner();
    const state = emptyLedger();
    expect(() =>
      payoutListRefusal(ownerKeys.payoutList(T0), state, payouts, undefined),
    ).not.toThrow();
    state.payto = { createdAt: T0, payouts };
    expect(() =>
      payoutListRefusal(ownerKeys.payoutList(T0), state, payouts, undefined),
    ).not.toThrow();
    const newer = ownerKeys.payoutList(T0 + 10);
    expect(() => payoutListRefusal(newer, state, payouts, ownerKeys.payoutList(T0))).not.toThrow();
    expect(() => payoutListRefusal(newer, state, payouts, newer)).not.toThrow();
  });

  it('refuses an older list, an equal date with other payouts, and a newer list on the relays', () => {
    const ownerKeys = owner();
    const state = emptyLedger();
    state.payto = { createdAt: T0, payouts };
    expect(
      refusalOf(() => payoutListRefusal(ownerKeys.payoutList(T0 - 1), state, payouts, undefined))
        ?.reason,
    ).toBe('owner-resign');
    expect(
      refusalOf(() => payoutListRefusal(ownerKeys.payoutList(T0), state, '[]', undefined))?.reason,
    ).toBe('owner-resign');
    const signed = ownerKeys.payoutList(T0 + 5);
    expect(
      refusalOf(() => payoutListRefusal(signed, state, payouts, ownerKeys.payoutList(T0 + 6)))
        ?.message,
    ).toMatch(/newer payout list/);
    // The same second, another event: the relays keep the lowest id, so it may win.
    const sameSecond: NostrEvent = { ...signed, id: '0'.repeat(64) };
    expect(refusalOf(() => payoutListRefusal(signed, state, payouts, sameSecond))?.reason).toBe(
      'owner-resign',
    );
  });
});

/** The revocation date the relays' history gives, as setup reads it. */
async function newestRevocation(
  pool: { querySync: (relays: string[], filter: Filter) => Promise<NostrEvent[]> },
  relays: string[],
  ownerPubkey: string,
  storePubkey: string,
): Promise<number | undefined> {
  return revocationDate(
    await readStoreAuthHistory(pool, relays, ownerPubkey, storePubkey),
    storePubkey,
  );
}

/** A pool over a fixed set of events, as the relays would serve them. */
function poolOf(events: NostrEvent[]) {
  return {
    querySync: async (_relays: string[], filter: Filter) =>
      events.filter((event) => matchFilter(filter, event)),
  };
}

/** A relay that ignores the filter: everything it holds, whatever was asked. */
function carelessPoolOf(events: NostrEvent[], asked: string[][] = []) {
  return {
    querySync: async (relays: string[]) => {
      asked.push(relays);
      return events;
    },
  };
}

describe('revocations of a store-only home', () => {
  it("counts only the owner's deletions and revoking AUTHs, whatever a relay returns", async () => {
    const ownerKeys = owner();
    const stranger = owner();
    const address = storeAuthAddress(ownerKeys.pubkey, ownerKeys.store);
    const byStranger = finalizeEvent(
      { kind: KIND_DELETION, created_at: T0 + 5, tags: [['a', address]], content: '' },
      stranger.secret,
    );
    // An owner-signed note that names the address but is no deletion.
    const notADeletion = finalizeEvent(
      { kind: 1, created_at: T0 + 6, tags: [['a', address]], content: '' },
      ownerKeys.secret,
    );
    // The owner's revocations of ANOTHER store of theirs: they say nothing about this one.
    const otherStore = getPublicKey(generateSecretKey());
    const otherDeletion = finalizeEvent(
      {
        kind: KIND_DELETION,
        created_at: T0 + 8,
        tags: [['a', storeAuthAddress(ownerKeys.pubkey, otherStore)]],
        content: '',
      },
      ownerKeys.secret,
    );
    const otherRevocation = finalizeEvent(
      buildStoreRevocationEvent(otherStore, T0 + 8),
      ownerKeys.secret,
    );
    // A stranger's revoking AUTH for this store, and the owner's one with a broken signature.
    const strangerRevocation = finalizeEvent(
      buildStoreRevocationEvent(ownerKeys.store, T0 + 9),
      stranger.secret,
    );
    const forgedRevocation: NostrEvent = {
      ...JSON.parse(
        JSON.stringify(
          finalizeEvent(buildStoreRevocationEvent(ownerKeys.store, T0 + 9), ownerKeys.secret),
        ),
      ),
      created_at: T0 + 10,
    };
    const asked: string[][] = [];
    expect(
      await newestRevocation(
        carelessPoolOf(
          [
            byStranger,
            notADeletion,
            ownerKeys.auth(T0 + 7),
            otherDeletion,
            otherRevocation,
            strangerRevocation,
            forgedRevocation,
          ],
          asked,
        ),
        ['wss://offer', 'wss://inbox'],
        ownerKeys.pubkey,
        ownerKeys.store,
      ),
    ).toBeUndefined();
    expect(asked).toEqual([
      ['wss://offer', 'wss://inbox'],
      ['wss://offer', 'wss://inbox'],
    ]);
  });

  it('finds the newest revoking AUTH or deletion, verified, by the owner only', async () => {
    const ownerKeys = owner();
    const stranger = owner();
    const address = storeAuthAddress(ownerKeys.pubkey, ownerKeys.store);
    const revoke = finalizeEvent(
      buildStoreRevocationEvent(ownerKeys.store, T0 + 5),
      ownerKeys.secret,
    );
    const deletion = finalizeEvent(
      { kind: KIND_DELETION, created_at: T0 + 9, tags: [['a', address]], content: '' },
      ownerKeys.secret,
    );
    const foreign = finalizeEvent(
      { kind: KIND_DELETION, created_at: T0 + 20, tags: [['a', address]], content: '' },
      stranger.secret,
    );
    const standing = ownerKeys.auth(T0 + 30);
    expect(
      await newestRevocation(
        poolOf([revoke, deletion, foreign, standing]),
        ['r'],
        ownerKeys.pubkey,
        ownerKeys.store,
      ),
    ).toBe(T0 + 9);
    expect(
      await newestRevocation(poolOf([standing]), ['r'], ownerKeys.pubkey, ownerKeys.store),
    ).toBeUndefined();
    // Through JSON, as a relay delivers it: a spread would carry nostr-tools' cached verdict.
    const broken: NostrEvent = { ...JSON.parse(JSON.stringify(deletion)), created_at: T0 + 40 };
    expect(
      await newestRevocation(poolOf([broken]), ['r'], ownerKeys.pubkey, ownerKeys.store),
    ).toBeUndefined();
  });

  it('a revocation not older than the AUTH revokes it; a tie revokes', () => {
    const ownerKeys = owner();
    const auth = ownerKeys.auth(T0);
    expect(() => revocationRefusal(auth, undefined)).not.toThrow();
    expect(() => revocationRefusal(auth, T0 - 1)).not.toThrow();
    expect(refusalOf(() => revocationRefusal(auth, T0))?.reason).toBe('owner-revoked');
    expect(refusalOf(() => revocationRefusal(auth, T0 + 1))?.reason).toBe('owner-revoked');
  });
});

describe('a newer AUTH on the relays', () => {
  async function historyOf(ownerKeys: ReturnType<typeof owner>, events: NostrEvent[]) {
    return readStoreAuthHistory(poolOf(events), ['r'], ownerKeys.pubkey, ownerKeys.store);
  }

  it('refuses when a newer AUTH buyers would refuse replaces the signed one', async () => {
    const ownerKeys = owner();
    const signed = ownerKeys.auth(T0);
    const expiredNewer = ownerKeys.auth(T0 + 10, 'hosted', T0 + 20);
    const history = await historyOf(ownerKeys, [signed, expiredNewer]);
    expect(
      refusalOf(() => supersedingAuthRefusal(signed, history, ownerKeys.store, T0 + 30))?.reason,
    ).toBe('owner-resign');
  });

  it('counts an expired AUTH right at the edge of the skew window', async () => {
    const ownerKeys = owner();
    const signed = ownerKeys.auth(T0);
    const now = T0 + 30;
    const history = await historyOf(ownerKeys, [
      signed,
      ownerKeys.auth(now + MAX_FUTURE_SKEW_SECS, 'hosted', now - 1),
    ]);
    expect(
      refusalOf(() => supersedingAuthRefusal(signed, history, ownerKeys.store, now))?.reason,
    ).toBe('owner-resign');
  });

  it('passes the signed AUTH itself, an older one, a newer active one, and one past the skew window', async () => {
    const ownerKeys = owner();
    const signed = ownerKeys.auth(T0);
    const now = T0 + 30;
    for (const events of [
      [signed],
      [signed, ownerKeys.auth(T0 - 10, 'hosted', T0 - 5)],
      [signed, ownerKeys.auth(T0 + 10)],
      // Past the skew window buyers do not count it, expired or not.
      [signed, ownerKeys.auth(now + MAX_FUTURE_SKEW_SECS + 1, 'hosted', now - 1)],
      [],
    ]) {
      const history = await historyOf(ownerKeys, events);
      expect(() => supersedingAuthRefusal(signed, history, ownerKeys.store, now)).not.toThrow();
    }
  });
});

describe('a newer AUTH on the relays, edge cases', () => {
  it('a newer malformed AUTH is refused too', () => {
    const ownerKeys = owner();
    const signed = ownerKeys.auth(T0);
    const malformed = finalizeEvent(
      {
        kind: KIND_STORE_AUTH,
        created_at: T0 + 10,
        tags: [
          ['d', ownerKeys.store],
          ['mode', 'hosted'],
          ['mode', 'self-host'],
        ],
        content: '',
      },
      ownerKeys.secret,
    );
    expect(
      refusalOf(() =>
        supersedingAuthRefusal(
          signed,
          { auths: [signed, malformed], deletions: [] },
          ownerKeys.store,
          T0 + 30,
        ),
      )?.reason,
    ).toBe('owner-resign');
  });

  it('a same-second AUTH wins only with a lower id, as relays keep it', () => {
    const ownerKeys = owner();
    const signed = ownerKeys.auth(T0);
    const expired = JSON.parse(JSON.stringify(ownerKeys.auth(T0, 'hosted', T0 + 1))) as NostrEvent;
    const lower = { ...expired, id: '0'.repeat(64) };
    const higher = { ...expired, id: 'f'.repeat(64) };
    const history = (event: NostrEvent) => ({ auths: [signed, event], deletions: [] });
    expect(
      refusalOf(() => supersedingAuthRefusal(signed, history(lower), ownerKeys.store, T0 + 30))
        ?.reason,
    ).toBe('owner-resign');
    expect(() =>
      supersedingAuthRefusal(signed, history(higher), ownerKeys.store, T0 + 30),
    ).not.toThrow();
  });

  it("another store's AUTH, or one naming this store second, never supersedes", async () => {
    const ownerKeys = owner();
    const signed = ownerKeys.auth(T0);
    const otherStore = getPublicKey(generateSecretKey());
    const otherStoreAuth = finalizeEvent(
      buildStoreAuthEvent({
        storePubkey: otherStore,
        mode: 'hosted',
        createdAt: T0 + 10,
        expiresAt: T0 + 11,
      }),
      ownerKeys.secret,
    );
    const secondD = finalizeEvent(
      {
        kind: KIND_STORE_AUTH,
        created_at: T0 + 10,
        tags: [
          ['d', otherStore],
          ['d', ownerKeys.store],
          ['p', ownerKeys.store],
          ['mode', 'hosted'],
        ],
        content: '',
      },
      ownerKeys.secret,
    );
    // Another kind whose first `d` names this store: no AUTH at all.
    const otherKind = finalizeEvent(
      {
        kind: 30491,
        created_at: T0 + 10,
        tags: [
          ['d', ownerKeys.store],
          ['p', ownerKeys.store],
          ['mode', 'hosted'],
        ],
        content: '',
      },
      ownerKeys.secret,
    );
    const history = await readStoreAuthHistory(
      carelessPoolOf([signed, otherStoreAuth, secondD, otherKind]),
      ['r'],
      ownerKeys.pubkey,
      ownerKeys.store,
    );
    expect(history.auths.map((event) => event.id)).toEqual([signed.id]);
    expect(() => supersedingAuthRefusal(signed, history, ownerKeys.store, T0 + 30)).not.toThrow();
  });
});

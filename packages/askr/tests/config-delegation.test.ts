import { KIND_DELETION, MAX_FUTURE_SKEW_SECS } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_D_TAG,
  KIND_CONFIG,
  KIND_CONFIG_DELEGATION,
  MAX_CONFIG_DELEGATES,
} from '../src/constants';
import { buildConfigEvent, decryptPrivateConfig, parseConfig } from '../src/events/config';
import {
  buildConfigDelegation,
  buildConfigDelegationRevocation,
  configAddress,
  configCandidates,
  delegateConfigFilters,
  readConfigDelegates,
  storeConfigFilters,
} from '../src/events/config-delegation';
import { NOW, type TestKey, sign, testKey } from './fixtures';
import { randomEventSet, seededRandom } from './shared/config-event-sets';

const owner = testKey();
const assistant = testKey();
const catalog = testKey();

function configBy(signer: TestKey, createdAt: number, name = 'Example Shop'): NostrEvent {
  return sign(
    buildConfigEvent(
      {
        assistant: assistant.pubkey,
        origins: ['https://shop.example.com'],
        name,
        language: 'en',
        currency: 'USD',
        source: { kind: 'catalog' },
        catalogKey: catalog.pubkey,
        private: { voice: 'calm', instructions: name, notes: '' },
        createdAt,
      },
      signer.secretKey,
    ),
    signer,
  );
}

function grant(delegate: TestKey, createdAt: number): NostrEvent {
  return sign(buildConfigDelegation({ key: delegate.pubkey, createdAt }), owner);
}

function deletion(by: TestKey, address: string, createdAt: number): NostrEvent {
  return sign(
    { kind: KIND_DELETION, created_at: createdAt, tags: [['a', address]], content: '' },
    by,
  );
}

function names(events: readonly NostrEvent[]): (string | undefined)[] {
  return configCandidates(events, owner.pubkey, { now: NOW }).map(
    (candidate) => candidate.config?.name,
  );
}

describe('config delegation (30498)', () => {
  it("the shared generator's sets hold events that fail a fresh signature check", () => {
    const random = seededRandom(2);
    let failing = 0;
    for (let round = 0; round < 40; round += 1) {
      const events = randomEventSet(random, {
        owner,
        now: NOW,
        input: {
          assistant: assistant.pubkey,
          origins: ['https://shop.example.com'],
          name: 'x',
          language: 'en',
          currency: 'USD',
          source: { kind: 'catalog' },
          catalogKey: catalog.pubkey,
        },
      });
      failing += events.filter((event) => !verifyEvent(event)).length;
    }
    expect(failing).toBeGreaterThan(0);
  });

  it('ignores a self-grant and a grant whose d is not a hex key', () => {
    const selfGrant = sign(
      { ...buildConfigDelegation({ key: owner.pubkey, createdAt: NOW - 5 }) },
      owner,
    );
    const badD = sign(
      {
        kind: KIND_CONFIG_DELEGATION,
        created_at: NOW - 5,
        tags: [
          ['d', 'NOT-HEX'],
          ['p', 'NOT-HEX'],
          ['mode', 'hosted'],
        ],
        content: '',
      },
      owner,
    );
    expect(readConfigDelegates([selfGrant, badD], owner.pubkey, NOW)).toEqual([]);
  });

  it('at the cap, grants of the same second go to the lower keys', () => {
    const delegates = Array.from({ length: MAX_CONFIG_DELEGATES + 1 }, () => testKey()).sort(
      (left, right) => (left.pubkey < right.pubkey ? -1 : 1),
    );
    const events = delegates.map((delegate) => grant(delegate, NOW - 10));
    expect(readConfigDelegates(events, owner.pubkey, NOW)).toEqual(
      delegates.slice(0, MAX_CONFIG_DELEGATES).map((delegate) => delegate.pubkey),
    );
  });

  it('a config dated exactly at the skew limit is a candidate, one second later is not', () => {
    const at = configBy(owner, NOW + MAX_FUTURE_SKEW_SECS, 'at');
    const past = configBy(owner, NOW + MAX_FUTURE_SKEW_SECS + 1, 'past');
    expect(names([past, at])).toEqual(['at']);
  });

  it('the owner wins a same-second tie whichever side of the comparison it is on', () => {
    const delegate = testKey();
    const ownerConfig = configBy(owner, NOW - 10, 'owner');
    const delegateConfig = configBy(delegate, NOW - 10, 'delegate');
    const base = [grant(delegate, NOW - 100)];
    expect(names([...base, ownerConfig, delegateConfig])).toEqual(['owner', 'delegate']);
    expect(names([...base, delegateConfig, ownerConfig])).toEqual(['owner', 'delegate']);
  });

  it('the same event twice is one candidate', () => {
    const config = configBy(owner, NOW - 10, 'once');
    expect(names([config, { ...config }])).toEqual(['once']);
  });

  it('builds a hosted grant and a revocation on the delegation kind', () => {
    const delegate = testKey();
    const template = buildConfigDelegation({ key: delegate.pubkey, createdAt: NOW });
    expect(template.kind).toBe(KIND_CONFIG_DELEGATION);
    expect(template.tags).toEqual([
      ['d', delegate.pubkey],
      ['p', delegate.pubkey],
      ['mode', 'hosted'],
    ]);
    const revocation = buildConfigDelegationRevocation(delegate.pubkey, NOW);
    expect(revocation.kind).toBe(KIND_CONFIG_DELEGATION);
    expect(revocation.tags).toContainEqual(['mode', 'revoked']);
  });

  it('reads active delegates only: revoked (same second), deleted, expired and foreign grants drop', () => {
    const active = testKey();
    const revoked = testKey();
    const deleted = testKey();
    const expired = testKey();
    const foreign = testKey();
    const events = [
      grant(active, NOW - 50),
      grant(revoked, NOW - 50),
      sign(buildConfigDelegationRevocation(revoked.pubkey, NOW - 50), owner),
      grant(deleted, NOW - 50),
      deletion(owner, `${KIND_CONFIG_DELEGATION}:${owner.pubkey}:${deleted.pubkey}`, NOW - 40),
      sign(
        buildConfigDelegation({ key: expired.pubkey, createdAt: NOW - 50, expiresAt: NOW - 1 }),
        owner,
      ),
      sign(buildConfigDelegation({ key: foreign.pubkey, createdAt: NOW - 50 }), testKey()),
    ];
    expect(readConfigDelegates(events, owner.pubkey, NOW)).toEqual([active.pubkey]);
  });

  it('a catalog-key grant (30497) for a key is not a config delegation', () => {
    const delegate = testKey();
    const catalogGrant = sign(
      { ...buildConfigDelegation({ key: delegate.pubkey, createdAt: NOW - 5 }), kind: 30497 },
      owner,
    );
    expect(readConfigDelegates([catalogGrant], owner.pubkey, NOW)).toEqual([]);
    expect(names([catalogGrant, configBy(delegate, NOW - 1)])).toEqual([]);
  });

  it('caps the delegates at the newest MAX_CONFIG_DELEGATES grants', () => {
    const delegates = Array.from({ length: MAX_CONFIG_DELEGATES + 2 }, () => testKey());
    const events = delegates.map((delegate, index) => grant(delegate, NOW - 100 + index));
    const read = readConfigDelegates(events, owner.pubkey, NOW);
    expect(read).toEqual(
      delegates
        .slice(-MAX_CONFIG_DELEGATES)
        .reverse()
        .map((delegate) => delegate.pubkey),
    );
    // A config of a delegate past the cap is not a candidate.
    const dropped = delegates[0];
    if (dropped === undefined) {
      throw new Error('no delegate');
    }
    expect(names([...events, configBy(dropped, NOW - 1, 'capped')])).toEqual([]);
  });

  it('without a delegate the candidates are the owner configs, newest first, ties by lowest id', () => {
    const first = configBy(owner, NOW - 10, 'a');
    const second = configBy(owner, NOW - 10, 'b');
    const older = configBy(owner, NOW - 20, 'older');
    const candidates = configCandidates([older, first, second], owner.pubkey, { now: NOW });
    const [low, high] = first.id < second.id ? [first, second] : [second, first];
    expect(candidates.map((candidate) => candidate.event.id)).toEqual([low.id, high.id, older.id]);
  });

  it('drops forged, too-far-future, foreign and non-askr events', () => {
    const genuine = configBy(owner, NOW - 10, 'genuine');
    const forged = { ...configBy(owner, NOW - 5, 'forged'), sig: genuine.sig };
    const future = configBy(owner, NOW + MAX_FUTURE_SKEW_SECS + 1, 'future');
    const foreign = configBy(testKey(), NOW - 1, 'foreign');
    const otherD = sign(
      {
        ...configBy(owner, NOW - 1, 'other-d'),
        tags: [['d', 'not-askr']],
      },
      owner,
    );
    expect(names([genuine, forged, future, foreign, otherD])).toEqual(['genuine']);
    // The reader's own skew limit and predicate apply.
    expect(
      configCandidates([genuine, future], owner.pubkey, {
        now: NOW,
        maxAheadSecs: MAX_FUTURE_SKEW_SECS + 10,
      }).map((candidate) => candidate.config?.name),
    ).toEqual(['future', 'genuine']);
    expect(configCandidates([genuine], owner.pubkey, { now: NOW, isGenuine: () => false })).toEqual(
      [],
    );
  });

  it('merges an active delegate: O first on a tie, then delegates by key; owner and signer set', () => {
    const left = testKey();
    const right = testKey();
    const [low, high] = left.pubkey < right.pubkey ? [left, right] : [right, left];
    const events = [
      grant(low, NOW - 100),
      grant(high, NOW - 100),
      configBy(high, NOW - 10, 'high'),
      configBy(low, NOW - 10, 'low'),
      configBy(owner, NOW - 10, 'owner'),
      configBy(high, NOW - 5, 'newest'),
    ];
    const candidates = configCandidates(events, owner.pubkey, { now: NOW });
    expect(candidates.map((candidate) => candidate.config?.name)).toEqual([
      'newest',
      'owner',
      'low',
      'high',
    ]);
    const newest = candidates[0]?.config;
    expect(newest?.owner).toBe(owner.pubkey);
    expect(newest?.signer).toBe(high.pubkey);
  });

  it('a revoked delegate is no candidate, a same-second revocation included', () => {
    const delegate = testKey();
    const events = [
      grant(delegate, NOW - 100),
      sign(buildConfigDelegationRevocation(delegate.pubkey, NOW - 100), owner),
      configBy(delegate, NOW - 10, 'delegate'),
      configBy(owner, NOW - 50, 'owner'),
    ];
    expect(names(events)).toEqual(['owner']);
  });

  it("a delegate's config deleted by the delegate or by O is dropped; a D deletion never touches O's", () => {
    const delegate = testKey();
    const base = [grant(delegate, NOW - 100), configBy(delegate, NOW - 10, 'delegate')];
    const ownerConfig = configBy(owner, NOW - 50, 'owner');
    for (const by of [delegate, owner]) {
      expect(
        names([...base, ownerConfig, deletion(by, configAddress(delegate.pubkey), NOW - 10)]),
      ).toEqual(['owner']);
    }
    // An older deletion does not drop a newer config.
    expect(names([...base, deletion(delegate, configAddress(delegate.pubkey), NOW - 11)])).toEqual([
      'delegate',
    ]);
    // D cannot delete O's config: O's deletions are left to the reader, and D's are ignored there.
    const candidates = configCandidates(
      [...base, ownerConfig, deletion(delegate, configAddress(owner.pubkey), NOW)],
      owner.pubkey,
      { now: NOW },
    );
    expect(candidates.map((candidate) => candidate.config?.name)).toEqual(['delegate', 'owner']);
  });

  it('an unparseable candidate comes back with no config', () => {
    const broken = sign(
      { kind: KIND_CONFIG, created_at: NOW - 1, tags: [['d', CONFIG_D_TAG]], content: '' },
      owner,
    );
    const candidates = configCandidates([broken, configBy(owner, NOW - 9)], owner.pubkey, {
      now: NOW,
    });
    expect(candidates.map((candidate) => candidate.config === undefined)).toEqual([true, false]);
  });

  it('parseConfig without options keeps owner = signer = author', () => {
    const event = configBy(owner, NOW - 1);
    const config = parseConfig(event);
    expect(config?.owner).toBe(owner.pubkey);
    expect(config?.signer).toBe(owner.pubkey);
  });

  it("decrypts a delegate's private part from the signer, and an {owner, privateContent} pair as before", () => {
    const delegate = testKey();
    const config = parseConfig(configBy(delegate, NOW - 1, 'by-delegate'), { owner: owner.pubkey });
    if (config === undefined) {
      throw new Error('no config');
    }
    expect(decryptPrivateConfig(config, assistant.secretKey)?.instructions).toBe('by-delegate');
    const ownerConfig = parseConfig(configBy(owner, NOW - 1, 'by-owner'));
    if (ownerConfig === undefined) {
      throw new Error('no config');
    }
    expect(
      decryptPrivateConfig(
        { owner: ownerConfig.owner, privateContent: ownerConfig.privateContent },
        assistant.secretKey,
      )?.instructions,
    ).toBe('by-owner');
  });

  it('filters: owner configs + delegations + deletions; delegates only when there are some', () => {
    expect(storeConfigFilters(owner.pubkey)).toEqual([
      { kinds: [KIND_CONFIG], authors: [owner.pubkey], '#d': [CONFIG_D_TAG] },
      { kinds: [KIND_CONFIG_DELEGATION, KIND_DELETION], authors: [owner.pubkey] },
    ]);
    expect(delegateConfigFilters([])).toEqual([]);
    const delegate = testKey();
    expect(delegateConfigFilters([delegate.pubkey])).toEqual([
      { kinds: [KIND_CONFIG], authors: [delegate.pubkey], '#d': [CONFIG_D_TAG] },
      {
        kinds: [KIND_DELETION],
        authors: [delegate.pubkey],
        '#a': [configAddress(delegate.pubkey)],
      },
    ]);
  });
});

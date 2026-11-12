import {
  type CatalogItemInput,
  KIND_POLICY,
  buildCatalogAuth,
  buildCatalogItemEvent,
  buildPolicyEvent,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { SignedJournal } from '../src/lib/journal';
import { nextAuthDate } from '../src/lib/save';
import { newestByD, readAuthority, readListings, readPolicies } from '../src/lib/store-data';
import { NOW, OWNER, OWNER_KEY, SERVER_KEY, SERVER_KEY_SECRET, fakeReader, listing } from './fakes';

const KIND_DELETION = 5;

/**
 * An event as a relay delivers it: plain JSON. nostr-tools marks the events it
 * signs as verified, and a copy would carry that mark past `verifyEvent`.
 */
function asReceived(event: NostrEvent): NostrEvent {
  return JSON.parse(JSON.stringify(event));
}

/** The same event with a signature that no longer matches its content. */
function forged(event: NostrEvent, title: string): NostrEvent {
  return asReceived({
    ...event,
    tags: event.tags.map((tag) => (tag[0] === 'title' ? ['title', title] : tag)),
  });
}

function policy(slug: string, title: string, createdAt: number): NostrEvent {
  return finalizeEvent(
    { ...buildPolicyEvent({ slug, title, body: `${title} body` }), created_at: createdAt },
    SERVER_KEY_SECRET,
  );
}

function deletion(slug: string, createdAt: number, secretKey = SERVER_KEY_SECRET): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_DELETION,
      created_at: createdAt,
      tags: [['a', `${KIND_POLICY}:${getPublicKey(secretKey)}:${slug}`]],
      content: '',
    },
    secretKey,
  );
}

const ITEM: CatalogItemInput = { d: 'mug', title: 'Mug', price: { amount: '5', currency: 'USD' } };

describe('newestByD', () => {
  it('keeps the newest per d, the lower id at the same second', () => {
    const older = listing({ ...ITEM, title: 'Old' }, NOW - 20);
    const newer = listing({ ...ITEM, title: 'New' }, NOW - 10);
    expect(newestByD([newer, older], 30402, SERVER_KEY, NOW)).toEqual([newer]);
    expect(newestByD([older, newer], 30402, SERVER_KEY, NOW)).toEqual([newer]);
    const twin = listing({ ...ITEM, title: 'Twin' }, NOW - 10);
    const lower = twin.id < newer.id ? twin : newer;
    expect(newestByD([newer, twin], 30402, SERVER_KEY, NOW)).toEqual([lower]);
    expect(newestByD([twin, newer], 30402, SERVER_KEY, NOW)).toEqual([lower]);
  });

  it('drops an event whose signature does not match, even when it is the newest', () => {
    const real = listing(ITEM, NOW - 20);
    const fake = forged(listing({ ...ITEM, title: 'Fake' }, NOW - 5), 'Forged');
    expect(newestByD([real, fake], 30402, SERVER_KEY, NOW)).toEqual([real]);
  });

  it('drops an event dated far in the future, so it cannot shadow the real newest', () => {
    const real = listing(ITEM, NOW - 20);
    const ahead = listing({ ...ITEM, title: 'Ahead' }, NOW + 60 * 60);
    const skewed = listing({ ...ITEM, title: 'Skewed' }, NOW + 60);
    expect(newestByD([real, ahead], 30402, SERVER_KEY, NOW)).toEqual([real]);
    expect(newestByD([real, skewed], 30402, SERVER_KEY, NOW)).toEqual([skewed]);
  });
});

describe('readListings', () => {
  it('reads the newest version of each product', async () => {
    const reader = fakeReader([
      listing({ ...ITEM, title: 'Old mug' }, NOW - 20),
      listing({ ...ITEM, title: 'New mug' }, NOW - 10),
    ]);
    const items = await readListings(reader, SERVER_KEY, NOW);
    expect(items.map((item) => item.title)).toEqual(['New mug']);
  });

  it('keeps a hidden product, marked hidden, rebuilding the same listing', async () => {
    const hidden = listing({ ...ITEM, visibility: 'hidden' }, NOW - 10);
    const [item] = await readListings(fakeReader([hidden]), SERVER_KEY, NOW);
    expect(item?.visibility).toBe('hidden');
    expect(item === undefined ? undefined : buildCatalogItemEvent(item).tags).toEqual(hidden.tags);
  });
});

describe('readPolicies', () => {
  it('leaves out a policy deleted at or after it, keeps one republished after its deletion', async () => {
    const policies = await readPolicies(
      fakeReader([
        policy('returns', 'Returns', NOW - 30),
        deletion('returns', NOW - 30),
        policy('shipping', 'Shipping', NOW - 10),
        deletion('shipping', NOW - 11),
        policy('sizes', 'Sizes', NOW - 10),
      ]),
      SERVER_KEY,
      NOW,
    );
    expect(policies.map((entry) => entry.slug)).toEqual(['shipping', 'sizes']);
  });

  it('ignores a deletion with a bad signature', async () => {
    const real = deletion('returns', NOW - 5);
    const tampered = asReceived({ ...real, created_at: NOW - 4 });
    const policies = await readPolicies(
      fakeReader([policy('returns', 'Returns', NOW - 30), tampered]),
      SERVER_KEY,
      NOW,
    );
    expect(policies.map((entry) => entry.slug)).toEqual(['returns']);
  });
});

describe('readAuthority', () => {
  it('counts only authorizations whose signature checks out', async () => {
    const merchant = getPublicKey(generateSecretKey());
    const real = finalizeEvent(
      { ...buildCatalogAuth({ key: SERVER_KEY, mode: 'hosted' }), created_at: NOW - 10 },
      OWNER_KEY,
    );
    const template = finalizeEvent(
      { ...buildCatalogAuth({ key: SERVER_KEY, mode: 'hosted' }), created_at: NOW - 9 },
      OWNER_KEY,
    );
    // The signature of another authorization on a merchant key's tags: forged.
    const fake = asReceived({
      ...template,
      tags: template.tags.map((tag) => (tag[1] === SERVER_KEY ? [tag[0] ?? '', merchant] : tag)),
    });
    const authority = await readAuthority(fakeReader([real, fake]), OWNER, NOW);
    expect([...authority.keys.keys()]).toEqual([SERVER_KEY]);
    expect(authority.newestAt.get(SERVER_KEY)).toBe(NOW - 10);
    expect(authority.newestAt.has(merchant)).toBe(false);
  });
});

describe('nextAuthDate', () => {
  it('dates a new 30497 after the newest for that key, on the relay or signed this session', () => {
    const journal = new SignedJournal();
    expect(nextAuthDate(SERVER_KEY, NOW, undefined, journal)).toBe(NOW);
    expect(nextAuthDate(SERVER_KEY, NOW, new Map([[SERVER_KEY, NOW + 40]]), journal)).toBe(
      NOW + 41,
    );
    journal.note([
      finalizeEvent(
        { ...buildCatalogAuth({ key: SERVER_KEY, mode: 'hosted' }), created_at: NOW + 90 },
        OWNER_KEY,
      ),
    ]);
    expect(nextAuthDate(SERVER_KEY, NOW, new Map([[SERVER_KEY, NOW + 40]]), journal)).toBe(
      NOW + 91,
    );
  });
});

// cspell:ignore EtWTRABZaYq6iMfeYKouRu166VU2xqa1 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
import { type CatalogItemInput, buildCatalogAuth } from '@elisym/askr';
import { KIND_DELETION, buildProductEvent, buildStoreAuthEvent } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import { Overview } from '../src/components/Overview';
import { countListed, readAuthority } from '../src/lib/store-data';
import {
  NOW,
  OWNER,
  OWNER_KEY,
  SERVER_KEY,
  SERVER_KEY_SECRET,
  adminConfig,
  fakeReader,
  listing,
  overviewProps,
  storeView,
} from './fakes';
import { type Mounted, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const CATALOG_AUTH = finalizeEvent(
  buildCatalogAuth({ key: SERVER_KEY, mode: 'hosted', createdAt: NOW - 100 }),
  OWNER_KEY,
);
const STORE_AUTH = finalizeEvent(
  { ...buildStoreAuthEvent({ storePubkey: SERVER_KEY, mode: 'self-host' }), created_at: NOW - 100 },
  OWNER_KEY,
);

function products(count: number, extra: Partial<CatalogItemInput> = {}, prefix = 'p') {
  return Array.from({ length: count }, (_value, index) =>
    listing({
      d: `${prefix}-${index}`,
      title: `Product ${index}`,
      price: { amount: '1', currency: 'USD' },
      ...extra,
    }),
  );
}

async function overview(
  events: readonly NostrEvent[],
  maxProducts: number,
  config = adminConfig({ source: { kind: 'catalog' } }),
) {
  const view = storeView();
  const tier = view.tier === null ? null : { ...view.tier, maxProducts };
  mounted = await mount(
    <Overview
      {...overviewProps()}
      view={{ ...view, tier }}
      config={config}
      configFromServer={false}
      catalogReader={{ reader: fakeReader(events), now: () => NOW }}
    />,
  );
  return mounted.container;
}

describe('the budget meter', () => {
  it('names this budget period, not the calendar month', async () => {
    const container = await overview([], 3);
    const meter = container.querySelector('[aria-label="This budget period"]');
    expect(meter).not.toBeNull();
    expect(container.textContent).not.toContain('This month');
  });
});

describe('the catalog size against the plan', () => {
  it('says how many products the assistant leaves out when the catalog is over the plan', async () => {
    const container = await overview([CATALOG_AUTH, ...products(5)], 3);
    await settle(() => (container.textContent ?? '').includes('indexes up to'));
    expect(container.textContent).toContain(
      'Your catalog has 5 products and your plan indexes up to 3, so the assistant does not see the last 2 by product ID (in character order).',
    );
  });

  it('says nothing at or under the plan, and nothing for a key the owner does not authorize', async () => {
    for (const events of [[CATALOG_AUTH, ...products(3)], products(5)]) {
      const container = await overview(events, 3);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(container.textContent).not.toContain('indexes up to');
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('counts only what shoppers see in the store currency: no hidden, deleted or other-currency products', async () => {
    const deletion = finalizeEvent(
      {
        kind: KIND_DELETION,
        created_at: NOW - 10,
        tags: [['a', `30402:${SERVER_KEY}:p-1`]],
        content: '',
      },
      SERVER_KEY_SECRET,
    );
    const reader = fakeReader([
      ...products(3),
      ...products(2, { visibility: 'hidden' }, 'h'),
      ...products(2, { price: { amount: '1', currency: 'EUR' } }, 'e'),
      deletion,
    ]);
    expect(await countListed(reader, SERVER_KEY, 'USD', NOW)).toBe(2);
    expect(await countListed(reader, SERVER_KEY, 'EUR', NOW)).toBe(2);
  });

  it('leaves out listings with payment terms, as the assistant does', async () => {
    const paid = Array.from({ length: 4 }, (_value, index) =>
      finalizeEvent(
        buildProductEvent({
          d: `pc-${index}`,
          title: 'P',
          description: '',
          price: { amount: '5', currency: 'USD' },
          accept: [
            'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
          ],
          createdAt: NOW - 1,
        }),
        SERVER_KEY_SECRET,
      ),
    );
    const container = await overview([CATALOG_AUTH, ...paid, ...products(3)], 2);
    await settle(() => (container.textContent ?? '').includes('indexes up to'));
    expect(container.textContent).toContain('Your catalog has 3 products');
    expect(await countListed(fakeReader(paid), SERVER_KEY, 'USD', NOW)).toBe(0);
  });

  it('counts as the server does: the newest version per product, unexpired, future deletions ignored', async () => {
    const older = listing(
      { d: 'p-0', title: 'Old', price: { amount: '1', currency: 'EUR' } },
      NOW - 500,
    );
    const expired = finalizeEvent(
      {
        ...listing({ d: 'gone', title: 'Gone', price: { amount: '1', currency: 'USD' } }),
        tags: [
          ...listing({ d: 'gone', title: 'Gone', price: { amount: '1', currency: 'USD' } }).tags,
          ['expiration', String(NOW - 1)],
        ],
        created_at: NOW - 50,
      },
      SERVER_KEY_SECRET,
    );
    const futureDeletion = finalizeEvent(
      {
        kind: KIND_DELETION,
        created_at: NOW + 3600,
        tags: [['a', `30402:${SERVER_KEY}:p-1`]],
        content: '',
      },
      SERVER_KEY_SECRET,
    );
    const reader = fakeReader([older, ...products(2), expired, futureDeletion]);
    expect(await countListed(reader, SERVER_KEY, 'USD', NOW)).toBe(2);
    expect(await countListed(reader, SERVER_KEY, 'EUR', NOW)).toBe(0);
  });

  it('reads authority as 30497 and kind 5 only, never a 30490', async () => {
    const asked: number[] = [];
    const reader = fakeReader([STORE_AUTH, CATALOG_AUTH]);
    const authority = await readAuthority(
      {
        query: async (filter) => {
          asked.push(...(filter.kinds ?? []));
          return reader.query(filter);
        },
      },
      OWNER,
      NOW,
    );
    expect(asked.sort((left, right) => left - right)).toEqual([5, 30497]);
    expect(authority.keys).toEqual(new Set([SERVER_KEY]));
  });

  it('says nothing when the owner authorized the key only with a 30490', async () => {
    const container = await overview([STORE_AUTH, ...products(5)], 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).not.toContain('indexes up to');
  });
});

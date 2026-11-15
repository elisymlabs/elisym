import type { CatalogItemInput } from '@elisym/askr';
import { afterEach, describe, expect, it } from 'vitest';
import { Overview } from '../src/components/Overview';
import { countListed } from '../src/lib/store-data';
import { NOW, SERVER_KEY, adminConfig, fakeReader, listing, storeView } from './fakes';
import { type Mounted, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function products(count: number, visibility?: CatalogItemInput['visibility']) {
  return Array.from({ length: count }, (_value, index) =>
    listing({
      d: `p-${index}`,
      title: `Product ${index}`,
      price: { amount: '1', currency: 'USD' },
      ...(visibility === undefined ? {} : { visibility }),
    }),
  );
}

async function overview(count: number, maxProducts: number) {
  const view = storeView();
  const tier = view.tier === null ? null : { ...view.tier, maxProducts };
  mounted = await mount(
    <Overview
      view={{ ...view, tier }}
      config={adminConfig({ source: { kind: 'catalog' } })}
      configFromServer={false}
      catalogReader={{ reader: fakeReader(products(count)), now: () => NOW }}
    />,
  );
  return mounted.container;
}

describe('the catalog size against the plan', () => {
  it('says how many products the assistant leaves out when the catalog is over the plan', async () => {
    const container = await overview(5, 3);
    await settle(() => (container.textContent ?? '').includes('indexes up to'));
    expect(container.textContent).toContain(
      'Your catalog has 5 products and your plan indexes up to 3, so the assistant does not see the last 2 by product ID.',
    );
  });

  it('says nothing at or under the plan', async () => {
    const container = await overview(3, 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).not.toContain('indexes up to');
  });

  it('counts only what shoppers see: no hidden products', async () => {
    const reader = fakeReader([...products(2), ...products(3, 'hidden').slice(2)]);
    expect(await countListed(reader, SERVER_KEY, 'catalog', NOW)).toBe(2);
  });
});

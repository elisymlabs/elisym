import type { CatalogItemInput } from '@elisym/askr';
import { type ReactNode, act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorStatus } from '../src/components/ConnectorStatus';
import { FieldGroup } from '../src/components/FieldGroup';
import { ProductList } from '../src/components/ProductList';
import { ProductThumb } from '../src/components/ProductThumb';
import { RefreshState } from '../src/components/RefreshState';
import { Section } from '../src/components/Section';
import { SyncStatus } from '../src/components/SyncStatus';
import { HELP } from '../src/lib/help';
import type { ConnectorRecord } from '../src/lib/types';
import { OWNER } from './fakes';
import { type Mounted, mount } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function render(node: ReactNode): Promise<HTMLElement> {
  mounted = await mount(<div>{node}</div>);
  return mounted.container;
}

const CHECK_PATH = 'm3.5 8.5 3 3 6-7';
const CROSS_PATH = 'm4.5 4.5 7 7m0-7-7 7';

describe('the Refresh state beside the button', () => {
  it('is nothing while idle, a spinner while busy, then a green check or a red cross', async () => {
    const idle = await render(<RefreshState status="idle" />);
    expect(idle.querySelector('svg')).toBeNull();
    await mounted?.unmount();

    const busy = await render(<RefreshState status="busy" />);
    expect(busy.querySelector('svg.animate-spin')).not.toBeNull();
    expect(busy.querySelector('svg.text-error, svg.text-green')).toBeNull();
    await mounted?.unmount();

    const done = await render(<RefreshState status="done" />);
    expect(done.querySelector('svg.text-green path')?.getAttribute('d')).toBe(CHECK_PATH);
    expect(done.querySelector('svg.animate-spin')).toBeNull();
    await mounted?.unmount();

    const failed = await render(<RefreshState status="failed" />);
    expect(failed.querySelector('svg.text-error path')?.getAttribute('d')).toBe(CROSS_PATH);
    // Drawn only: the live region says it in words.
    expect(failed.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the product list badges', () => {
  const item = (overrides: Partial<CatalogItemInput>): CatalogItemInput => ({
    d: 'mug',
    title: 'Mug',
    price: { amount: '12.50', currency: 'USD' },
    ...overrides,
  });

  it('reads a product with no availability as on sale, and names each in words', async () => {
    const container = await render(
      <ProductList
        items={[
          item({ d: 'plain' }),
          item({ d: 'early', visibility: 'pre-order' }),
          item({ d: 'gone', visibility: 'sold-out' }),
          item({ d: 'kept', visibility: 'hidden' }),
        ]}
        onEdit={() => undefined}
        onRemove={() => undefined}
      />,
    );
    const badges = [...container.querySelectorAll('.badge')].map((badge) => ({
      text: badge.textContent,
      green: badge.classList.contains('badge-green'),
      warn: badge.classList.contains('badge-warn'),
    }));
    expect(badges).toEqual([
      { text: 'on sale', green: true, warn: false },
      { text: 'pre order', green: false, warn: true },
      { text: 'sold out', green: false, warn: false },
      { text: 'hidden', green: false, warn: false },
    ]);
  });
});

describe('the product thumbnail', () => {
  it('falls back to a placeholder when the image fails, and tries a new address again', async () => {
    mounted = await mount(<ProductThumb src="https://cdn.example/broken.jpg" />);
    const { container } = mounted;
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://cdn.example/broken.jpg');
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');
    await act(async () => {
      image?.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    await mounted.rerender(<ProductThumb src="https://cdn.example/fixed.jpg" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.example/fixed.jpg',
    );
  });

  it('shows the placeholder for a product with no image', async () => {
    const container = await render(<ProductThumb src={undefined} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('section and group titles', () => {
  it("puts a section's info button beside its title", async () => {
    const container = await render(
      <Section title="Status" info={HELP.status}>
        <p>body</p>
      </Section>,
    );
    expect(container.querySelector('h2')?.textContent).toBe('Status');
    expect(container.querySelector('button[aria-label="About Status"]')).not.toBeNull();
  });

  it('names a group of fields by its title, with its description and info button', async () => {
    const container = await render(
      <FieldGroup
        id="group-private"
        title="Private instructions"
        description="Encrypted to your assistant."
        info={HELP.privateInstructions}
      >
        <p>fields</p>
      </FieldGroup>,
    );
    const group = container.querySelector('fieldset');
    const labelledBy = group?.getAttribute('aria-labelledby') ?? '';
    expect(container.querySelector(`#${labelledBy}`)?.textContent).toBe('Private instructions');
    expect(container.textContent).toContain('Encrypted to your assistant.');
    expect(
      container.querySelector('button[aria-label="About Private instructions"]'),
    ).not.toBeNull();
  });
});

describe('the sync and connector rows', () => {
  it('puts each count of the last sync beside its own word', async () => {
    const container = await render(
      <SyncStatus
        sync={{
          state: 'done',
          diff: {
            created: ['a'],
            updated: ['b', 'c'],
            hidden: ['d', 'e', 'f'],
            unchanged: ['g', 'h', 'i', 'j'],
          },
        }}
      />,
    );
    expect(container.textContent).toContain('1 new');
    expect(container.textContent).toContain('2 updated');
    expect(container.textContent).toContain('3 removed');
    expect(container.textContent).toContain('4 unchanged');
  });

  it('says whether the connector syncs', async () => {
    const connector = (enabled: boolean): ConnectorRecord => ({
      owner: OWNER,
      platform: 'shopify',
      url: 'https://shop.example',
      importPolicies: false,
      enabled,
      lastRunAt: null,
      nextRunAt: null,
      lastStatus: null,
    });
    const syncing = (container: HTMLElement) =>
      [...container.querySelectorAll('.kv > div')]
        .find((row) => row.querySelector('dt')?.textContent === 'Syncing')
        ?.querySelector('dd')?.textContent;
    const on = await render(<ConnectorStatus connector={connector(true)} />);
    expect(syncing(on)).toBe('On');
    await mounted?.unmount();
    const off = await render(<ConnectorStatus connector={connector(false)} />);
    expect(syncing(off)).toBe('Off (preview it, then turn it on)');
  });
});

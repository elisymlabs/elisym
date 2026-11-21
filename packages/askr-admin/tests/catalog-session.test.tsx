import { type CatalogItemInput, buildConfigEvent } from '@elisym/askr';
import { finalizeEvent } from 'nostr-tools/pure';
import { StrictMode, act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/components/Session';
import { ApiError } from '../src/lib/api';
import type { AdminClient } from '../src/lib/deps';
import {
  ASSISTANT,
  NOW,
  OWNER,
  SERVER_KEY,
  OWNER_KEY,
  catalogSyncOf,
  fakeApi,
  fakeReader,
  listing,
  sessionDeps,
  signedConfig,
  storeView,
} from './fakes';
import { type Mounted, buttonNamed, byId, click, mount, settle, typeInto } from './mount';

const MUG: CatalogItemInput = { d: 'mug', title: 'Mug', price: { amount: '12', currency: 'USD' } };
const TEAPOT: CatalogItemInput = {
  d: 'teapot',
  title: 'Teapot',
  price: { amount: '30', currency: 'USD' },
};

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

function rowButton(container: HTMLElement, label: string, row: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === label && button.closest('tr')?.textContent?.includes(row),
  );
  if (found === undefined) {
    throw new Error(`no ${label} button in the ${row} row`);
  }
  return found;
}

async function openTab(container: HTMLElement, label: string) {
  const tab = [...container.querySelectorAll('nav[aria-label="Sections"] button')].find(
    (button) => button.textContent === label,
  );
  if (!(tab instanceof HTMLButtonElement)) {
    throw new Error(`no ${label} tab`);
  }
  await click(tab);
}

async function confirmRemove(container: HTMLElement, row: string) {
  await click(rowButton(container, 'Remove', row));
  const confirm = container.querySelector(`button[aria-label="Remove ${row} for good"]`);
  if (!(confirm instanceof HTMLButtonElement)) {
    throw new Error(`no confirmation for ${row}`);
  }
  await click(confirm);
}

/** Every real write waits until the test lets it go. */
function holdWrites(api: AdminClient) {
  const real = vi.mocked(api.catalog).getMockImplementation();
  let letGo: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  vi.mocked(api.catalog).mockImplementation(async (change, dryRun) => {
    await gate;
    if (real === undefined) {
      throw new Error('no catalog');
    }
    return real(change, dryRun);
  });
  return async () => {
    await act(async () => {
      letGo();
    });
  };
}

const RELAY = () =>
  fakeReader([signedConfig(OWNER_KEY, 'Tea', NOW - 10), listing(MUG), listing(TEAPOT)]);

async function mountSession(api: AdminClient, strict = false) {
  const deps = sessionDeps(api, RELAY());
  const session = (
    <Session deps={deps} onSignOut={() => undefined} onReplaceKey={() => undefined} />
  );
  mounted = await mount(strict ? <StrictMode>{session}</StrictMode> : session);
  const { container } = mounted;
  await settle(() => text(container).includes('Overview'));
  await openTab(container, 'Products');
  await settle(() => text(container).includes('Teapot'));
  return container;
}

describe('the session catalog queue', () => {
  it('under StrictMode, a save still goes out once and its outcome shows', async () => {
    const api = fakeApi();
    const container = await mountSession(api, true);
    await click(rowButton(container, 'Edit', 'Mug'));
    await typeInto(byId(container, 'product-title'), 'Big mug');
    await click(buttonNamed(container, 'Save'));
    await settle(() => text(container).includes('Saved. Big mug is live in the chat.'));
    expect(api.catalog).toHaveBeenCalledTimes(1);
  });

  it('a removal keeps going on another tab, reloads the store there, and its outcome shows on return', async () => {
    const api = fakeApi();
    const release = holdWrites(api);
    const container = await mountSession(api);
    await confirmRemove(container, 'Teapot');
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 1);
    await openTab(container, 'Overview');
    const storeReads = vi.mocked(api.store).mock.calls.length;
    await release();
    // The write ends with no products page mounted: the queue still reads the store again.
    await settle(() => vi.mocked(api.store).mock.calls.length >= storeReads + 3);
    await openTab(container, 'Products');
    await settle(() => text(container).includes('Removed Teapot.'));
    expect(api.catalog).toHaveBeenCalledTimes(1);
  });

  it('a write on its way when the tab comes back shows on its row, then its outcome', async () => {
    const api = fakeApi();
    const release = holdWrites(api);
    const container = await mountSession(api);
    await confirmRemove(container, 'Teapot');
    await openTab(container, 'Overview');
    await openTab(container, 'Products');
    await settle(() =>
      (container.querySelector('tbody')?.textContent ?? '').includes('Removing...'),
    );
    await release();
    await settle(() => text(container).includes('Removed Teapot.'));
  });

  it('keeps the same queue through a refresh and a read back of stored events', async () => {
    const api = fakeApi({
      store: vi.fn(async () =>
        storeView({
          catalogSync: catalogSyncOf('done'),
          events: { pending: 1, failing: [] },
        }),
      ),
      storedEvents: vi.fn(async () => ({
        events: [signedConfig(OWNER_KEY, 'Tea', NOW - 5)],
        truncated: false,
      })),
    });
    const release = holdWrites(api);
    const container = await mountSession(api);
    await confirmRemove(container, 'Teapot');
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 1);
    const readsBack = vi.mocked(api.storedEvents).mock.calls.length;
    await click(buttonNamed(container, 'Refresh'));
    await settle(() => vi.mocked(api.storedEvents).mock.calls.length > readsBack);
    expect(container.querySelector('tbody')?.textContent).toContain('Removing...');
    await release();
    // The store this fake shows names another sync, so the end of this one is unknown.
    await settle(() => text(container).includes('Sent; press Refresh to check.'));
    expect(api.catalog).toHaveBeenCalledTimes(1);
  });

  it('sign-out (the session unmounting) sends nothing more for a waiting write', async () => {
    const api = fakeApi({
      catalog: vi.fn(async () => {
        throw new ApiError(409, 'sync_running');
      }),
    });
    const container = await mountSession(api);
    await confirmRemove(container, 'Teapot');
    await settle(() =>
      (container.querySelector('tbody')?.textContent ?? '').includes('Waiting...'),
    );
    const storeReads = vi.mocked(api.store).mock.calls.length;
    await mounted?.unmount();
    mounted = undefined;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(api.catalog).toHaveBeenCalledTimes(1);
    expect(api.store).toHaveBeenCalledTimes(storeReads);
  });
});

describe('the session catalog queue, round 1', () => {
  async function chooseFile(container: HTMLElement, contents: string) {
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('no file input');
    }
    Object.defineProperty(input, 'files', {
      value: [new File([contents], 'products.csv', { type: 'text/csv' })],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('a queued import shows, and can be cancelled, after a tab switch', async () => {
    const api = fakeApi();
    const release = holdWrites(api);
    const container = await mountSession(api);
    await confirmRemove(container, 'Teapot');
    await chooseFile(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await openTab(container, 'Overview');
    await openTab(container, 'Products');
    await settle(() => text(container).includes('Waiting for the products being published'));
    expect(text(container)).not.toContain('1 product read');
    await click(buttonNamed(container, 'Cancel'));
    expect(text(container)).not.toContain('Waiting for the products being published');
    await release();
    await settle(() => text(container).includes('Removed Teapot.'));
    expect(api.catalog).toHaveBeenCalledTimes(1);
  });

  it('a save on its way when the tab comes back reopens its editor, locked', async () => {
    const api = fakeApi();
    const release = holdWrites(api);
    const container = await mountSession(api);
    await click(rowButton(container, 'Edit', 'Mug'));
    await typeInto(byId(container, 'product-title'), 'Big mug');
    await click(buttonNamed(container, 'Save'));
    await openTab(container, 'Overview');
    await openTab(container, 'Products');
    await settle(() => container.querySelector('#product-title') !== null);
    expect(byId(container, 'product-title')).toHaveProperty('value', 'Big mug');
    expect(byId(container, 'product-title').closest('fieldset')?.disabled).toBe(true);
    expect(text(container)).toContain('Publishing...');
    await release();
    await settle(() => text(container).includes('Saved. Big mug is live in the chat.'));
  });

  it('a save that failed on another tab opens its editor again with the reason', async () => {
    const api = fakeApi();
    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    vi.mocked(api.catalog).mockImplementation(async () => {
      await gate;
      throw new ApiError(400, 'invalid_items', {
        issues: [{ path: [0, 'title'], message: 'too long' }],
      });
    });
    const container = await mountSession(api);
    await click(rowButton(container, 'Edit', 'Mug'));
    await typeInto(byId(container, 'product-title'), 'Big mug');
    await click(buttonNamed(container, 'Save'));
    await openTab(container, 'Overview');
    await act(async () => {
      letGo();
    });
    await settle(() => vi.mocked(api.store).mock.calls.length > 0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await openTab(container, 'Products');
    await settle(() => text(container).includes('item 1: title: too long'));
    expect(byId(container, 'product-title')).toHaveProperty('value', 'Big mug');
  });

  it('Choose a plan on the products page opens Billing', async () => {
    const api = fakeApi({ store: vi.fn(async () => storeView({ status: 'pending', tier: null })) });
    const container = await mountSession(api);
    await click(buttonNamed(container, 'Choose a plan'));
    expect(container.querySelector('h1')?.textContent).toBe('Billing');
  });

  it('sign-out disposes the queue: a write waiting on a running sync is never sent again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = fakeApi({
        catalog: vi.fn(async () => {
          throw new ApiError(409, 'sync_running');
        }),
      });
      const container = await mountSession(api);
      await confirmRemove(container, 'Teapot');
      await settle(() =>
        (container.querySelector('tbody')?.textContent ?? '').includes('Waiting...'),
      );
      await mounted?.unmount();
      mounted = undefined;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(api.catalog).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the session catalog queue, round 2', () => {
  it('a CSV import through the session reads the store it shows and publishes', async () => {
    const api = fakeApi();
    const container = await mountSession(api);
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('no file input');
    }
    Object.defineProperty(input, 'files', {
      value: [new File(['d,title,price\ncup,Cup,5\n'], 'products.csv', { type: 'text/csv' })],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await settle(() => text(container).includes('Published 1 product from the file.'));
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0].items.map((item) => item.d)).toEqual(['cup']);
  });
});

describe('the session catalog queue, round 13', () => {
  async function chooseCsv(container: HTMLElement, contents: string) {
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('no file input');
    }
    Object.defineProperty(input, 'files', {
      value: [new File([contents], 'products.csv', { type: 'text/csv' })],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('an import cancelled while it waits gives its Import button back', async () => {
    const api = fakeApi();
    const release = holdWrites(api);
    const container = await mountSession(api);
    await confirmRemove(container, 'Teapot');
    await chooseCsv(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    expect(buttonNamed(container, 'Importing...').disabled).toBe(true);
    await click(buttonNamed(container, 'Cancel'));
    await release();
    await settle(() => text(container).includes('Removed Teapot.'));
    expect(buttonNamed(container, 'Import 1 product').disabled).toBe(false);
  });

  it('a new product on its way keeps its fields when the tab comes back', async () => {
    const api = fakeApi();
    const release = holdWrites(api);
    const container = await mountSession(api);
    await click(buttonNamed(container, 'Add a product'));
    await typeInto(byId(container, 'product-d'), 'cup');
    await typeInto(byId(container, 'product-title'), 'Cup');
    await typeInto(byId(container, 'product-price'), '5');
    await click(buttonNamed(container, 'Save'));
    await openTab(container, 'Overview');
    await openTab(container, 'Products');
    await settle(() => container.querySelector('#product-title') !== null);
    expect(byId(container, 'product-title')).toHaveProperty('value', 'Cup');
    expect(byId(container, 'product-d')).toHaveProperty('value', 'cup');
    await release();
  });

  it('a second press of Save while one is on its way sends nothing more', async () => {
    const api = fakeApi();
    const release = holdWrites(api);
    const container = await mountSession(api);
    await click(rowButton(container, 'Edit', 'Mug'));
    await typeInto(byId(container, 'product-title'), 'Big mug');
    await click(buttonNamed(container, 'Save'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 1);
    const saving = buttonNamed(container, 'Saving...');
    expect(saving.disabled).toBe(true);
    await click(saving);
    await release();
    await settle(() => text(container).includes('Saved. Big mug is live in the chat.'));
    expect(api.catalog).toHaveBeenCalledTimes(1);
  });

  it('Choose a plan on the policies page opens Billing', async () => {
    const api = fakeApi({ store: vi.fn(async () => storeView({ status: 'pending', tier: null })) });
    const container = await mountSession(api);
    await openTab(container, 'Policies');
    await settle(() => text(container).includes('Choose a plan to add policies.'));
    await click(buttonNamed(container, 'Choose a plan'));
    expect(container.querySelector('h1')?.textContent).toBe('Billing');
  });

  it('Choose a plan on the connector page opens Billing', async () => {
    const shopConfig = finalizeEvent(
      {
        ...buildConfigEvent(
          {
            assistant: ASSISTANT,
            origins: ['https://tea.example'],
            name: 'Tea',
            language: 'en',
            currency: 'USD',
            source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
            catalogKey: SERVER_KEY,
            private: { voice: 'calm', instructions: 'Recommend oolong.', notes: 'Berlin' },
          },
          OWNER_KEY,
        ),
        created_at: NOW - 10,
      },
      OWNER_KEY,
    );
    const api = fakeApi({
      store: vi.fn(async () =>
        storeView({
          status: 'pending',
          tier: null,
          connector: {
            owner: OWNER,
            platform: 'shopify',
            url: 'https://tea.example',
            importPolicies: false,
            enabled: false,
            lastStatus: null,
            lastRunAt: null,
            nextRunAt: null,
          },
        }),
      ),
    });
    mounted = await mount(
      <Session
        deps={sessionDeps(api, fakeReader([shopConfig]))}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => text(container).includes('Overview'));
    await openTab(container, 'Connector');
    await settle(() => text(container).includes('Choose a plan to connect your shop.'));
    await click(buttonNamed(container, 'Choose a plan'));
    expect(container.querySelector('h1')?.textContent).toBe('Billing');
  });
});

describe('the session catalog queue, round 14', () => {
  function rowButtonOrNull(container: HTMLElement, label: string, row: string) {
    return [...container.querySelectorAll('button')].find(
      (button) => button.textContent === label && button.closest('tr')?.textContent?.includes(row),
    );
  }

  async function chooseCsv(container: HTMLElement, contents: string) {
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('no file input');
    }
    Object.defineProperty(input, 'files', {
      value: [new File([contents], 'products.csv', { type: 'text/csv' })],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('Dismiss on a failed row removal brings its Edit and Remove back, with no question open', async () => {
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw new ApiError(409, 'inactive');
    });
    const container = await mountSession(api);
    await confirmRemove(container, 'Teapot');
    await settle(() => rowButtonOrNull(container, 'Dismiss', 'Teapot') !== undefined);
    await click(rowButton(container, 'Dismiss', 'Teapot'));
    expect(rowButton(container, 'Edit', 'Teapot').disabled).toBe(false);
    expect(rowButton(container, 'Remove', 'Teapot').disabled).toBe(false);
    expect(text(container)).not.toContain('Remove Teapot? It disappears from the chat.');
  });

  it('Dismiss on a row removal whose answer was lost brings its Edit back', async () => {
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw new ApiError(0, 'network');
    });
    const container = await mountSession(api);
    await confirmRemove(container, 'Teapot');
    await settle(() => text(container).includes('Sent; press Refresh to check.'));
    await click(rowButton(container, 'Dismiss', 'Teapot'));
    expect(text(container)).not.toContain('Sent; press Refresh to check.');
    expect(rowButton(container, 'Edit', 'Teapot').disabled).toBe(false);
  });

  it('a row Retry and an open row confirmation are off while Replace all asks', async () => {
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw new ApiError(409, 'inactive');
    });
    const container = await mountSession(api);
    await confirmRemove(container, 'Teapot');
    await settle(() => rowButtonOrNull(container, 'Retry', 'Teapot') !== undefined);
    expect(rowButton(container, 'Retry', 'Teapot').disabled).toBe(false);
    await click(rowButton(container, 'Remove', 'Mug'));
    await chooseCsv(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    expect(rowButton(container, 'Retry', 'Teapot').disabled).toBe(true);
    const confirm = container.querySelector('button[aria-label="Remove Mug for good"]');
    if (!(confirm instanceof HTMLButtonElement)) {
      throw new Error('no confirmation for Mug');
    }
    expect(confirm.disabled).toBe(true);
  });

  it('an import through the session leaves out a product the relay already has as in the file', async () => {
    const api = fakeApi();
    const container = await mountSession(api);
    await chooseCsv(container, 'd,title,price\nmug,Mug,12\ncup,Cup,5\n');
    await settle(() => text(container).includes('2 products read'));
    await click(buttonNamed(container, 'Import 2 products'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length > 0);
    expect(vi.mocked(api.catalog).mock.calls[0]?.[0].items.map((item) => item.d)).toEqual(['cup']);
  });

  it('a fixed validation error is gone while the save goes out', async () => {
    const api = fakeApi();
    const release = holdWrites(api);
    const container = await mountSession(api);
    await click(buttonNamed(container, 'Add a product'));
    await typeInto(byId(container, 'product-d'), 'mug');
    await typeInto(byId(container, 'product-title'), 'Cup');
    await typeInto(byId(container, 'product-price'), '5');
    await click(buttonNamed(container, 'Save'));
    expect(text(container)).toContain('another product already uses');
    await typeInto(byId(container, 'product-d'), 'cup');
    await click(buttonNamed(container, 'Save'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 1);
    expect(text(container)).not.toContain('another product already uses');
    await release();
  });
});

describe('the session catalog queue, the sweep', () => {
  async function chooseCsv(container: HTMLElement, contents: string) {
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('no file input');
    }
    Object.defineProperty(input, 'files', {
      value: [new File([contents], 'products.csv', { type: 'text/csv' })],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  const heading = (container: HTMLElement) =>
    container.querySelector('.card h2')?.textContent ?? '';

  it('a reopened editor is a new one for a new product, and the product it was for otherwise', async () => {
    const api = fakeApi();
    const release = holdWrites(api);
    const container = await mountSession(api);
    await click(buttonNamed(container, 'Add a product'));
    await typeInto(byId(container, 'product-d'), 'cup');
    await typeInto(byId(container, 'product-title'), 'Cup');
    await typeInto(byId(container, 'product-price'), '5');
    await click(buttonNamed(container, 'Save'));
    await openTab(container, 'Overview');
    await openTab(container, 'Products');
    await settle(() => container.querySelector('#product-d') !== null);
    expect(heading(container)).toBe('New product');
    expect(byId(container, 'product-d')).toHaveProperty('readOnly', false);
    await release();
    await settle(() => text(container).includes('Saved. Cup'));
  });

  it('a reopened editor for an existing product is its editor, with the ID fixed', async () => {
    const api = fakeApi();
    const release = holdWrites(api);
    const container = await mountSession(api);
    await click(rowButton(container, 'Edit', 'Mug'));
    await typeInto(byId(container, 'product-title'), 'Big mug');
    await click(buttonNamed(container, 'Save'));
    await openTab(container, 'Overview');
    await openTab(container, 'Products');
    await settle(() => container.querySelector('#product-d') !== null);
    expect(heading(container)).toBe('Edit Big mug');
    expect(byId(container, 'product-d')).toHaveProperty('readOnly', true);
    await release();
  });

  it('back on the page after a save, the list is read and shown', async () => {
    const api = fakeApi();
    const container = await mountSession(api);
    await click(rowButton(container, 'Edit', 'Mug'));
    await typeInto(byId(container, 'product-title'), 'Big mug');
    await click(buttonNamed(container, 'Save'));
    await settle(() => text(container).includes('Saved. Big mug'));
    await openTab(container, 'Overview');
    await openTab(container, 'Products');
    await settle(() => text(container).includes('Teapot'));
  });

  it('a failed save closed with Cancel does not reopen after a tab switch', async () => {
    const api = fakeApi();
    vi.mocked(api.catalog).mockImplementationOnce(async () => {
      throw new ApiError(400, 'bad_request');
    });
    const container = await mountSession(api);
    await click(rowButton(container, 'Edit', 'Mug'));
    await typeInto(byId(container, 'product-title'), 'Big mug');
    await click(buttonNamed(container, 'Save'));
    await settle(() => text(container).includes('The server could not read the request'));
    await click(buttonNamed(container, 'Cancel'));
    await openTab(container, 'Overview');
    await openTab(container, 'Products');
    await settle(() => text(container).includes('Teapot'));
    expect(container.querySelector('#product-title')).toBeNull();
  });

  it('a Replace all on its way shows its line after a tab switch', async () => {
    const api = fakeApi();
    const release = holdWrites(api);
    const container = await mountSession(api);
    await chooseCsv(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Replace all with 1 product'));
    await settle(() => text(container).includes('Replace all products?'));
    await click(buttonNamed(container, 'Replace all'));
    await settle(() => vi.mocked(api.catalog).mock.calls.length === 1);
    await openTab(container, 'Overview');
    await openTab(container, 'Products');
    await settle(() => text(container).includes('Teapot'));
    expect(text(container)).toContain('Publishing...');
    await release();
  });

  it('an import whose answer was lost while away says to Refresh on return', async () => {
    const api = fakeApi();
    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    vi.mocked(api.catalog).mockImplementation(async () => {
      await gate;
      throw new ApiError(0, 'network');
    });
    const container = await mountSession(api);
    await chooseCsv(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await openTab(container, 'Overview');
    await act(async () => {
      letGo();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await openTab(container, 'Products');
    await settle(() =>
      text(container).includes(
        'The import was sent; its result could not be read. Press Refresh to check.',
      ),
    );
  });

  it('with an import on its way after a tab switch, the file field and Import are off', async () => {
    const api = fakeApi();
    const release = holdWrites(api);
    const container = await mountSession(api);
    await chooseCsv(container, 'd,title,price\ncup,Cup,5\n');
    await settle(() => text(container).includes('1 product read'));
    await click(buttonNamed(container, 'Import 1 product'));
    await openTab(container, 'Overview');
    await openTab(container, 'Products');
    await settle(() => text(container).includes('Publishing...'));
    const input = container.querySelector('input[type="file"]');
    expect(input instanceof HTMLInputElement && input.disabled).toBe(true);
    await chooseCsv(container, 'd,title,price\ntea,Tea,4\n');
    await settle(() => text(container).includes('1 product read'));
    expect(buttonNamed(container, 'Import 1 product').disabled).toBe(true);
    await release();
  });
});

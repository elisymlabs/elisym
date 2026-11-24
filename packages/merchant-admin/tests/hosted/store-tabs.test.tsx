import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAME_EMPTY, NO_RELAYS, PAYOUTS_FIRST } from '../../src/hosted/components/SettingsForm';
import { READ_FAILED_KEPT, StoreShell } from '../../src/hosted/components/StoreShell';
import { ApiError } from '../../src/hosted/lib/api';
import { STALE_RELOADED } from '../../src/hosted/lib/errors';
import { ROWS_PROBLEMS } from '../../src/hosted/lib/payout-rows';
import type { StoreApi } from '../../src/hosted/lib/store-session';
import type { ConfigInput, Payout, ProductRecord, StoreView } from '../../src/hosted/lib/types';
import { type Mounted, buttonNamed, click, inputById, mount, settle } from '../mount';
import { storeView } from './fakes';
import {
  LEAK,
  NOW,
  OTHER_SOLANA_ADDRESS,
  RELAYS,
  SOLANA_ADDRESS,
  SOLANA_USDC,
  authorizationTemplate,
  fakeSession,
  payoutListTemplate,
  signed,
  storeConfig,
} from './store-fakes';

const PAYOUTS: Payout[] = [{ caip19: SOLANA_USDC, address: SOLANA_ADDRESS, signature: 'sig' }];
const HOOK = 'https://shop.example.com/hook';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function configured(overrides: Partial<StoreView> = {}): StoreView {
  return storeView({
    status: 'active',
    config: storeConfig({
      draftPayouts: PAYOUTS,
      webhookUrl: HOOK,
      evmCredit: 'safe',
      nip05: 'shop@example.com',
      inboxRelays: RELAYS,
      revision: 7,
    }),
    ...overrides,
  });
}

async function open(view: StoreView, overrides: Partial<StoreApi> = {}) {
  const fake = fakeSession({ store: async () => view, ...overrides });
  mounted = await mount(
    <StoreShell session={fake.session} store={view} onSignOut={() => undefined} />,
  );
  return { ...fake, container: mounted.container };
}

function product(onSale: boolean): ProductRecord {
  return { d: 'socks', title: 'Socks', description: '', priceUsd: '5', onSale, updatedAt: NOW };
}

describe('settings', () => {
  it('saves the whole config: the webhook URL and the payouts kept, at the revision read', async () => {
    const puts: ConfigInput[] = [];
    const { container } = await open(configured(), {
      putConfig: async (input) => {
        puts.push(input);
        return { config: storeConfig({ revision: 8 }), requestId: null };
      },
    });
    await click(buttonNamed(container, 'Settings'));
    expect(inputById(container, 'settings-name').value).toBe('Shop');
    expect(inputById(container, 'evm-credit-safe').checked).toBe(true);
    await type(inputById(container, 'settings-name'), ' New name ');
    await type(inputById(container, 'settings-nip05'), '');
    await click(inputById(container, 'inbox-relay-0'));
    await click(buttonNamed(container, 'Save settings'));
    await settle(() => text(container).includes('Settings saved.'));
    expect(puts).toEqual([
      {
        name: 'New name',
        payouts: PAYOUTS,
        evmCredit: 'safe',
        webhookUrl: HOOK,
        inboxRelays: [RELAYS[1]],
        expectedRevision: 7,
      },
    ]);
  });

  it('keeps the nip05 and switches the EVM credit', async () => {
    const puts: ConfigInput[] = [];
    const { container } = await open(
      configured({ config: storeConfig({ draftPayouts: PAYOUTS, nip05: 'a@b.example' }) }),
      {
        putConfig: async (input) => {
          puts.push(input);
          return { config: storeConfig(), requestId: null };
        },
      },
    );
    await click(buttonNamed(container, 'Settings'));
    await click(inputById(container, 'evm-credit-safe'));
    await click(buttonNamed(container, 'Save settings'));
    await settle(() => puts.length === 1);
    expect(puts[0]).toMatchObject({
      nip05: 'a@b.example',
      evmCredit: 'safe',
      webhookUrl: null,
      expectedRevision: 1,
    });
  });

  it('reads the config again when it changed elsewhere, says so and shows the new one', async () => {
    let view = configured();
    const putConfig = vi.fn(async () => {
      throw new ApiError(409, 'stale_config');
    });
    const { container } = await open(view, {
      putConfig,
      store: async () => view,
    });
    await click(buttonNamed(container, 'Settings'));
    await type(inputById(container, 'settings-name'), 'Mine');
    view = configured({
      config: storeConfig({ name: 'Theirs', draftPayouts: PAYOUTS, revision: 9 }),
    });
    await click(buttonNamed(container, 'Save settings'));
    await settle(() => text(container).includes(STALE_RELOADED));
    await settle(() => inputById(container, 'settings-name').value === 'Theirs');
  });

  it('refuses an empty name or no relay before asking the server, and says server refusals by code', async () => {
    const putConfig = vi.fn(async () => {
      throw new ApiError(400, 'bad_config', { problems: [LEAK] });
    });
    const { container } = await open(configured(), { putConfig });
    await click(buttonNamed(container, 'Settings'));
    await type(inputById(container, 'settings-name'), ' ');
    await click(buttonNamed(container, 'Save settings'));
    expect(text(container)).toContain(NAME_EMPTY);
    await type(inputById(container, 'settings-name'), 'Shop');
    await click(inputById(container, 'inbox-relay-0'));
    await click(inputById(container, 'inbox-relay-1'));
    await click(buttonNamed(container, 'Save settings'));
    expect(text(container)).toContain(NO_RELAYS);
    expect(putConfig).not.toHaveBeenCalled();
    await click(inputById(container, 'inbox-relay-1'));
    await click(buttonNamed(container, 'Save settings'));
    await settle(() => text(container).includes('Some settings are not valid'));
    expect(text(container)).not.toContain('SECRET');
  });

  it('cannot save before the payouts are saved', async () => {
    const { container } = await open(storeView({ config: storeConfig() }));
    await click(buttonNamed(container, 'Settings'));
    expect(text(container)).toContain(PAYOUTS_FIRST);
    expect(buttonNamed(container, 'Save settings').disabled).toBe(true);
  });
});

describe('payouts tab', () => {
  it('shows the saved payouts and saves the whole config at the revision read', async () => {
    const puts: ConfigInput[] = [];
    const { container } = await open(configured(), {
      putConfig: async (input) => {
        puts.push(input);
        return {
          config: storeConfig({ draftPayouts: input.payouts, revision: 8 }),
          requestId: null,
        };
      },
    });
    await click(buttonNamed(container, 'Payouts'));
    expect(inputById(container, 'payout-address-0').value).toBe(SOLANA_ADDRESS);
    // Then each other coin of the network, once: a coin already saved gets no second row.
    expect(inputById(container, 'payout-address-1').value).toBe('');
    expect(container.querySelector('#proof-message-1')).not.toBeNull();
    expect(container.querySelector('#payout-address-2')).toBeNull();
    expect(container.querySelector('#payout-state-0')?.textContent).toBe('Signed earlier');
    await click(buttonNamed(container, 'Save payouts'));
    await settle(() => text(container).includes('Payouts saved.'));
    expect(puts).toEqual([
      {
        name: 'Shop',
        nip05: 'shop@example.com',
        payouts: PAYOUTS,
        evmCredit: 'safe',
        webhookUrl: HOOK,
        inboxRelays: RELAYS,
        expectedRevision: 7,
      },
    ]);
  });

  it('drops the wallet signature of an address the merchant edits', async () => {
    const putConfig = vi.fn();
    const { container } = await open(configured(), { putConfig });
    await click(buttonNamed(container, 'Payouts'));
    await type(inputById(container, 'payout-address-0'), OTHER_SOLANA_ADDRESS);
    expect(container.querySelector('#payout-state-0')?.textContent).toBe('Not signed yet');
    await click(buttonNamed(container, 'Save payouts'));
    expect(text(container)).toContain(ROWS_PROBLEMS.unsigned);
    expect(putConfig).not.toHaveBeenCalled();
  });

  it('reads the store again on a stale save and says so', async () => {
    const store = vi.fn(async () => configured());
    const { container } = await open(configured(), {
      putConfig: async () => {
        throw new ApiError(409, 'stale_config');
      },
      store,
    });
    await click(buttonNamed(container, 'Payouts'));
    await click(buttonNamed(container, 'Save payouts'));
    await settle(() => text(container).includes(STALE_RELOADED));
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('offers "Publish payout list" only while the payouts need signing', async () => {
    const { container } = await open(configured({ payouts: { needsSigning: true } }));
    await click(buttonNamed(container, 'Payouts'));
    expect(buttonNamed(container, 'Publish payout list')).toBeDefined();
    await mounted?.unmount();
    const event = signed(payoutListTemplate(PAYOUTS));
    const other = await open(
      configured({
        ownerEvents: { payto: { event, committedAt: NOW, publishedAt: NOW }, auth: null },
      }),
    );
    await click(buttonNamed(other.container, 'Payouts'));
    expect(
      [...other.container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Publish payout list',
      ),
    ).toBe(false);
  });
});

describe('overview', () => {
  it('says a pending store waits for activation, its plan and cap, and its alerts by kind', async () => {
    const { container } = await open(
      storeView({ status: 'pending', tier: null, maxProducts: 20, alerts: ['drift', LEAK] }),
    );
    expect(container.querySelector('#store-status')?.textContent).toBe('Waiting for activation');
    expect(container.querySelector('#store-plan')?.textContent).toBe('none yet, up to 20 products');
    expect(text(container)).toContain('waiting for activation by PayCore');
    expect(text(container)).toContain('this server did not make');
    expect(text(container)).toContain('Your store needs attention');
    expect(text(container)).not.toContain('SECRET');
  });

  it('shows the tier of an active store', async () => {
    const { container } = await open(
      storeView({ status: 'active', tier: 'basic', maxProducts: 50 }),
    );
    expect(container.querySelector('#store-plan')?.textContent).toBe('basic, up to 50 products');
    expect(text(container)).not.toContain('waiting for activation by PayCore');
  });

  it('checks off what is done, from the view and the products', async () => {
    const payto = signed(payoutListTemplate(PAYOUTS));
    const auth = signed(authorizationTemplate());
    const state = (container: HTMLElement, id: string) =>
      container.querySelector(`#check-${id}`)?.lastElementChild?.textContent;
    const { container } = await open(
      configured({
        ownerEvents: {
          payto: { event: payto, committedAt: NOW, publishedAt: NOW },
          auth: { event: auth, committedAt: NOW, publishedAt: null },
        },
      }),
      { products: async () => ({ products: [product(false), product(true)] }) },
    );
    await settle(() => state(container, 'product') === 'Done');
    expect(state(container, 'config')).toBe('Done');
    expect(state(container, 'payouts')).toBe('Done');
    expect(state(container, 'payto-signed')).toBe('Done');
    expect(state(container, 'payto-published')).toBe('Done');
    expect(state(container, 'auth-signed')).toBe('Done');
    expect(state(container, 'auth-published')).toBe('To do');
  });

  it('counts only a product on sale', async () => {
    const { container } = await open(configured(), {
      products: async () => ({ products: [product(false)] }),
    });
    await settle(
      () => container.querySelector('#check-product')?.lastElementChild?.textContent === 'To do',
    );
  });

  it('leaves to do what is not, and "unknown" when the products cannot be read', async () => {
    const payto = signed(payoutListTemplate(PAYOUTS));
    const state = (container: HTMLElement, id: string) =>
      container.querySelector(`#check-${id}`)?.lastElementChild?.textContent;
    const { container } = await open(
      configured({
        config: storeConfig({ draftPayouts: [{ caip19: SOLANA_USDC, address: SOLANA_ADDRESS }] }),
        payouts: { needsSigning: true },
        ownerEvents: { payto: { event: payto, committedAt: NOW, publishedAt: NOW }, auth: null },
      }),
      {
        products: async () => {
          throw new ApiError(0, 'network');
        },
      },
    );
    await settle(() => state(container, 'product') === 'Unknown');
    expect(state(container, 'config')).toBe('Done');
    expect(state(container, 'payouts')).toBe('To do');
    expect(state(container, 'payto-signed')).toBe('To do');
    expect(state(container, 'payto-published')).toBe('To do');
    expect(state(container, 'auth-signed')).toBe('To do');
    expect(text(container)).toContain('Your payouts changed since');
  });

  it('keeps the last view with a warning when a read after a change fails', async () => {
    const event = signed(authorizationTemplate());
    const { container } = await open(
      storeView({
        status: 'active',
        ownerEvents: { payto: null, auth: { event, committedAt: NOW, publishedAt: null } },
      }),
      {
        commitOwnerEvent: async () => ({ id: event.id, alreadyCommitted: true }),
        store: async () => {
          throw new ApiError(0, 'network');
        },
      },
    );
    await click(buttonNamed(container, 'Retry publishing'));
    await settle(() => text(container).includes(READ_FAILED_KEPT));
    expect(container.querySelector('#store-status')?.textContent).toBe('Active');
  });
});

describe('review round 1', () => {
  it('saves the nip05 trimmed, and the relays in the allowlist order', async () => {
    const puts: ConfigInput[] = [];
    const { container } = await open(configured(), {
      putConfig: async (input) => {
        puts.push(input);
        return { config: storeConfig({ revision: 8 }), requestId: null };
      },
    });
    await click(buttonNamed(container, 'Settings'));
    await type(inputById(container, 'settings-nip05'), '  a@b.example ');
    await click(inputById(container, 'inbox-relay-0'));
    await click(inputById(container, 'inbox-relay-0'));
    await click(buttonNamed(container, 'Save settings'));
    await settle(() => puts.length === 1);
    expect(puts[0]).toMatchObject({ nip05: 'a@b.example', inboxRelays: RELAYS });
  });

  it('clears the read warning after a good read, and reads the products again for the new view', async () => {
    const event = signed(authorizationTemplate());
    let fail = true;
    let products: ProductRecord[] = [];
    const first = storeView({
      status: 'active',
      ownerEvents: { payto: null, auth: { event, committedAt: NOW, publishedAt: null } },
    });
    const { container } = await open(first, {
      commitOwnerEvent: async () => ({ id: event.id, alreadyCommitted: true }),
      products: async () => ({ products }),
      store: async () => {
        if (fail) {
          throw new ApiError(0, 'network');
        }
        return { ...first };
      },
    });
    const state = () => container.querySelector('#check-product')?.lastElementChild?.textContent;
    await settle(() => state() === 'To do');
    await click(buttonNamed(container, 'Retry publishing'));
    await settle(() => text(container).includes(READ_FAILED_KEPT));
    fail = false;
    products = [product(true)];
    await click(buttonNamed(container, 'Retry publishing'));
    await settle(() => !text(container).includes(READ_FAILED_KEPT));
    await settle(() => state() === 'Done');
  });

  it('offers no "Publish payout list" with no payouts saved', async () => {
    const { container } = await open(
      storeView({ status: 'active', config: storeConfig(), payouts: { needsSigning: true } }),
    );
    expect(container.querySelector('#payto-status')?.textContent).toBe('Save your payouts first.');
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Publish payout list',
      ),
    ).toBe(false);
  });
});

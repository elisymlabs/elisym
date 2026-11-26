import type { EventTemplate } from 'nostr-tools';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../../src/hosted/components/Session';
import type { StoreApi } from '../../src/hosted/lib/store-session';
import type { ConfigInput, StoreView } from '../../src/hosted/lib/types';
import { proofMessage } from '../../src/hosted/lib/wallets';
import { type Mounted, buttonNamed, click, inputById, mount, settle } from '../mount';
import { CONFIG, OWNER, storeApi, storeView } from './fakes';
import {
  BASE_SEPOLIA_USDC,
  TEST_META,
  payoutListTemplate,
  signed,
  storeConfig,
} from './store-fakes';
import {
  evmKey,
  fakeSolanaWallet,
  injectStandardWallet,
  personalSign,
  solanaKey,
  utf8Hex,
} from './wallets/fakes';

let mounted: Mounted | undefined;
const removers: (() => void)[] = [];
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  for (const remove of removers.splice(0)) {
    remove();
  }
  vi.restoreAllMocks();
});

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

/** A Session over a store with no payouts yet; a save makes them the draft that needs signing. */
function server() {
  let view: StoreView = storeView({ status: 'active', config: storeConfig() });
  const puts: ConfigInput[] = [];
  const api: StoreApi = storeApi({
    meta: async () => TEST_META,
    store: async () => view,
    putConfig: async (input) => {
      puts.push(input);
      const config = storeConfig({ draftPayouts: input.payouts, revision: 2 });
      view = { ...view, config, payouts: { needsSigning: true } };
      return { config, requestId: null };
    },
    prepareOwnerEvent: async () => ({
      // The session dates by the real clock: a template from now.
      template: payoutListTemplate(view.config?.draftPayouts ?? [], Math.floor(Date.now() / 1000)),
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    }),
  });
  return { api, puts };
}

function session(api: StoreApi, onSignOut: () => void) {
  return (
    <Session
      api={api}
      config={CONFIG}
      owner={OWNER}
      signEvent={async (template: EventTemplate) => signed(template)}
      onSignOut={onSignOut}
      onSwitchOwner={() => undefined}
      sleep={async () => undefined}
    />
  );
}

async function publishAndConfirm(container: HTMLElement) {
  await settle(() =>
    [...container.querySelectorAll('button')].some(
      (button) => button.textContent === 'Publish payout list',
    ),
  );
  await click(buttonNamed(container, 'Publish payout list'));
  await settle(() => container.querySelector('#confirm-owner-event') !== null);
}

describe('the payouts proven in this browser session', () => {
  it('stay proven across a re-render of the session', async () => {
    const key = solanaKey();
    removers.push(
      injectStandardWallet(window, fakeSolanaWallet({ name: 'Test Wallet', accounts: [key] })),
    );
    const { api } = server();
    mounted = await mount(session(api, () => undefined));
    const { container } = mounted;
    await settle(() => container.querySelector('#tab-payouts') !== null);
    await click(buttonNamed(container, 'Payouts'));
    await settle(() => text(container).includes('Sign with Test Wallet'));
    await click(buttonNamed(container, 'Sign with Test Wallet'));
    await settle(
      () => container.querySelector('#payout-state-0')?.textContent === 'Signed from this device',
    );
    await click(buttonNamed(container, 'Save payouts'));
    await settle(() => text(container).includes('Payouts saved.'));
    await mounted.rerender(session(api, () => undefined));
    await publishAndConfirm(container);
    expect(container.querySelector('#confirm-address-0')?.textContent).toBe(key.address);
    expect(text(container)).toContain('Signed from this device');
    expect(container.querySelector('#confirm-tick-0')).toBeNull();
  });

  it('take a pasted EVM proof for an address entered with spaces around it', async () => {
    const evm = evmKey();
    const { api, puts } = server();
    mounted = await mount(session(api, () => undefined));
    const { container } = mounted;
    await settle(() => container.querySelector('#tab-payouts') !== null);
    await click(buttonNamed(container, 'Payouts'));
    await type(inputById(container, 'payout-address-1'), `  ${evm.checksummed}  `);
    const message = proofMessage(OWNER, BASE_SEPOLIA_USDC);
    await type(
      inputById(container, 'paste-signature-1'),
      personalSign(evm.secretKey, utf8Hex(message)),
    );
    await click(buttonNamed(container, 'Check signature'));
    await click(buttonNamed(container, 'Save payouts'));
    await settle(() => puts.length === 1);
    expect(puts[0]?.payouts.map((payout) => payout.address)).toEqual([evm.lower]);
    await publishAndConfirm(container);
    expect(container.querySelector('#confirm-address-0')?.textContent).toBe(evm.lower);
    expect(container.querySelector('#confirm-tick-0')).toBeNull();
  });
});

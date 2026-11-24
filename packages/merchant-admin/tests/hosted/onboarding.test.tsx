import type { NostrEvent } from 'nostr-tools';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAME_REQUIRED } from '../../src/hosted/components/CreateStore';
import { Onboarding } from '../../src/hosted/components/Onboarding';
import { PASTE_REFUSED } from '../../src/hosted/components/PasteProof';
import { PROOF_ERRORS } from '../../src/hosted/components/PayoutRow';
import { ApiError } from '../../src/hosted/lib/api';
import { STALE_RELOADED } from '../../src/hosted/lib/errors';
import { ON_ACTIVATION } from '../../src/hosted/lib/owner-flow';
import { ROWS_PROBLEMS } from '../../src/hosted/lib/payout-rows';
import type { StoreApi } from '../../src/hosted/lib/store-session';
import type {
  ConfigInput,
  CreateStoreInput,
  StoreConfig,
  StoreView,
} from '../../src/hosted/lib/types';
import { proofMessage } from '../../src/hosted/lib/wallets';
import { type Mounted, buttonNamed, click, inputById, mount, settle } from '../mount';
import { OWNER, storeView } from './fakes';
import {
  BASE_SEPOLIA_USDC,
  LEAK,
  NOW,
  RELAYS,
  SOLANA_USDC,
  authorizationTemplate,
  fakeSession,
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

function created(config: Partial<StoreConfig> = {}): StoreView {
  return storeView({ status: 'pending', config: storeConfig({ inboxRelays: RELAYS, ...config }) });
}

async function start(overrides: Partial<StoreApi> = {}) {
  const fake = fakeSession(overrides);
  const onOpen = vi.fn();
  mounted = await mount(
    <Onboarding session={fake.session} onOpen={onOpen} onSignOut={() => undefined} />,
  );
  return { ...fake, onOpen, container: mounted.container };
}

async function createStore(container: HTMLElement) {
  await type(inputById(container, 'onboard-name'), '  My Shop ');
  await click(inputById(container, 'onboard-network-devnet'));
  await type(inputById(container, 'onboard-nip05'), 'shop@example.com');
  await click(buttonNamed(container, 'Create store'));
}

/** A Solana wallet in the page that signs with a real ed25519 key. */
function solanaWallet(options: Parameters<typeof fakeSolanaWallet>[0] = {}) {
  const key = solanaKey();
  const wallet = fakeSolanaWallet({ name: 'Test Wallet', accounts: [key], ...options });
  removers.push(injectStandardWallet(window, wallet));
  return { key, wallet };
}

describe('onboarding', () => {
  it('creates the store, saves the first payouts with the inbox relays, signs both owner events, then points at products', async () => {
    const { key } = solanaWallet();
    const creates: CreateStoreInput[] = [];
    const puts: ConfigInput[] = [];
    const commits: NostrEvent[] = [];
    let view = created();
    const { container, onOpen } = await start({
      createStore: async (input) => {
        creates.push(input);
        return view;
      },
      putConfig: async (input) => {
        puts.push(input);
        const config = storeConfig({
          name: input.name,
          draftPayouts: input.payouts,
          inboxRelays: input.inboxRelays,
          revision: 2,
        });
        view = { ...view, config, payouts: { needsSigning: true } };
        return { config, requestId: null };
      },
      store: async () => view,
      prepareOwnerEvent: async (kind) => ({
        template:
          kind === 10133
            ? payoutListTemplate(view.config?.draftPayouts ?? [])
            : authorizationTemplate(),
        expiresAt: NOW + 900,
      }),
      commitOwnerEvent: async (event) => {
        commits.push(event);
        const committed = { event, committedAt: NOW, publishedAt: null };
        view =
          event.kind === 10133
            ? {
                ...view,
                payouts: { needsSigning: false },
                ownerEvents: { ...view.ownerEvents, payto: committed },
              }
            : { ...view, ownerEvents: { ...view.ownerEvents, auth: committed } };
        return { id: event.id, request: { id: `r${commits.length}`, state: 'pending' } };
      },
    });
    expect(text(container)).toContain('Create your store');
    await createStore(container);
    await settle(() => text(container).includes('Where buyers pay you'));
    expect(creates).toEqual([{ name: 'My Shop', network: 'devnet', nip05: 'shop@example.com' }]);
    expect(text(container)).toContain('signed by its wallet');

    // One row per devnet coin of /v1/meta; the Solana one is signed by the wallet.
    expect(container.querySelector('#payout-address-0')).not.toBeNull();
    expect(container.querySelector('#payout-address-1')).not.toBeNull();
    expect(container.querySelector('#payout-address-2')).toBeNull();
    await settle(() => text(container).includes('Sign with Test Wallet'));
    await click(buttonNamed(container, 'Sign with Test Wallet'));
    await settle(
      () => container.querySelector('#payout-state-0')?.textContent === 'Signed from this device',
    );
    expect(inputById(container, 'payout-address-0').value).toBe(key.address);

    // Every allowed relay is on by default; the merchant keeps the second only.
    expect(inputById(container, 'inbox-relay-0').checked).toBe(true);
    expect(inputById(container, 'inbox-relay-1').checked).toBe(true);
    await click(inputById(container, 'inbox-relay-0'));
    await click(buttonNamed(container, 'Save payouts'));
    await settle(() => text(container).includes('Sign with your owner key'));
    expect(puts).toHaveLength(1);
    const [put] = puts;
    expect(put).toMatchObject({
      name: 'Shop',
      evmCredit: 'fast',
      webhookUrl: null,
      inboxRelays: [RELAYS[1]],
      expectedRevision: 1,
    });
    expect(put?.payouts).toHaveLength(1);
    expect(put?.payouts[0]).toMatchObject({ caip19: SOLANA_USDC, address: key.address });

    await click(buttonNamed(container, 'Publish payout list'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    expect(text(container)).toContain('Signed from this device');
    await click(buttonNamed(container, 'Sign and publish'));
    await settle(() => text(container).includes(ON_ACTIVATION));
    await settle(() => container.querySelector('#payto-status') !== null);
    expect(container.querySelector('#onboarding-products')).toBeNull();

    await click(buttonNamed(container, 'Authorize PayCore'));
    await settle(() => container.querySelector('#confirm-owner-event') !== null);
    await click(buttonNamed(container, 'Sign and publish'));
    await settle(() => container.querySelector('#onboarding-products') !== null);
    expect(commits.map((event) => event.kind)).toEqual([10133, 30490]);
    expect(commits[0]?.pubkey).toBe(OWNER);

    await click(buttonNamed(container, 'Open your store'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('points at products only once the current payout list and the authorization are signed', async () => {
    const payto = { event: signed(payoutListTemplate([])), committedAt: NOW, publishedAt: null };
    const auth = { event: signed(authorizationTemplate()), committedAt: NOW, publishedAt: null };
    const payouts = [
      {
        caip19: SOLANA_USDC,
        address: 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM',
        signature: 's',
      },
    ];
    let view = storeView({
      status: 'pending',
      config: storeConfig({ draftPayouts: payouts, revision: 3 }),
      payouts: { needsSigning: true },
      ownerEvents: { payto, auth },
    });
    const { container } = await start({ createStore: async () => view });
    await createStore(container);
    await settle(() => text(container).includes('Sign with your owner key'));
    expect(container.querySelector('#onboarding-products')).toBeNull();
    view = { ...view, payouts: { needsSigning: false }, ownerEvents: { payto: null, auth } };
    await mounted?.unmount();
    const other = await start({ createStore: async () => view });
    await createStore(other.container);
    await settle(() => text(other.container).includes('Sign with your owner key'));
    expect(other.container.querySelector('#onboarding-products')).toBeNull();
    view = { ...view, ownerEvents: { payto, auth } };
    await mounted?.unmount();
    const done = await start({ createStore: async () => view });
    await createStore(done.container);
    await settle(() => done.container.querySelector('#onboarding-products') !== null);
  });

  it('asks for a name, and says a refused creation in a fixed sentence', async () => {
    const createStore = vi.fn(async (): Promise<StoreView> => {
      throw new ApiError(429, 'rate_limited', { message: LEAK });
    });
    const { container } = await start({ createStore });
    await click(buttonNamed(container, 'Create store'));
    expect(text(container)).toContain(NAME_REQUIRED);
    expect(createStore).not.toHaveBeenCalled();
    await type(inputById(container, 'onboard-name'), 'Shop');
    await click(buttonNamed(container, 'Create store'));
    await settle(() => text(container).includes('Too many new stores'));
    expect(createStore).toHaveBeenCalledWith({ name: 'Shop', network: 'mainnet' });
    expect(text(container)).not.toContain('SECRET');
  });

  it('offers only the networks the server runs', async () => {
    const fake = fakeSession();
    mounted = await mount(
      <Onboarding
        session={{
          ...fake.session,
          meta: { ...fake.session.meta, networks: { devnet: { coins: [] } } },
        }}
        onOpen={() => undefined}
        onSignOut={() => undefined}
      />,
    );
    expect(mounted.container.querySelector('#onboard-network-mainnet')).toBeNull();
    expect(inputById(mounted.container, 'onboard-network-devnet').checked).toBe(true);
  });

  it('saves no payouts that are missing or unsigned', async () => {
    const putConfig = vi.fn();
    const { container } = await start({ createStore: async () => created(), putConfig });
    await createStore(container);
    await settle(() => text(container).includes('Save payouts'));
    await click(buttonNamed(container, 'Save payouts'));
    expect(text(container)).toContain(ROWS_PROBLEMS.none);
    await type(
      inputById(container, 'payout-address-0'),
      'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM',
    );
    expect(container.querySelector('#payout-state-0')?.textContent).toBe('Not signed yet');
    await click(buttonNamed(container, 'Save payouts'));
    expect(text(container)).toContain(ROWS_PROBLEMS.unsigned);
    expect(putConfig).not.toHaveBeenCalled();
  });

  it('says a wallet that refuses, and a wallet with another address than the one entered', async () => {
    solanaWallet({
      sign: async () => {
        throw new Error(LEAK);
      },
    });
    const { container } = await start({ createStore: async () => created() });
    await createStore(container);
    await settle(() => text(container).includes('Sign with Test Wallet'));
    await click(buttonNamed(container, 'Sign with Test Wallet'));
    await settle(() => text(container).includes(PROOF_ERRORS.rejected));
    expect(text(container)).not.toContain('SECRET');

    await type(
      inputById(container, 'payout-address-0'),
      'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM',
    );
    await click(buttonNamed(container, 'Sign with Test Wallet'));
    await settle(() => text(container).includes(PROOF_ERRORS.wrong_address));
  });

  it('takes a pasted EVM signature over the exact message shown, saved lowercase', async () => {
    const evm = evmKey();
    const puts: ConfigInput[] = [];
    const { container } = await start({
      createStore: async () => created(),
      putConfig: async (input) => {
        puts.push(input);
        return {
          config: storeConfig({ draftPayouts: input.payouts, revision: 2 }),
          requestId: null,
        };
      },
      store: async () => created({ revision: 2 }),
    });
    await createStore(container);
    await settle(() => text(container).includes('Save payouts'));
    const message = proofMessage(OWNER, BASE_SEPOLIA_USDC);
    expect(container.querySelector('#proof-message-1')?.textContent).toBe(message);
    expect(container.querySelector('#proof-message-0')).toBeNull();

    await type(inputById(container, 'payout-address-1'), evm.checksummed);
    await type(
      inputById(container, 'paste-signature-1'),
      personalSign(evm.secretKey, utf8Hex('other')),
    );
    await click(buttonNamed(container, 'Check signature'));
    expect(text(container)).toContain(PASTE_REFUSED);

    await type(
      inputById(container, 'paste-signature-1'),
      personalSign(evm.secretKey, utf8Hex(message)),
    );
    await click(buttonNamed(container, 'Check signature'));
    expect(container.querySelector('#payout-state-1')?.textContent).toBe('Signed from this device');
    expect(text(container)).not.toContain(PASTE_REFUSED);
    await click(buttonNamed(container, 'Save payouts'));
    await settle(() => puts.length === 1);
    expect(puts[0]?.payouts).toEqual([
      { caip19: BASE_SEPOLIA_USDC, address: evm.lower, signature: expect.any(String) },
    ]);
  });

  it('says a refused save in a fixed sentence, and reads the store again when it was stale', async () => {
    solanaWallet();
    let code = 'bad_config';
    const store = vi.fn(async () => created({ name: 'Renamed', revision: 5 }));
    const { container } = await start({
      createStore: async () => created(),
      putConfig: async () => {
        throw new ApiError(409, code, { problems: [LEAK] });
      },
      store,
    });
    await createStore(container);
    await settle(() => text(container).includes('Sign with Test Wallet'));
    await click(buttonNamed(container, 'Sign with Test Wallet'));
    await settle(
      () => container.querySelector('#payout-state-0')?.textContent === 'Signed from this device',
    );
    await click(buttonNamed(container, 'Save payouts'));
    await settle(() => text(container).includes('Some settings are not valid'));
    expect(text(container)).not.toContain('SECRET');
    expect(store).not.toHaveBeenCalled();

    code = 'stale_config';
    await click(buttonNamed(container, 'Save payouts'));
    await settle(() => text(container).includes(STALE_RELOADED));
    expect(store).toHaveBeenCalledTimes(1);
  });
});

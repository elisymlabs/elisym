import { CONFIG_D_TAG, KIND_CATALOG_AUTH, KIND_CONFIG, parseConfig } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Onboarding } from '../src/components/Onboarding';
import type { StoreView } from '../src/lib/types';
import {
  ASSISTANT,
  NOW,
  OWNER,
  SERVER_KEY,
  fakeApi,
  fakeReader,
  sessionDeps,
  storeView,
} from './fakes';
import { type Mounted, buttonNamed, byId, click, mount, settle, typeInto } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('onboarding', () => {
  it('creates the store, then posts the signed config and the server K authorization together', async () => {
    const api = fakeApi();
    const deps = sessionDeps(api, fakeReader([]));
    let view: StoreView | undefined;
    const onDone = vi.fn(async () => undefined);
    const render = () => (
      <Onboarding
        deps={deps}
        view={view}
        onCreated={(created) => {
          view = created;
        }}
        onDone={onDone}
        onSignOut={() => undefined}
      />
    );
    mounted = await mount(render());
    expect(mounted.container.textContent).toContain('Your store starts as pending');
    await click(buttonNamed(mounted.container, 'Create my store'));
    expect(api.createStore).toHaveBeenCalledTimes(1);
    await mounted.rerender(render());

    const { container } = mounted;
    await typeInto(byId(container, 'store-name'), 'Tea Shop');
    await typeInto(byId(container, 'store-origins'), 'https://tea.example');
    await typeInto(byId(container, 'store-instructions'), 'Be brief.');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length > 0);

    const events: NostrEvent[] = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(events.map((event) => event.kind)).toEqual([KIND_CONFIG, KIND_CATALOG_AUTH]);
    const config = events[0] === undefined ? undefined : parseConfig(events[0]);
    expect(config).toMatchObject({
      owner: OWNER,
      assistant: ASSISTANT,
      name: 'Tea Shop',
      origins: ['https://tea.example'],
      source: { kind: 'admin' },
      catalogKey: SERVER_KEY,
    });
    expect(events[1]?.tags).toEqual(
      expect.arrayContaining([
        ['d', SERVER_KEY],
        ['mode', 'hosted'],
      ]),
    );
    await settle(() => onDone.mock.calls.length > 0);
    // What was stored is remembered, so the next signature is dated after it.
    expect(deps.journal.latest(KIND_CONFIG, CONFIG_D_TAG)?.id).toBe(events[0]?.id);
    expect(deps.journal.latest(KIND_CATALOG_AUTH, SERVER_KEY)?.id).toBe(events[1]?.id);
  });

  it('names the next assistant while a rotation is under way', async () => {
    const api = fakeApi();
    const next = getPublicKey(generateSecretKey());
    mounted = await mount(
      <Onboarding
        deps={sessionDeps(api, fakeReader([]))}
        view={storeView({ nextAssistant: next })}
        onCreated={() => undefined}
        onDone={async () => undefined}
        onSignOut={() => undefined}
      />,
    );
    const { container } = mounted;
    await typeInto(byId(container, 'store-name'), 'Tea Shop');
    await typeInto(byId(container, 'store-origins'), 'https://tea.example');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length > 0);
    const [config] = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(config === undefined ? undefined : parseConfig(config)?.assistant).toBe(next);
  });

  it('dates a retried save after the first, so the server does not refuse it as stale', async () => {
    const api = fakeApi();
    mounted = await mount(
      <Onboarding
        deps={sessionDeps(api, fakeReader([]))}
        view={storeView({ status: 'pending', tier: null })}
        onCreated={() => undefined}
        onDone={async () => undefined}
        onSignOut={() => undefined}
      />,
    );
    const { container } = mounted;
    await typeInto(byId(container, 'store-name'), 'Tea Shop');
    await typeInto(byId(container, 'store-origins'), 'https://tea.example');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 2);
    const dates = vi.mocked(api.storeEvents).mock.calls.map((call) => call[0][0]?.created_at);
    expect(dates).toEqual([NOW, NOW + 1]);
  });

  it('shows a form problem in words and posts nothing', async () => {
    const api = fakeApi();
    mounted = await mount(
      <Onboarding
        deps={sessionDeps(api, fakeReader([]))}
        view={storeView({ status: 'pending', tier: null })}
        onCreated={() => undefined}
        onDone={async () => undefined}
        onSignOut={() => undefined}
      />,
    );
    const { container } = mounted;
    await typeInto(byId(container, 'store-name'), 'Tea Shop');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => (container.textContent ?? '').includes('Allowed origins:'));
    expect(api.storeEvents).not.toHaveBeenCalled();
  });
});

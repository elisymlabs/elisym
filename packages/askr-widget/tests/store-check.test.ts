import { buildCatalogAuth, buildConfigEvent } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_EOSE_TIMEOUT_MS, STORE_CHECK_PREFIX, STORE_CHECK_TTL_MS } from '../src/constants';
import { checkStore } from '../src/store-check';
import {
  FakeGateway,
  FakeRelay,
  MAIN_RELAY,
  MemoryStorage,
  makeStore,
  publishStore,
  sign,
  type TestStore,
} from './fixtures';

const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.useRealTimers();
});

function setup(options: { published: boolean; mode?: FakeGateway['mode'] }) {
  const store = makeStore();
  const relay = new FakeRelay();
  if (options.published) {
    publishStore(relay, store);
  }
  const gateway = new FakeGateway(store.gatewayKey, store.assistant.pubkey);
  gateway.mode = options.mode ?? 'grant';
  const storage = new MemoryStorage();
  const owner = store.owner.pubkey;
  const deps = { connect: relay.connect, gateway, storage, now: () => NOW };
  return { owner, store, relay, gateway, storage, deps };
}

describe('checkStore: whether the widget shows for a store (B)', () => {
  it('shows a store whose settings are on the relay, without asking the gateway', async () => {
    const { owner, gateway, storage, deps } = setup({ published: true });
    expect((await checkStore(owner, deps)).visibility).toBe('show');
    expect(gateway.sessions).toHaveLength(0);
    expect(storage.getItem(`${STORE_CHECK_PREFIX}${owner}`)).toBe(`show:${NOW}`);
  });

  it('hides a store with no settings that the gateway does not serve (pending), and keeps that', async () => {
    const { owner, gateway, storage, deps } = setup({ published: false, mode: 'unavailable' });
    expect((await checkStore(owner, deps)).visibility).toBe('hide');
    expect(gateway.sessions).toHaveLength(1);
    expect(storage.getItem(`${STORE_CHECK_PREFIX}${owner}`)).toBe(`hide:${NOW}`);
    // Kept for a while: the next page view reads nothing.
    expect((await checkStore(owner, deps)).visibility).toBe('hide');
    expect(gateway.sessions).toHaveLength(1);
    // Read again once the kept decision is old, so a store that went live shows.
    gateway.mode = 'grant';
    const later = { ...deps, now: () => NOW + STORE_CHECK_TTL_MS };
    expect((await checkStore(owner, later)).visibility).toBe('show');
    expect(gateway.sessions).toHaveLength(2);
  });

  it('events that are no valid config still ask the gateway, and hide a store it does not serve', async () => {
    // Only the owner's catalog authorization, no config: the relay has events, none of them settings.
    const authOnly = setup({ published: false, mode: 'unavailable' });
    authOnly.relay.storeOnly(
      MAIN_RELAY,
      sign(
        buildCatalogAuth({
          key: authOnly.store.catalogKey.pubkey,
          mode: 'hosted',
          createdAt: NOW / 1000 - 100,
        }),
        authOnly.store.owner,
      ),
    );
    expect((await checkStore(authOnly.owner, authOnly.deps)).visibility).toBe('hide');
    expect(authOnly.gateway.sessions).toHaveLength(1);
    // A config dated a day ahead of the clock is not taken as settings either.
    const ahead = setup({ published: false, mode: 'unavailable' });
    publishStore(ahead.relay, ahead.store, NOW / 1000 + 86_400);
    expect((await checkStore(ahead.owner, ahead.deps)).visibility).toBe('hide');
    expect(ahead.gateway.sessions).toHaveLength(1);
  });

  it('shows a store with no settings that moved to a new owner key (the client follows it)', async () => {
    const { owner, gateway, deps } = setup({ published: false });
    gateway.movedTo = 'f'.repeat(64);
    expect((await checkStore(owner, deps)).visibility).toBe('show');
  });

  it('a relay or gateway failure shows the widget and keeps nothing', async () => {
    const down = setup({ published: true });
    down.relay.failConnects = 1;
    expect((await checkStore(down.owner, down.deps)).visibility).toBe('show');
    expect(down.storage.getItem(`${STORE_CHECK_PREFIX}${down.owner}`)).toBeNull();

    const gatewayDown = setup({ published: false, mode: 'error' });
    expect((await checkStore(gatewayDown.owner, gatewayDown.deps)).visibility).toBe('show');
    expect(gatewayDown.storage.getItem(`${STORE_CHECK_PREFIX}${gatewayDown.owner}`)).toBeNull();
  });

  it('asks the gateway with a throwaway visitor key, never a kept one', async () => {
    const { owner, gateway, deps } = setup({ published: false, mode: 'unavailable' });
    await checkStore(owner, deps);
    await checkStore(owner, { ...deps, storage: new MemoryStorage() });
    const [first, second] = gateway.sessions;
    expect(first?.visitor).not.toBe(second?.visitor);
  });

  it('a relay that never sends EOSE shows the widget and keeps nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { owner, relay, gateway, storage, deps } = setup({
      published: false,
      mode: 'unavailable',
    });
    relay.holdEose = true;
    const check = checkStore(owner, deps);
    await vi.advanceTimersByTimeAsync(NO_EOSE_TIMEOUT_MS + 1);
    expect(await check).toEqual({ visibility: 'show' });
    expect(gateway.sessions).toHaveLength(0);
    expect(storage.getItem(`${STORE_CHECK_PREFIX}${owner}`)).toBeNull();
  });

  it('a relay that CLOSEs the read shows the widget and keeps nothing', async () => {
    const { owner, relay, gateway, storage, deps } = setup({
      published: false,
      mode: 'unavailable',
    });
    relay.holdEose = true;
    const check = checkStore(owner, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    relay.closeSubscriptions(MAIN_RELAY, () => true);
    expect(await check).toEqual({ visibility: 'show' });
    expect(gateway.sessions).toHaveLength(0);
    expect(storage.getItem(`${STORE_CHECK_PREFIX}${owner}`)).toBeNull();
  });

  it('closes its relay connection once it has read, whatever it found', async () => {
    for (const published of [true, false]) {
      const { owner, relay, deps } = setup({ published, mode: 'unavailable' });
      await checkStore(owner, deps);
      expect(relay.connections).toHaveLength(1);
      expect(relay.connections.every((connection) => connection.closed)).toBe(true);
    }
  });

  it('a kept decision dated in the future is ignored and read again', async () => {
    const { owner, gateway, storage, deps } = setup({ published: false, mode: 'unavailable' });
    storage.setItem(`${STORE_CHECK_PREFIX}${owner}`, `show:${NOW + 60_000}`);
    expect((await checkStore(owner, deps)).visibility).toBe('hide');
    expect(gateway.sessions).toHaveLength(1);
  });

  it('checks running at once for one store share one read', async () => {
    const { owner, relay, gateway, deps } = setup({ published: false, mode: 'unavailable' });
    const both = await Promise.all([checkStore(owner, deps), checkStore(owner, deps)]);
    expect(both).toEqual([{ visibility: 'hide' }, { visibility: 'hide' }]);
    expect(relay.connections).toHaveLength(1);
    expect(gateway.sessions).toHaveLength(1);
    // Once it settled, the next check runs on its own (here from the kept decision).
    await checkStore(owner, { ...deps, storage: new MemoryStorage() });
    expect(relay.connections).toHaveLength(2);
  });

  it('a malformed kept value is read again', async () => {
    const { owner, gateway, storage, deps } = setup({ published: false, mode: 'unavailable' });
    storage.setItem(`${STORE_CHECK_PREFIX}${owner}`, 'show:soon');
    expect((await checkStore(owner, deps)).visibility).toBe('hide');
    expect(gateway.sessions).toHaveLength(1);
  });
});

describe("checkStore: the store's launcher text, before the launcher appears", () => {
  const TEXT = 'Ask: our stylist';

  function setupWithText(launcherText: string | undefined = TEXT) {
    const context = setup({ published: false });
    const configInput =
      launcherText === undefined
        ? context.store.configInput
        : { ...context.store.configInput, launcherText };
    publishStore(context.relay, { ...context.store, configInput });
    return context;
  }

  function publishWithTags(relay: FakeRelay, store: TestStore, tags: NostrEvent['tags']): void {
    publishStore(relay, store);
    const template = buildConfigEvent(store.configInput, store.owner.secretKey);
    relay.storeOnly(
      MAIN_RELAY,
      sign(
        { ...template, created_at: template.created_at + 10, tags: [...template.tags, ...tags] },
        store.owner,
      ),
    );
  }

  it('returns the text with the decision and keeps it in a form old builds still read', async () => {
    const { owner, storage, deps } = setupWithText();
    expect(await checkStore(owner, deps)).toEqual({ visibility: 'show', launcherText: TEXT });
    const kept = storage.getItem(`${STORE_CHECK_PREFIX}${owner}`) ?? '';
    expect(kept).toMatch(/^show:\d{1,15}(:|$)/u);
    const parts = kept.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe(String(NOW));
    expect(decodeURIComponent(parts[2] ?? '')).toBe(TEXT);
  });

  it('a kept text is used without reading the relay', async () => {
    const { owner, relay, storage, deps } = setup({ published: false, mode: 'unavailable' });
    storage.setItem(`${STORE_CHECK_PREFIX}${owner}`, `show:${NOW}:${encodeURIComponent(TEXT)}`);
    expect(await checkStore(owner, deps)).toEqual({ visibility: 'show', launcherText: TEXT });
    expect(relay.connections).toHaveLength(0);
  });

  it('an old-format kept decision has no text', async () => {
    const { owner, relay, storage, deps } = setup({ published: false, mode: 'unavailable' });
    storage.setItem(`${STORE_CHECK_PREFIX}${owner}`, `show:${NOW}`);
    expect(await checkStore(owner, deps)).toEqual({ visibility: 'show' });
    expect(relay.connections).toHaveLength(0);
  });

  it.each([
    ['a third part that does not decode', `show:${NOW}:%E0`],
    ['a text over the limit', `show:${NOW}:${'a'.repeat(25)}`],
    ['a text that decodes to a lone surrogate', `show:${NOW}:Ask${'\uD800'}`],
    ['a blank text', `show:${NOW}:%20%20`],
    ['four parts', `show:${NOW}:a:b`],
    ['a text on a hide', `hide:${NOW}:a`],
  ])('%s is a miss and the relay is read again', async (_case, value) => {
    const { owner, relay, gateway, storage, deps } = setup({
      published: false,
      mode: 'unavailable',
    });
    storage.setItem(`${STORE_CHECK_PREFIX}${owner}`, value);
    expect(await checkStore(owner, deps)).toEqual({ visibility: 'hide' });
    expect(relay.connections).toHaveLength(1);
    expect(gateway.sessions).toHaveLength(1);
  });

  it('the gateway path has no text', async () => {
    const { owner, gateway, deps } = setup({ published: false });
    gateway.movedTo = 'f'.repeat(64);
    expect(await checkStore(owner, deps)).toEqual({ visibility: 'show' });
  });

  it('a config whose text has a lone surrogate shows with no text and keeps a plain decision', async () => {
    const { owner, relay, store, storage, deps } = setup({ published: false });
    publishWithTags(relay, store, [['launcher-text', 'Ask\uD800']]);
    expect(await checkStore(owner, deps)).toEqual({ visibility: 'show' });
    expect(storage.getItem(`${STORE_CHECK_PREFIX}${owner}`)).toBe(`show:${NOW}`);
  });
});

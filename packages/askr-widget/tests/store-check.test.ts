import { buildCatalogAuth } from '@elisym/askr';
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
    expect(await checkStore(owner, deps)).toBe('show');
    expect(gateway.sessions).toHaveLength(0);
    expect(storage.getItem(`${STORE_CHECK_PREFIX}${owner}`)).toBe(`show:${NOW}`);
  });

  it('hides a store with no settings that the gateway does not serve (pending), and keeps that', async () => {
    const { owner, gateway, storage, deps } = setup({ published: false, mode: 'unavailable' });
    expect(await checkStore(owner, deps)).toBe('hide');
    expect(gateway.sessions).toHaveLength(1);
    expect(storage.getItem(`${STORE_CHECK_PREFIX}${owner}`)).toBe(`hide:${NOW}`);
    // Kept for a while: the next page view reads nothing.
    expect(await checkStore(owner, deps)).toBe('hide');
    expect(gateway.sessions).toHaveLength(1);
    // Read again once the kept decision is old, so a store that went live shows.
    gateway.mode = 'grant';
    const later = { ...deps, now: () => NOW + STORE_CHECK_TTL_MS };
    expect(await checkStore(owner, later)).toBe('show');
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
    expect(await checkStore(authOnly.owner, authOnly.deps)).toBe('hide');
    expect(authOnly.gateway.sessions).toHaveLength(1);
    // A config dated a day ahead of the clock is not taken as settings either.
    const ahead = setup({ published: false, mode: 'unavailable' });
    publishStore(ahead.relay, ahead.store, NOW / 1000 + 86_400);
    expect(await checkStore(ahead.owner, ahead.deps)).toBe('hide');
    expect(ahead.gateway.sessions).toHaveLength(1);
  });

  it('shows a store with no settings that moved to a new owner key (the client follows it)', async () => {
    const { owner, gateway, deps } = setup({ published: false });
    gateway.movedTo = 'f'.repeat(64);
    expect(await checkStore(owner, deps)).toBe('show');
  });

  it('a relay or gateway failure shows the widget and keeps nothing', async () => {
    const down = setup({ published: true });
    down.relay.failConnects = 1;
    expect(await checkStore(down.owner, down.deps)).toBe('show');
    expect(down.storage.getItem(`${STORE_CHECK_PREFIX}${down.owner}`)).toBeNull();

    const gatewayDown = setup({ published: false, mode: 'error' });
    expect(await checkStore(gatewayDown.owner, gatewayDown.deps)).toBe('show');
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
    expect(await check).toBe('show');
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
    expect(await check).toBe('show');
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
    expect(await checkStore(owner, deps)).toBe('hide');
    expect(gateway.sessions).toHaveLength(1);
  });

  it('checks running at once for one store share one read', async () => {
    const { owner, relay, gateway, deps } = setup({ published: false, mode: 'unavailable' });
    const both = await Promise.all([checkStore(owner, deps), checkStore(owner, deps)]);
    expect(both).toEqual(['hide', 'hide']);
    expect(relay.connections).toHaveLength(1);
    expect(gateway.sessions).toHaveLength(1);
    // Once it settled, the next check runs on its own (here from the kept decision).
    await checkStore(owner, { ...deps, storage: new MemoryStorage() });
    expect(relay.connections).toHaveLength(2);
  });

  it('a malformed kept value is read again', async () => {
    const { owner, gateway, storage, deps } = setup({ published: false, mode: 'unavailable' });
    storage.setItem(`${STORE_CHECK_PREFIX}${owner}`, 'show:soon');
    expect(await checkStore(owner, deps)).toBe('hide');
    expect(gateway.sessions).toHaveLength(1);
  });
});

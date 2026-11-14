import {
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  buildCatalogAuth,
  buildConfigEvent,
  parseConfig,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Overview } from '../src/components/Overview';
import { Session } from '../src/components/Session';
import { ApiError } from '../src/lib/api';
import type { AdminClient } from '../src/lib/deps';
import { ownSignedEvents, withStoredEvents } from '../src/lib/stored-events';
import {
  ASSISTANT,
  NOW,
  OWNER,
  OWNER_KEY,
  SERVER_KEY,
  fakeApi,
  fakeReader,
  sessionDeps,
  storeView,
} from './fakes';
import { type Mounted, buttonNamed, byId, click, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const PRIVATE_PART = { voice: 'calm', instructions: 'Recommend oolong.', notes: 'Berlin' };

function configSignedBy(secret: Uint8Array, name: string, createdAt: number): NostrEvent {
  return finalizeEvent(
    {
      ...buildConfigEvent(
        {
          assistant: ASSISTANT,
          origins: ['https://tea.example'],
          name,
          language: 'en',
          currency: 'USD',
          source: { kind: 'admin' },
          catalogKey: SERVER_KEY,
          private: PRIVATE_PART,
        },
        secret,
      ),
      created_at: createdAt,
    },
    secret,
  );
}

function serverAuthorization(createdAt: number): NostrEvent {
  return finalizeEvent(
    { ...buildCatalogAuth({ key: SERVER_KEY, mode: 'hosted' }), created_at: createdAt },
    OWNER_KEY,
  );
}

const pendingView = (pending: number) =>
  storeView({ status: 'pending', tier: null, events: { pending, failing: [] } });

function pendingApi(stored: unknown[], pending = stored.length): AdminClient {
  return fakeApi({
    store: vi.fn(async () => pendingView(pending)),
    storedEvents: vi.fn(async () => ({ events: stored, truncated: false })),
  });
}

function fieldValue(container: HTMLElement, id: string): string {
  const field = byId(container, id);
  return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
    ? field.value
    : '';
}

async function mountSession(api: AdminClient, relay: NostrEvent[] = []) {
  const deps = sessionDeps(api, fakeReader(relay));
  mounted = await mount(<Session deps={deps} onSignOut={() => undefined} />);
  const { container } = mounted;
  await settle(() => /Overview|Set up your assistant|could not/.test(container.textContent ?? ''));
  return { container, deps };
}

describe('the owner signed events the server holds', () => {
  it('keeps only well-formed events signed by the owner, each signature checked', () => {
    const own = configSignedBy(OWNER_KEY, 'Tea', NOW);
    const foreign = configSignedBy(generateSecretKey(), 'Other', NOW);
    // As the server's JSON arrives: plain objects, no verification cached on them.
    const wire = (event: NostrEvent): NostrEvent => JSON.parse(JSON.stringify(event));
    const forged = { ...wire(own), content: `${own.content} ` };
    const relabelled = { ...wire(foreign), pubkey: OWNER };
    const malformed = [
      null,
      'event',
      {},
      { ...wire(own), tags: [[1]] },
      { ...wire(own), tags: [1] },
      { ...wire(own), tags: 'd' },
      { ...wire(own), created_at: '1' },
    ];
    const kept = ownSignedEvents([wire(own), foreign, forged, relabelled, ...malformed], OWNER);
    expect(kept.map(wire)).toEqual([wire(own)]);
    // Rebuilt from the signed fields only: nothing else the server sent rides along.
    expect(ownSignedEvents([{ ...wire(own), extra: 'x' }], OWNER).map(wire)).toEqual([wire(own)]);
  });

  it('are added to the relay read where they match the filter, once', async () => {
    const config = configSignedBy(OWNER_KEY, 'Tea', NOW);
    const auth = serverAuthorization(NOW);
    const relay = fakeReader([auth]);
    expect(withStoredEvents(relay, [])).toBe(relay);
    const reader = withStoredEvents(relay, [config, auth]);
    const configs = await reader.query({ kinds: [KIND_CONFIG], authors: [OWNER] });
    expect(configs).toEqual([config]);
    const auths = await reader.query({ kinds: [KIND_CATALOG_AUTH], authors: [OWNER] });
    expect(auths).toEqual([auth]);
    expect(await reader.query({ kinds: [KIND_CONFIG], authors: [SERVER_KEY] })).toEqual([]);
  });

  it('a relay that fails still fails the read', async () => {
    const reader = withStoredEvents(
      { query: async () => Promise.reject(new Error('relay down')) },
      [configSignedBy(OWNER_KEY, 'Tea', NOW)],
    );
    await expect(reader.query({ kinds: [KIND_CONFIG] })).rejects.toThrow('relay down');
  });
});

describe('a pending store read back from the server (7.3)', () => {
  it('shows the settings O signed, decrypted, in the overview and the settings form', async () => {
    const api = pendingApi([configSignedBy(OWNER_KEY, 'Saved Tea', NOW - 10)]);
    const { container } = await mountSession(api);
    expect(container.textContent).not.toContain('Set up your assistant');
    expect(container.querySelector('h1')?.textContent).toBe('Saved Tea');
    expect(container.textContent).toContain('published once your store is activated');
    expect(container.textContent).not.toContain('not on the relay yet');
    expect(container.textContent).not.toContain('not shown here');
    await click(buttonNamed(container, 'Settings'));
    await settle(() => container.querySelector('#store-name') !== null);
    expect(fieldValue(container, 'store-name')).toBe('Saved Tea');
    expect(fieldValue(container, 'store-instructions')).toBe('Recommend oolong.');
  });

  it('a later save is dated after the stored config and repeats no stored authorization', async () => {
    const stored = configSignedBy(OWNER_KEY, 'Saved Tea', NOW + 50);
    const api = pendingApi([stored, serverAuthorization(NOW - 10)]);
    const { container } = await mountSession(api);
    await click(buttonNamed(container, 'Settings'));
    await settle(() => container.querySelector('#store-name') !== null);
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    const events = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(events.map((event) => event.kind)).toEqual([KIND_CONFIG]);
    const saved = events[0] === undefined ? undefined : parseConfig(events[0]);
    expect(saved?.createdAt).toBe(NOW + 51);
    expect(saved?.name).toBe('Saved Tea');
  });

  it('says when the server left older changes out of its answer', async () => {
    const api = fakeApi({
      store: vi.fn(async () => pendingView(2)),
      storedEvents: vi.fn(async () => ({
        events: [configSignedBy(OWNER_KEY, 'Saved Tea', NOW)],
        truncated: true,
      })),
    });
    const { container } = await mountSession(api);
    expect(container.querySelector('h1')?.textContent).toBe('Saved Tea');
    expect(container.textContent).toContain('Some older changes you signed are not shown here');
  });

  it('says nothing waits on the server when only an authorization is stored', async () => {
    const api = pendingApi([serverAuthorization(NOW)]);
    const { container } = await mountSession(api, [configSignedBy(OWNER_KEY, 'Relay', NOW - 10)]);
    expect(container.querySelector('h1')?.textContent).toBe('Relay');
    expect(container.textContent).not.toContain('shown as you signed them');
  });

  it('never uses an event the owner did not sign', async () => {
    const api = pendingApi([configSignedBy(generateSecretKey(), 'Not Yours', NOW)], 1);
    const { container } = await mountSession(api);
    expect(container.querySelector('h1')?.textContent).toBe('Your store');
    expect(container.textContent).toContain('not on the relay yet');
    expect(container.textContent).not.toContain('Not Yours');
  });

  it('a newer config on the relay wins over an older stored one (a suspended store)', async () => {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ status: 'suspended' })),
      storedEvents: vi.fn(async () => ({
        events: [configSignedBy(OWNER_KEY, 'Older', NOW - 50)],
        truncated: false,
      })),
    });
    const { container } = await mountSession(api, [configSignedBy(OWNER_KEY, 'Newer', NOW - 10)]);
    expect(container.querySelector('h1')?.textContent).toBe('Newer');
    // The settings shown are the relay's, so nothing says they wait on the server.
    expect(container.textContent).not.toContain('shown as you signed them');
  });

  it('a suspended store shows what O signed since, which waits for reactivation', async () => {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ status: 'suspended' })),
      storedEvents: vi.fn(async () => ({
        events: [configSignedBy(OWNER_KEY, 'Signed Since', NOW - 10)],
        truncated: false,
      })),
    });
    const { container } = await mountSession(api, [configSignedBy(OWNER_KEY, 'Relay', NOW - 50)]);
    expect(container.querySelector('h1')?.textContent).toBe('Signed Since');
    expect(container.textContent).toContain('published once your store is reactivated');
  });

  it('an active store reads the relay only, and never asks the server', async () => {
    const api = fakeApi({
      storedEvents: vi.fn(async () => ({
        events: [configSignedBy(OWNER_KEY, 'Stored', NOW)],
        truncated: false,
      })),
    });
    const { container } = await mountSession(api, [configSignedBy(OWNER_KEY, 'Relay', NOW - 10)]);
    expect(container.querySelector('h1')?.textContent).toBe('Relay');
    expect(api.storedEvents).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('shown as you signed them');
  });

  it('once activated, the relay is the source again', async () => {
    let view = pendingView(1);
    const api = fakeApi({
      store: vi.fn(async () => view),
      storedEvents: vi.fn(async () => ({
        events: [configSignedBy(OWNER_KEY, 'Stored', NOW)],
        truncated: false,
      })),
    });
    const { container } = await mountSession(api, [configSignedBy(OWNER_KEY, 'Relay', NOW - 500)]);
    expect(container.querySelector('h1')?.textContent).toBe('Stored');
    view = storeView();
    await click(buttonNamed(container, 'Refresh'));
    await settle(() => container.querySelector('h1')?.textContent === 'Relay');
    expect(api.storedEvents).toHaveBeenCalledTimes(1);
  });

  it('a failed read-back says so, offers a retry and never onboards', async () => {
    let fail = true;
    const api = fakeApi({
      store: vi.fn(async () => pendingView(2)),
      storedEvents: vi.fn(async () => {
        if (fail) {
          throw new ApiError(0, 'network');
        }
        return { events: [configSignedBy(OWNER_KEY, 'Saved Tea', NOW)], truncated: false };
      }),
    });
    const { container } = await mountSession(api);
    expect(container.textContent).toContain('Your saved settings could not be read');
    expect(container.textContent).not.toContain('Set up your assistant');
    fail = false;
    await click(buttonNamed(container, 'Retry'));
    await settle(() => container.querySelector('h1')?.textContent === 'Saved Tea');
    expect(container.textContent).not.toContain('could not be read');
  });
});

describe('the overview', () => {
  it('shows the conversations so far next to the open ones, and says what one is', async () => {
    mounted = await mount(
      <Overview view={storeView()} config={undefined} configFromServer={false} />,
    );
    const { container } = mounted;
    expect(byId(container, 'usage-conversations').textContent).toBe('12');
    expect(container.textContent).toContain('Conversations so far12');
    expect(container.textContent).toContain('Open conversations3');
    expect(container.textContent).toContain('got at least one answer');
  });
});

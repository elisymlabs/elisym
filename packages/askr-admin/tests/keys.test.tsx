import {
  KIND_CATALOG_AUTH,
  buildCatalogAuth,
  buildConfigEvent,
  decryptPrivateConfig,
  parseConfig,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogKeys } from '../src/components/CatalogKeys';
import { RotateAssistant } from '../src/components/RotateAssistant';
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
import { type Mounted, buttonNamed, byId, click, mount, settle, typeInto } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function tagOf(event: NostrEvent | undefined, name: string): string | undefined {
  return event?.tags.find((tag) => tag[0] === name)?.[1];
}

describe('catalog keys', () => {
  it('lists the keys O authorizes, authorizes a pasted npub self-host and revokes one', async () => {
    const serverAuth = finalizeEvent(
      // Dated by the real clock: the authority reader ignores an authorization from the future.
      {
        ...buildCatalogAuth({ key: SERVER_KEY, mode: 'hosted' }),
        created_at: Math.floor(Date.now() / 1000) - 10,
      },
      OWNER_KEY,
    );
    const api = fakeApi();
    mounted = await mount(
      <CatalogKeys
        deps={sessionDeps(api, fakeReader([serverAuth]))}
        view={storeView()}
        config={undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes(nip19.npubEncode(SERVER_KEY)));
    expect(container.textContent).toContain('the server key of this admin');

    const merchantKey = getPublicKey(generateSecretKey());
    await typeInto(byId(container, 'authorize-key'), nip19.npubEncode(merchantKey));
    await click(buttonNamed(container, 'Sign and authorize'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    const [authorization] = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(authorization?.kind).toBe(KIND_CATALOG_AUTH);
    expect(authorization?.pubkey).toBe(OWNER);
    expect(tagOf(authorization, 'd')).toBe(merchantKey);
    expect(tagOf(authorization, 'mode')).toBe('self-host');

    await click(buttonNamed(container, 'Revoke'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 2);
    const [revocation] = vi.mocked(api.storeEvents).mock.calls[1]?.[0] ?? [];
    expect(tagOf(revocation, 'd')).toBe(SERVER_KEY);
    expect(tagOf(revocation, 'mode')).toBe('revoked');
  });
});

describe('assistant rotation', () => {
  it('re-signs the published config naming the next assistant, private part sealed to it', async () => {
    const privatePart = { voice: 'calm', instructions: 'Be brief.', notes: '' };
    const published = finalizeEvent(
      {
        ...buildConfigEvent(
          {
            assistant: ASSISTANT,
            origins: ['https://tea.example'],
            name: 'Tea Shop',
            language: 'en',
            currency: 'USD',
            source: { kind: 'admin' },
            catalogKey: SERVER_KEY,
            private: privatePart,
          },
          OWNER_KEY,
        ),
        created_at: NOW - 100,
      },
      OWNER_KEY,
    );
    const config = parseConfig(published);
    if (config === undefined) {
      throw new Error('config does not parse');
    }
    const nextKey = generateSecretKey();
    const next = getPublicKey(nextKey);
    const api = fakeApi({ rotateAssistant: vi.fn(async () => ({ nextAssistant: next })) });
    const onChanged = vi.fn(async () => undefined);
    mounted = await mount(
      <RotateAssistant
        deps={sessionDeps(api, fakeReader([published]))}
        view={storeView()}
        config={config}
        onChanged={onChanged}
      />,
    );
    await click(buttonNamed(mounted.container, 'Rotate assistant key'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);

    const events = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(events).toHaveLength(1);
    const rotated = events[0] === undefined ? undefined : parseConfig(events[0]);
    expect(rotated?.assistant).toBe(next);
    expect(rotated?.name).toBe('Tea Shop');
    expect(rotated?.createdAt).toBeGreaterThan(config.createdAt);
    expect(rotated === undefined ? undefined : decryptPrivateConfig(rotated, nextKey)).toEqual(
      privatePart,
    );
    expect(mounted.container.textContent).toContain('current assistant keeps answering');
  });
});

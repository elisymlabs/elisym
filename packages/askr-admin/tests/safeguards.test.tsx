import {
  type CatalogItemInput,
  type StoreConfig,
  type SyncDiff,
  buildCatalogAuth,
  buildConfigEvent,
  buildPolicyEvent,
  parseConfig,
} from '@elisym/askr';
import { buildStoreAuthEvent } from '@elisym/commerce';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogKeys } from '../src/components/CatalogKeys';
import { CsvImport } from '../src/components/CsvImport';
import { DiffSummary } from '../src/components/DiffSummary';
import { PoliciesSection } from '../src/components/PoliciesSection';
import { ProductList } from '../src/components/ProductList';
import { ProductsSection } from '../src/components/ProductsSection';
import { Session } from '../src/components/Session';
import { SettingsSection } from '../src/components/SettingsSection';
import { SignIn } from '../src/components/SignIn';
import type { RelayReader } from '../src/lib/relay';
import { type Nip07Provider, extensionSigner, npubOf, secretKeySigner } from '../src/lib/signer';
import { readConfig } from '../src/lib/store-data';
import { formOfConfig, signStoreEvents } from '../src/lib/store-form';
import type { StoreView } from '../src/lib/types';
import {
  ASSISTANT,
  NIP44_STUB,
  NOW,
  OWNER,
  OWNER_KEY,
  SERVER_KEY,
  SERVER_KEY_SECRET,
  adminConfig,
  fakeApi,
  fakeReader,
  listing,
  sessionDeps,
  storeView,
} from './fakes';
import { type Mounted, buttonNamed, click, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const EMPTY_DIFF: SyncDiff = { created: [], updated: [], hidden: [], unchanged: [] };
const PRIVATE_PART = { voice: 'calm', instructions: 'Be brief.', notes: '' };

function signedConfig(name: string, createdAt: number): NostrEvent {
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
        OWNER_KEY,
      ),
      created_at: createdAt,
    },
    OWNER_KEY,
  );
}

/** A config signed by O that no reader accepts (no name). */
function unparseableConfig(createdAt: number): NostrEvent {
  const good = signedConfig('Broken', createdAt);
  return finalizeEvent(
    {
      kind: good.kind,
      created_at: createdAt,
      tags: good.tags.filter((tag) => tag[0] !== 'name'),
      content: good.content,
    },
    OWNER_KEY,
  );
}

function configOf(event: NostrEvent): StoreConfig {
  const config = parseConfig(event);
  if (config === undefined) {
    throw new Error('config does not parse');
  }
  return config;
}

function tagOf(event: NostrEvent | undefined, name: string): string | undefined {
  return event?.tags.find((tag) => tag[0] === name)?.[1];
}

describe('a newest config that does not parse', () => {
  it('is told apart from no config, with the newest readable one to start from', async () => {
    expect(await readConfig(fakeReader([]), OWNER, NOW)).toEqual({ state: 'none' });
    const older = signedConfig('Tea Shop', NOW - 100);
    const read = await readConfig(fakeReader([older, unparseableConfig(NOW - 10)]), OWNER, NOW);
    expect(read).toMatchObject({ state: 'unreadable', newestAt: NOW - 10 });
    expect(read.state === 'unreadable' ? read.fallback?.name : undefined).toBe('Tea Shop');
  });

  it('keeps the owner out of onboarding and says the settings must be saved again', async () => {
    const api = fakeApi();
    const reader = fakeReader([signedConfig('Tea Shop', NOW - 100), unparseableConfig(NOW - 10)]);
    mounted = await mount(<Session deps={sessionDeps(api, reader)} onSignOut={() => undefined} />);
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Overview'));
    expect(container.textContent).not.toContain('Set up your assistant');
    expect(container.textContent).toContain('Your newest published settings could not be read');
  });

  it('starts Settings from the readable version and dates the save after the unreadable one', async () => {
    const older = signedConfig('Tea Shop', NOW - 100);
    const api = fakeApi();
    const deps = sessionDeps(api, fakeReader([older]));
    mounted = await mount(
      <SettingsSection
        deps={deps}
        view={storeView()}
        config={configOf(older)}
        configError=""
        configUnreadableAt={NOW + 50}
        onRetry={async () => undefined}
        onSaved={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => container.querySelector('#store-name') !== null);
    expect(container.textContent).toContain('starts from the newest version that can be read');
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    const [saved] = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(saved?.created_at).toBe(NOW + 51);
    expect(saved === undefined ? undefined : parseConfig(saved)?.name).toBe('Tea Shop');
  });
});

describe('a later refresh that fails', () => {
  it('keeps the dashboard with a warning; only the first load may fail the page', async () => {
    let fail = false;
    const api = fakeApi({
      store: vi.fn(async () => {
        if (fail) {
          throw new Error('Bad gateway');
        }
        return storeView();
      }),
    });
    mounted = await mount(
      <Session
        deps={sessionDeps(api, fakeReader([signedConfig('Tea Shop', NOW - 10)]))}
        onSignOut={() => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Overview'));
    fail = true;
    await click(buttonNamed(container, 'Refresh'));
    await settle(() => (container.textContent ?? '').includes('could not be refreshed'));
    expect(container.textContent).toContain('Overview');
    expect(container.textContent).toContain('Tea Shop');
  });

  it('fails the page when the very first load fails', async () => {
    const api = fakeApi({
      store: vi.fn(async () => {
        throw new Error('Bad gateway');
      }),
    });
    mounted = await mount(
      <Session deps={sessionDeps(api, fakeReader([]))} onSignOut={() => undefined} />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Bad gateway'));
    expect(mounted.container.textContent).not.toContain('Overview');
  });
});

describe('policies that could not be read', () => {
  it('offer no Add, only a retry', async () => {
    const policy = finalizeEvent(
      {
        ...buildPolicyEvent({ slug: 'returns', title: 'Returns', body: '30 days' }),
        created_at: NOW - 5,
      },
      SERVER_KEY_SECRET,
    );
    let broken = true;
    const reader: RelayReader = {
      query: async (filter) => {
        if (broken) {
          throw new Error('relay down');
        }
        return fakeReader([policy]).query(filter);
      },
    };
    mounted = await mount(
      <PoliciesSection
        deps={sessionDeps(fakeApi(), reader)}
        view={storeView()}
        config={adminConfig()}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('could not be read'));
    expect(container.textContent).not.toContain('Add a policy');
    broken = false;
    await click(buttonNamed(container, 'Retry'));
    await settle(() => (container.textContent ?? '').includes('Add a policy'));
  });
});

describe('settings while the authorizations are unread', () => {
  it('cannot be saved until a retry reads them', async () => {
    const event = signedConfig('Tea Shop', NOW - 100);
    let broken = true;
    const reader: RelayReader = {
      query: async (filter) => {
        if (broken && filter.kinds?.includes(30497) === true) {
          throw new Error('relay down');
        }
        return fakeReader([event]).query(filter);
      },
    };
    const api = fakeApi();
    mounted = await mount(
      <SettingsSection
        deps={sessionDeps(api, reader)}
        view={storeView()}
        config={configOf(event)}
        configError=""
        onRetry={async () => undefined}
        onSaved={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('authorizations could not be read'));
    expect(buttonNamed(container, 'Sign and save').disabled).toBe(true);
    await click(buttonNamed(container, 'Sign and save'));
    expect(api.storeEvents).not.toHaveBeenCalled();
    broken = false;
    await click(buttonNamed(container, 'Retry'));
    await settle(() => !buttonNamed(container, 'Sign and save').disabled);
  });

  it('counts only keys with the catalog role as authorized: a Pay Core role alone gets a 30497', async () => {
    const merchantKey = getPublicKey(generateSecretKey());
    const config = configOf(
      finalizeEvent(
        {
          ...buildConfigEvent(
            {
              assistant: ASSISTANT,
              origins: ['https://tea.example'],
              name: 'Tea Shop',
              language: 'en',
              currency: 'USD',
              source: { kind: 'catalog' },
              catalogKey: merchantKey,
              private: PRIVATE_PART,
            },
            OWNER_KEY,
          ),
          created_at: NOW - 100,
        },
        OWNER_KEY,
      ),
    );
    const paycoreRole = finalizeEvent(
      {
        ...buildStoreAuthEvent({ storePubkey: merchantKey, mode: 'self-host' }),
        created_at: NOW - 50,
      },
      OWNER_KEY,
    );
    const api = fakeApi();
    mounted = await mount(
      <SettingsSection
        deps={sessionDeps(api, fakeReader([paycoreRole]))}
        view={storeView()}
        config={config}
        configError=""
        onRetry={async () => undefined}
        onSaved={async () => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => !buttonNamed(container, 'Sign and save').disabled);
    await click(buttonNamed(container, 'Sign and save'));
    await settle(() => vi.mocked(api.storeEvents).mock.calls.length === 1);
    const [, authorization] = vi.mocked(api.storeEvents).mock.calls[0]?.[0] ?? [];
    expect(tagOf(authorization, 'd')).toBe(merchantKey);
    expect(tagOf(authorization, 'mode')).toBe('self-host');
  });

  it('asks for the replace consent again for another config', async () => {
    const real = secretKeySigner(OWNER_KEY);
    const signer = {
      ...real,
      decrypt: async () => {
        throw new Error('declined');
      },
    };
    const deps = sessionDeps(fakeApi(), fakeReader([]), signer);
    const render = (config: StoreConfig) => (
      <SettingsSection
        deps={deps}
        view={storeView()}
        config={config}
        configError=""
        onRetry={async () => undefined}
        onSaved={async () => undefined}
      />
    );
    mounted = await mount(render(configOf(signedConfig('Tea Shop', NOW - 100))));
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('could not be decrypted'));
    await settle(() => container.querySelector('input[type="checkbox"]') !== null);
    const consent = () => {
      const box = container.querySelector('input[type="checkbox"]');
      if (!(box instanceof HTMLInputElement)) {
        throw new Error('no consent box');
      }
      return box;
    };
    await click(consent());
    await settle(() => !buttonNamed(container, 'Sign and save').disabled);
    await mounted.rerender(render(configOf(signedConfig('Tea Shop 2', NOW - 50))));
    await settle(() => !consent().checked);
    expect(buttonNamed(container, 'Sign and save').disabled).toBe(true);
  });
});

describe('copy: removing deletes, hidden is a visibility', () => {
  it('names the removed group of a diff "Removed"', async () => {
    mounted = await mount(<DiffSummary diff={{ ...EMPTY_DIFF, hidden: ['mug'] }} />);
    expect(mounted.container.textContent).toContain('Removed: 1');
    expect(mounted.container.textContent).not.toContain('Hidden');
  });

  it('labels each row button with the product title', async () => {
    const items: CatalogItemInput[] = [
      { d: 'mug', title: 'Mug', price: { amount: '1', currency: 'USD' } },
    ];
    mounted = await mount(
      <ProductList items={items} onEdit={() => undefined} onRemove={() => undefined} />,
    );
    const labels = [...mounted.container.querySelectorAll('button')].map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Edit Mug', 'Remove Mug']);
  });
});

describe('the failed publish notice', () => {
  const MUG: CatalogItemInput = { d: 'mug', title: 'Mug', price: { amount: '1', currency: 'USD' } };
  const POT: CatalogItemInput = { d: 'pot', title: 'Pot', price: { amount: '2', currency: 'USD' } };

  async function publishOnce(nextState: 'failed' | 'done' | 'none') {
    const deps = sessionDeps(fakeApi(), fakeReader([listing(MUG), listing(POT)]));
    const section = (view: StoreView) => (
      <ProductsSection
        deps={deps}
        view={view}
        config={adminConfig()}
        reload={async () => undefined}
      />
    );
    mounted = await mount(section(storeView()));
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Pot'));
    const remove = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'Remove Pot',
    );
    if (remove === undefined) {
      throw new Error('no remove button');
    }
    await click(remove);
    await click(buttonNamed(container, 'Review changes'));
    await click(buttonNamed(container, 'Publish'));
    if (nextState === 'none') {
      return { container, section };
    }
    const ended =
      nextState === 'failed'
        ? storeView({ catalogSync: { state: 'failed', diff: EMPTY_DIFF, error: 'relay down' } })
        : storeView({ catalogSync: { state: 'done', diff: EMPTY_DIFF } });
    await mounted.rerender(section(ended));
    return { container, section };
  }

  it('does not claim a re-read that did not happen', async () => {
    const { container } = await publishOnce('failed');
    await settle(() => (container.textContent ?? '').includes('The last publish failed'));
    expect(container.textContent).toContain('is the one you tried to publish');
    expect(container.textContent).not.toContain('read again');
    expect(container.textContent).not.toContain('Pot');
  });

  it('says nothing while the publish has not ended', async () => {
    const { container } = await publishOnce('none');
    expect(container.textContent).toContain('Publishing started');
    expect(container.textContent).not.toContain('The last publish failed');
  });

  it('says nothing after a publish that went through', async () => {
    const { container, section } = await publishOnce('done');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).not.toContain('The last publish failed');
    // A later sync that fails (another publish, elsewhere) offers no stale list from this one.
    await mounted?.rerender(
      section(storeView({ catalogSync: { state: 'failed', diff: EMPTY_DIFF, error: 'later' } })),
    );
    expect(container.textContent).not.toContain('The last publish failed');
    expect(container.textContent).not.toContain('Restore the list');
  });
});

describe('the CSV import', () => {
  function choose(container: HTMLElement, files: { text: () => Promise<string>; size: number }) {
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('no file input');
    }
    Object.defineProperty(input, 'files', { value: [files], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input;
  }

  it('ignores a slow read of an earlier file that ends after a newer one', async () => {
    mounted = await mount(<CsvImport currency="USD" current={[]} onImport={() => undefined} />);
    const { container } = mounted;
    let finishSlow: (text: string) => void = () => undefined;
    await act(async () => {
      choose(container, {
        size: 10,
        text: () =>
          new Promise<string>((resolve) => {
            finishSlow = resolve;
          }),
      });
    });
    await act(async () => {
      choose(container, { size: 10, text: async () => 'd,title,price\nnew,New,1\n' });
    });
    await settle(() => (container.textContent ?? '').includes('1 product read'));
    await act(async () => {
      finishSlow('d,title,price\nold-a,A,1\nold-b,B,2\n');
    });
    expect(container.textContent).toContain('1 product read');
    expect(container.textContent).not.toContain('2 products read');
  });

  it('warns that a merge replaces a richer product whole, and resets the file field after use', async () => {
    const current: CatalogItemInput[] = [
      {
        d: 'pot',
        title: 'Pot',
        price: { amount: '30', currency: 'USD' },
        options: [{ name: 'Size', values: ['S'] }],
        variants: [{ id: 'pot-s', price: '30', available: true, values: ['S'] }],
      },
    ];
    const onImport = vi.fn();
    mounted = await mount(<CsvImport currency="USD" current={current} onImport={onImport} />);
    const { container } = mounted;
    let input: HTMLInputElement | undefined;
    await act(async () => {
      input = choose(container, { size: 10, text: async () => 'd,title,price\npot,Pot,30\n' });
    });
    await settle(() => (container.textContent ?? '').includes('1 product read'));
    expect(container.textContent).toContain('replaces a product');
    expect(container.textContent).toContain('pot');
    const cleared = vi.fn();
    if (input !== undefined) {
      Object.defineProperty(input, 'value', { set: cleared, configurable: true });
    }
    await click(buttonNamed(container, 'Use these 1 products'));
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(cleared).toHaveBeenCalledWith('');
  });
});

describe('the extension signer', () => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const TEMPLATE: EventTemplate = { kind: 27235, created_at: NOW, tags: [['u', 'x']], content: '' };

  function provider(sign: (template: EventTemplate) => EventTemplate): Nip07Provider {
    return {
      getPublicKey: async () => pubkey,
      signEvent: async (template) => finalizeEvent(sign(template), key),
      nip44: NIP44_STUB,
    };
  }

  it.each([
    [
      'another date',
      (template: EventTemplate) => ({ ...template, created_at: template.created_at + 1 }),
    ],
    ['other tags', (template: EventTemplate) => ({ ...template, tags: [['u', 'y']] })],
    ['other content', (template: EventTemplate) => ({ ...template, content: 'x' })],
  ])('refuses an event signed with %s than asked', async (_what, change) => {
    const signer = await extensionSigner(provider(change));
    await expect(signer.signEvent(TEMPLATE)).rejects.toThrow('not signed by your key');
  });

  it('refuses at sign-in an extension without NIP-44, in plain words', async () => {
    const onSigner = vi.fn();
    const without: Nip07Provider = {
      getPublicKey: async () => pubkey,
      signEvent: async (template) => finalizeEvent(template, key),
    };
    mounted = await mount(<SignIn onSigner={onSigner} findExtension={() => without} />);
    await click(buttonNamed(mounted.container, 'Sign in with a browser extension'));
    await settle(() => (mounted?.container.textContent ?? '').includes('does not support NIP-44'));
    expect(onSigner).not.toHaveBeenCalled();
  });
});

describe('keys and policy keys', () => {
  it('offers no 30497 revoke for a key holding only the Pay Core role', async () => {
    const storeKey = getPublicKey(generateSecretKey());
    const paycoreRole = finalizeEvent(
      {
        ...buildStoreAuthEvent({ storePubkey: storeKey, mode: 'self-host' }),
        created_at: NOW - 50,
      },
      OWNER_KEY,
    );
    const serverAuth = finalizeEvent(
      { ...buildCatalogAuth({ key: SERVER_KEY, mode: 'hosted' }), created_at: NOW - 50 },
      OWNER_KEY,
    );
    mounted = await mount(
      <CatalogKeys
        deps={sessionDeps(fakeApi(), fakeReader([paycoreRole, serverAuth]))}
        view={storeView()}
        config={undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes(npubOf(storeKey)));
    const rows = [...container.querySelectorAll('li')];
    const paycoreRow = rows.find((row) => (row.textContent ?? '').includes(npubOf(storeKey)));
    expect(paycoreRow?.textContent).toContain('Pay Core store key');
    expect(paycoreRow?.querySelector('button')).toBeNull();
    const serverRow = rows.find((row) => (row.textContent ?? '').includes(npubOf(SERVER_KEY)));
    expect(serverRow?.querySelector('button')?.textContent).toBe('Revoke');
  });

  it('drops a kept policy key when the Pay Core store key changes', async () => {
    const first = getPublicKey(generateSecretKey());
    const second = getPublicKey(generateSecretKey());
    const merchant = getPublicKey(generateSecretKey());
    const config = configOf(
      finalizeEvent(
        buildConfigEvent(
          {
            assistant: ASSISTANT,
            origins: ['https://tea.example'],
            name: 'Tea Shop',
            language: 'en',
            currency: 'USD',
            source: { kind: 'paycore' },
            catalogKey: first,
            policyKey: merchant,
          },
          OWNER_KEY,
        ),
        OWNER_KEY,
      ),
    );
    const form = formOfConfig(config, PRIVATE_PART);
    const sign = async (paycoreKey: string) => {
      const [event] = await signStoreEvents({
        form: { ...form, paycoreKey },
        keys: { assistant: ASSISTANT, serverKey: SERVER_KEY },
        signer: secretKeySigner(OWNER_KEY),
        now: NOW,
      });
      return tagOf(event, 'policy-key');
    };
    expect(await sign(first)).toBe(merchant);
    expect(await sign(second)).toBe(SERVER_KEY);
  });
});

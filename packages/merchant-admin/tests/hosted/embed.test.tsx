import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeProductNaddr } from '@elisym/commerce';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BAD_DOMAIN,
  CUSTOMER_REF,
  NOT_CHECKED,
  NO_DOMAIN,
  STRICT_ORIGIN,
} from '../../src/hosted/components/DomainGuide';
import { EmbedTab, NOTHING_ON_SALE } from '../../src/hosted/components/EmbedTab';
import { ApiError } from '../../src/hosted/lib/api';
import {
  domainGuide,
  embedSnippet,
  escapeAttribute,
  productNaddr,
} from '../../src/hosted/lib/embed';
import { V3_LOADER_INTEGRITY, V3_LOADER_SRC } from '../../src/hosted/lib/embed-constants';
import { errorMessage } from '../../src/hosted/lib/errors';
import type { StoreApi } from '../../src/hosted/lib/store-session';
import type { ProductRecord, StoreView } from '../../src/hosted/lib/types';
import { type Mounted, mount, settle } from '../mount';
import { OWNER, STORE_PUBKEY, storeView } from './fakes';
import { LEAK, NOW, RELAYS, fakeSession, storeConfig } from './store-fakes';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** Vitest runs from the package root (the DOM environment gives `import.meta.url` no file scheme). */
const REACT_CONSTANTS = join(process.cwd(), '../react/src/constants.ts');

/** A string constant as `@elisym/react` declares it. */
function reactConstant(name: string): string | undefined {
  const source = readFileSync(REACT_CONSTANTS, 'utf8');
  return source.match(new RegExp(`export const ${name} =\\s*'([^']+)';`))?.[1];
}

function product(d: string, title: string, onSale: boolean): ProductRecord {
  return { d, title, description: '', priceUsd: '1', onSale, updatedAt: NOW };
}

describe('the pinned loader', () => {
  it('is the one @elisym/react pins, URL and SRI hash', () => {
    expect(V3_LOADER_SRC).toBe(reactConstant('V3_LOADER_SRC'));
    expect(V3_LOADER_INTEGRITY).toBe(reactConstant('V3_LOADER_INTEGRITY'));
    expect(V3_LOADER_INTEGRITY).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
  });
});

describe('the snippet', () => {
  it('is the v3 tag with its SRI hash, as the landing and the widget docs print it', () => {
    expect(embedSnippet('naddr1abc', 'mainnet')).toBe(
      [
        '<elisym-buy product="naddr1abc" network="mainnet"></elisym-buy>',
        '<script',
        '  src="https://pay.elisym.network/v3/embed.js"',
        '  integrity="sha384-FPsJfAuhwQU0mlPKTKLwCTp1YGK6aFRh0pT+Gl1T3UML2jlIK7EkW8FW5ue2qFJX"',
        '  crossorigin="anonymous"',
        '></script>',
      ].join('\n'),
    );
  });

  it('escapes every interpolated value for an attribute', () => {
    expect(escapeAttribute(`a"b'c<d>e&f`)).toBe('a&quot;b&#39;c&lt;d&gt;e&amp;f');
    const snippet = embedSnippet('x" onclick="alert(1)', "devnet'<b>");
    expect(snippet.split('\n')[0]).toBe(
      '<elisym-buy product="x&quot; onclick=&quot;alert(1)" network="devnet&#39;&lt;b&gt;"></elisym-buy>',
    );
  });

  it('names the product by an naddr of the store key and d, hinting the live inbox relays', () => {
    const config = storeConfig({
      inboxRelays: ['wss://draft.example'],
      activeInboxRelays: [...RELAYS, 'wss://third.example'],
    });
    expect(decodeProductNaddr(productNaddr(STORE_PUBKEY, 'tea-1', config))).toEqual({
      storePubkey: STORE_PUBKEY,
      d: 'tea-1',
      relays: RELAYS,
    });
    const draftOnly = storeConfig({ inboxRelays: ['wss://draft.example'], activeInboxRelays: [] });
    expect(decodeProductNaddr(productNaddr(STORE_PUBKEY, 'tea-1', draftOnly))?.relays).toEqual([
      'wss://draft.example',
    ]);
  });
});

describe('the level A nostr.json', () => {
  it('names the store under the nip05 name and the owner under owner', () => {
    const guide = domainGuide('_@Shop.Example.com', STORE_PUBKEY, OWNER);
    expect(guide).toEqual({
      kind: 'nostr_json',
      domain: 'shop.example.com',
      local: '_',
      levelA: true,
      url: 'https://shop.example.com/.well-known/nostr.json',
      json: `{\n  "names": {\n    "_": "${STORE_PUBKEY}",\n    "owner": "${OWNER}"\n  }\n}`,
    });
    expect(domainGuide('shop.example.com', STORE_PUBKEY, OWNER)).toMatchObject({
      local: '_',
      levelA: true,
    });
  });

  it('says another name stays level C, and refuses the name owner', () => {
    expect(domainGuide('shop@example.com', STORE_PUBKEY, OWNER)).toMatchObject({
      kind: 'nostr_json',
      local: 'shop',
      levelA: false,
      json: `{\n  "names": {\n    "shop": "${STORE_PUBKEY}",\n    "owner": "${OWNER}"\n  }\n}`,
    });
    expect(domainGuide('owner@example.com', STORE_PUBKEY, OWNER)).toEqual({
      kind: 'owner_name',
      domain: 'example.com',
    });
  });

  it('has nothing to serve without a nip05, and says a broken one is broken', () => {
    expect(domainGuide(undefined, STORE_PUBKEY, OWNER)).toEqual({ kind: 'none' });
    expect(domainGuide('  ', STORE_PUBKEY, OWNER)).toEqual({ kind: 'none' });
    expect(domainGuide('shop@localhost', STORE_PUBKEY, OWNER)).toEqual({ kind: 'invalid' });
  });
});

describe('the Embed tab', () => {
  async function open(view: StoreView, overrides: Partial<StoreApi> = {}) {
    const fake = fakeSession(overrides);
    mounted = await mount(
      <EmbedTab session={fake.session} view={view} onChanged={() => undefined} />,
    );
    return mounted.container;
  }

  function shown(container: HTMLElement, id: string): string {
    return container.querySelector(`#${id}`)?.textContent ?? '';
  }

  const VIEW = storeView({
    status: 'active',
    config: storeConfig({
      nip05: '_@shop.example.com',
      network: 'devnet',
      activeInboxRelays: RELAYS,
    }),
  });

  it('shows the snippet of a product on sale, chosen from the list, and the exact nostr.json', async () => {
    const container = await open(VIEW, {
      products: async () => ({
        products: [
          product('off', 'Off', false),
          product('tea', 'Tea', true),
          product('mug', 'Mug', true),
        ],
      }),
    });
    await settle(() => container.querySelector('#embed-snippet') !== null);
    const select = container.querySelector('#embed-product');
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('no product select');
    }
    expect([...select.options].map((option) => option.value)).toEqual(['tea', 'mug']);
    const config = VIEW.config ?? storeConfig();
    expect(shown(container, 'embed-snippet')).toBe(
      embedSnippet(productNaddr(STORE_PUBKEY, 'tea', config), 'devnet'),
    );
    await act(async () => {
      select.value = 'mug';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(shown(container, 'embed-snippet')).toBe(
      embedSnippet(productNaddr(STORE_PUBKEY, 'mug', config), 'devnet'),
    );
    expect(shown(container, 'embed-nostr-json')).toBe(
      `{\n  "names": {\n    "_": "${STORE_PUBKEY}",\n    "owner": "${OWNER}"\n  }\n}`,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('https://shop.example.com/.well-known/nostr.json');
    expect(text).toContain('Access-Control-Allow-Origin: *');
    expect(text).toContain('Verified: shop.example.com');
    for (const sentence of [NOT_CHECKED, STRICT_ORIGIN, CUSTOMER_REF]) {
      expect(text).toContain(sentence);
    }
  });

  it('asks for a product on sale first', async () => {
    const container = await open(VIEW, {
      products: async () => ({ products: [product('off', 'Off', false)] }),
    });
    await settle(() => (container.textContent ?? '').includes(NOTHING_ON_SALE));
    expect(container.querySelector('#embed-snippet')).toBeNull();
  });

  it('says level C without a domain, and level C under a name other than _', async () => {
    const bare = await open(storeView({ config: storeConfig() }));
    await settle(() => (bare.textContent ?? '').includes(NO_DOMAIN));
    expect(bare.querySelector('#embed-nostr-json')).toBeNull();
    await mounted?.unmount();
    const named = await open(storeView({ config: storeConfig({ nip05: 'shop@example.com' }) }));
    await settle(() => named.querySelector('#embed-nostr-json') !== null);
    expect(named.textContent).toContain(
      'Only the domain-wide name _ gives level A: as shop@example.com the store stays level C.',
    );
    expect(named.textContent).not.toContain('Verified:');
  });

  it('flags a broken address and the reserved name owner', async () => {
    const broken = await open(storeView({ config: storeConfig({ nip05: 'not a domain' }) }));
    await settle(() => (broken.textContent ?? '').includes(BAD_DOMAIN));
    await mounted?.unmount();
    const owner = await open(storeView({ config: storeConfig({ nip05: 'owner@example.com' }) }));
    await settle(() => (owner.textContent ?? '').includes('_@example.com in Settings'));
    expect(owner.querySelector('#embed-nostr-json')).toBeNull();
  });

  it('shows a failed products read in its fixed sentence', async () => {
    const container = await open(VIEW, {
      products: async () => {
        throw new ApiError(500, 'internal', { error: 'internal', problem: LEAK });
      },
    });
    await settle(() =>
      (container.textContent ?? '').includes(errorMessage(new ApiError(500, 'internal'))),
    );
    expect(container.textContent).not.toContain('SECRET');
  });
});

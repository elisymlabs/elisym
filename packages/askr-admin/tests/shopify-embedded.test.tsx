import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  KIND_CATALOG_AUTH,
  KIND_CONFIG_DELEGATION,
  buildConfigEvent,
  parseConfig,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_BRIDGE_URL, shopifyHtmlProblems, storageProblems } from '../scripts/build-checks';
import { ShopifyApi } from '../src/shopify/api';
import { appApiKey, sessionToken, shopOf, themeEditorUrl } from '../src/shopify/bridge';
import { ShopifyApp } from '../src/shopify/ShopifyApp';
import { buttonNamed, type Mounted, mount, settle } from './mount';

const BASE = 'https://app.askr.test';
const SHOP = 'tea.myshopify.com';
const NOW = 1_800_000_000;
/** A config as the settings read returns it, for tests that need one without signing. */
const SETTINGS_CONFIG = {
  owner: 'a'.repeat(64),
  assistant: 'b'.repeat(64),
  origins: ['https://tea.example'],
  linkOrigins: [],
  name: 'Tea House',
  language: 'en',
  currency: 'EUR',
  source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
  catalogKey: 'c'.repeat(64),
  policyKey: 'c'.repeat(64),
  privateContent: '',
  createdAt: NOW,
};

interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

/** The server's `/v1/shopify/` routes in memory, enough for the embedded admin. */
function fakeServer() {
  const calls: Call[] = [];
  const catalogKey = getPublicKey(generateSecretKey());
  const delegate = getPublicKey(generateSecretKey());
  const state = {
    onboarded: false,
    owner: '',
    finishError: undefined as string | undefined,
    inCharge: true,
    saved: undefined as unknown,
    settings: undefined as unknown,
    status: 'pending',
    tier: null as string | null,
    stillOnboarding: false,
    storeFails: false,
    saveError: undefined as string | undefined,
  };
  const view = () => ({
    shop: SHOP,
    onboarded: state.onboarded,
    store: state.onboarded
      ? {
          owner: state.owner,
          npub: 'npub1store',
          onboarding: state.stillOnboarding,
          status: state.status,
          tier: state.tier,
          connector: null,
          delegation: { active: true, inCharge: state.inCharge },
        }
      : null,
  });
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const text = typeof init?.body === 'string' ? init.body : '';
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      headers: new Headers(init?.headers),
      body: text === '' ? undefined : JSON.parse(text),
    };
    calls.push(call);
    const route = `${call.method} ${call.path}`;
    if (route === 'GET /v1/shopify/time') {
      return reply({ now: NOW });
    }
    if (route === 'GET /v1/shopify/store') {
      return state.storeFails ? reply({ error: 'shopify_refused' }, 502) : reply(view());
    }
    if (route === 'POST /v1/shopify/onboard/begin') {
      return reply({ catalogKey, delegate, now: NOW });
    }
    if (route === 'POST /v1/shopify/onboard/finish') {
      if (state.finishError !== undefined) {
        return reply({ error: state.finishError }, 409);
      }
      const events = (call.body as { events: NostrEvent[] }).events;
      state.owner = events[0]?.pubkey ?? '';
      state.onboarded = true;
      return reply(view());
    }
    if (route === 'POST /v1/shopify/plan/free') {
      state.status = 'active';
      state.tier = 'free';
      return reply({ ...view(), activation: 'activated' });
    }
    if (route === 'GET /v1/shopify/settings') {
      return reply(state.settings);
    }
    if (route === 'PUT /v1/shopify/settings') {
      if (state.saveError !== undefined) {
        return reply({ error: state.saveError }, 400);
      }
      state.saved = call.body;
      return reply({ saved: true });
    }
    return reply({ error: 'not_found' }, 404);
  };
  let tokens = 0;
  const api = new ShopifyApi({
    token: () => {
      tokens += 1;
      return Promise.resolve(`token-${tokens}`);
    },
    base: BASE,
    fetch: fetcher,
  });
  return { api, calls, state, catalogKey, delegate };
}

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('the embedded admin onboarding (askr-shopify 3.3, 5.1)', () => {
  it('makes O here, signs at the server clock, and finishes only after the backup tick', async () => {
    const server = fakeServer();
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Set up Askr for'));
    await act(async () => buttonNamed(container, 'Set up Askr').click());
    await settle(() => text(container).includes('Save your owner key'));
    const begin = server.calls.find((call) => call.path === '/v1/shopify/onboard/begin');
    expect(begin?.body).toEqual({ shop: SHOP });
    expect(begin?.headers.get('authorization')).toMatch(/^Bearer token-/);
    const ownerAuth = begin?.headers.get('x-askr-owner-authorization') ?? '';
    const proof = JSON.parse(atob(ownerAuth.replace(/^Nostr /, ''))) as NostrEvent;
    expect(verifyEvent(proof)).toBe(true);
    // Dated by the server's clock, not this device's.
    expect(proof.created_at).toBe(NOW);
    expect(proof.tags).toContainEqual(['u', `${BASE}/v1/shopify/onboard/begin`]);
    const finish = buttonNamed(container, 'Finish setup');
    expect(finish.disabled).toBe(true);
    expect(text(container)).toContain('nsec1');
    const tick = container.querySelector('input[type="checkbox"]');
    if (!(tick instanceof HTMLInputElement)) {
      throw new Error('no tick');
    }
    await act(async () => tick.click());
    expect(buttonNamed(container, 'Finish setup').disabled).toBe(false);
    await act(async () => buttonNamed(container, 'Finish setup').click());
    await settle(() => text(container).includes('Overview'));
    const finished = server.calls.find((call) => call.path === '/v1/shopify/onboard/finish');
    if (finished === undefined) {
      throw new Error('no finish call');
    }
    const events = (finished.body as { events: NostrEvent[] }).events;
    expect(events.map((event) => [event.kind, event.created_at, event.pubkey])).toEqual([
      [KIND_CATALOG_AUTH, NOW, proof.pubkey],
      [KIND_CONFIG_DELEGATION, NOW, proof.pubkey],
    ]);
    expect(events[0]?.tags).toContainEqual(['d', server.catalogKey]);
    expect(events[1]?.tags).toContainEqual(['d', server.delegate]);
    expect(events.every((event) => verifyEvent(event))).toBe(true);
    // O is gone from the page once finished.
    expect(text(container)).not.toContain('nsec1');
  });

  it('starts over with a new key when the setup was replaced', async () => {
    const server = fakeServer();
    server.state.finishError = 'onboarding_replaced';
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Set up Askr for'));
    await act(async () => buttonNamed(container, 'Set up Askr').click());
    await settle(() => text(container).includes('Save your owner key'));
    const tick = container.querySelector('input[type="checkbox"]');
    await act(async () => (tick as HTMLInputElement).click());
    await act(async () => buttonNamed(container, 'Finish setup').click());
    await settle(() => text(container).includes('replaced or expired'));
    expect(text(container)).toContain('Set up Askr for');
    expect(text(container)).not.toContain('nsec1');
  });
});

describe('the embedded settings (askr-shopify 3.4)', () => {
  function configured(server: ReturnType<typeof fakeServer>, inCharge: boolean) {
    const signer = generateSecretKey();
    const event = buildConfigEvent(
      {
        assistant: getPublicKey(generateSecretKey()),
        origins: ['https://tea.example', `https://${SHOP}`],
        name: 'Tea House',
        language: 'de',
        currency: 'EUR',
        greeting: 'Hallo',
        displayName: 'Tea',
        contact: 'https://tea.example/contact',
        linkOrigins: ['https://blog.tea.example'],
        source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
        catalogKey: server.catalogKey,
        createdAt: NOW,
      },
      signer,
    );
    server.state.onboarded = true;
    server.state.inCharge = inCharge;
    server.state.settings = {
      config: parseConfig({ ...event, pubkey: getPublicKey(signer) }),
      private: { voice: 'warm', instructions: 'Be brief', notes: '' },
      inCharge,
    };
  }

  it('loads the settings and saves them without any key or source', async () => {
    const server = fakeServer();
    configured(server, true);
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Overview'));
    await act(async () => buttonNamed(container, 'Settings').click());
    await settle(() => buttonNamed(container, 'Save') !== undefined);
    await act(async () => buttonNamed(container, 'Save').click());
    await settle(() => server.state.saved !== undefined);
    expect(server.state.saved).toEqual({
      origins: ['https://tea.example', `https://${SHOP}`],
      linkOrigins: ['https://blog.tea.example'],
      name: 'Tea House',
      language: 'de',
      currency: 'EUR',
      greeting: 'Hallo',
      contact: 'https://tea.example/contact',
      displayName: 'Tea',
      private: { voice: 'warm', instructions: 'Be brief', notes: '' },
    });
  });

  it('shows the settings read only once the merchant manages the store with O', async () => {
    const server = fakeServer();
    configured(server, false);
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Overview'));
    expect(text(container)).toContain('own owner key');
    await act(async () => buttonNamed(container, 'Settings').click());
    await settle(() => text(container).includes('read only here'));
    expect(
      [...container.querySelectorAll('button')].map((button) => button.textContent),
    ).not.toContain('Save');
    expect(
      [...container.querySelectorAll('input, textarea')].every(
        (field) => (field as HTMLInputElement).disabled,
      ),
    ).toBe(true);
  });
});

describe('the embedded page helpers (askr-shopify 5.1)', () => {
  it('reads the shop, the client id and session tokens from Shopify only', async () => {
    expect(shopOf({ search: `?shop=${SHOP}&host=abc` })).toBe(SHOP);
    expect(shopOf({ search: '?shop=evil.example' })).toBeUndefined();
    expect(shopOf({ search: '' })).toBeUndefined();
    const doc = document.implementation.createHTMLDocument('page');
    const meta = doc.createElement('meta');
    meta.name = 'shopify-api-key';
    meta.content = 'client-id';
    doc.head.append(meta);
    expect(appApiKey(doc)).toBe('client-id');
    expect(themeEditorUrl(SHOP, 'client-id')).toBe(
      'https://admin.shopify.com/store/tea/themes/current/editor?context=apps&activateAppId=client-id/app-embed',
    );
    await expect(sessionToken()).rejects.toThrow(/inside Shopify/);
    Reflect.set(globalThis, 'shopify', { idToken: () => Promise.resolve('jwt') });
    try {
      expect(await sessionToken()).toBe('jwt');
    } finally {
      Reflect.deleteProperty(globalThis, 'shopify');
    }
  });

  it('checks the built embedded page: App Bridge first, a key placeholder, no storage', () => {
    const page = (head: string) =>
      `<html><head>${head}<meta name="shopify-api-key" content="__ASKR_SHOPIFY_API_KEY__" /><script type="module" src="/admin/assets/shopify-1.js"></script></head></html>`;
    expect(shopifyHtmlProblems(page(`<script src="${APP_BRIDGE_URL}"></script>`))).toEqual([]);
    expect(shopifyHtmlProblems(page(''))).toContain('App Bridge is not the first plain <script>');
    expect(shopifyHtmlProblems(page(`<script async src="${APP_BRIDGE_URL}"></script>`))).toContain(
      'App Bridge is not the first plain <script>',
    );
    expect(
      shopifyHtmlProblems(
        `<script src="${APP_BRIDGE_URL}"></script><script src="https://evil.example/x.js"></script>`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'the shopify-api-key meta has no placeholder for the server to fill',
        'loads https://evil.example/x.js, which is not under /admin/',
      ]),
    );
    const chunks = new Map([
      ['assets/shopify-1.js', 'import{a}from"./shared-2.js";'],
      ['assets/shared-2.js', 'export const a = globalThis.localStorage;'],
      ['assets/admin-3.js', 'localStorage.setItem("k","v")'],
    ]);
    const html = page(`<script src="${APP_BRIDGE_URL}"></script>`);
    expect(storageProblems(html, chunks)).toEqual([
      'assets/shared-2.js, loaded by the embedded admin, touches browser storage',
    ]);
    chunks.set('assets/shared-2.js', 'export const a = 1;');
    expect(storageProblems(html, chunks)).toEqual([]);
  });

  it('keeps the embedded admin source off browser storage and the remembered-key modules', () => {
    const dir = join(__dirname, '../src/shopify');
    const files = readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8'));
    expect(files.filter((code) => /localStorage|sessionStorage|indexedDB/.test(code))).toEqual([]);
    expect(files.filter((code) => /remembered|tab-session|journal/.test(code))).toEqual([]);
  });
});

describe('the embedded plan (askr-shopify 3.6)', () => {
  it('starts a pending store on Free and shows the plan', async () => {
    const server = fakeServer();
    server.state.onboarded = true;
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Start on Free'));
    expect(text(container)).toContain('Choose a plan to turn it on');
    await act(async () => buttonNamed(container, 'Start on Free').click());
    await settle(() => text(container).includes('Plan: free'));
    expect(text(container)).toContain('Your assistant is live');
    expect(server.calls.filter((call) => call.path === '/v1/shopify/plan/free')).toHaveLength(1);
  });
});

describe('embedded admin review round (askr-shopify phase 3)', () => {
  it('signs the NIP-98 payload over the exact body and asks a token per call', async () => {
    const server = fakeServer();
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Set up Askr for'));
    await act(async () => buttonNamed(container, 'Set up Askr').click());
    await settle(() => text(container).includes('Save your owner key'));
    const begin = server.calls.find((call) => call.path === '/v1/shopify/onboard/begin');
    const proof = JSON.parse(
      atob((begin?.headers.get('x-askr-owner-authorization') ?? '').replace(/^Nostr /, '')),
    ) as NostrEvent;
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(begin?.body)),
    );
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(proof.tags).toContainEqual(['payload', hex]);
    const tokens = server.calls.map((call) => call.headers.get('authorization'));
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('starts a new key unticked after a replaced setup', async () => {
    const server = fakeServer();
    server.state.finishError = 'onboarding_replaced';
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Set up Askr for'));
    await act(async () => buttonNamed(container, 'Set up Askr').click());
    await settle(() => text(container).includes('Save your owner key'));
    await act(async () =>
      (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
    );
    await act(async () => buttonNamed(container, 'Finish setup').click());
    await settle(() => text(container).includes('Set up Askr for'));
    server.state.finishError = undefined;
    await act(async () => buttonNamed(container, 'Set up Askr').click());
    await settle(() => text(container).includes('Save your owner key'));
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      false,
    );
    expect(buttonNamed(container, 'Finish setup').disabled).toBe(true);
  });

  it('drops the key and shows the store when another staff member finished first', async () => {
    const server = fakeServer();
    server.state.finishError = 'onboarded';
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Set up Askr for'));
    await act(async () => buttonNamed(container, 'Set up Askr').click());
    await settle(() => text(container).includes('Save your owner key'));
    server.state.onboarded = true;
    await act(async () =>
      (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
    );
    await act(async () => buttonNamed(container, 'Finish setup').click());
    await settle(() => text(container).includes('Overview'));
    expect(text(container)).not.toContain('nsec1');
  });

  it('starts again when the setup expired before finishing', async () => {
    const server = fakeServer();
    server.state.finishError = 'not_onboarding';
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Set up Askr for'));
    await act(async () => buttonNamed(container, 'Set up Askr').click());
    await settle(() => text(container).includes('Save your owner key'));
    await act(async () =>
      (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
    );
    await act(async () => buttonNamed(container, 'Finish setup').click());
    await settle(() => text(container).includes('not your store key'));
    expect(text(container)).not.toContain('nsec1');
  });

  it('upper-cases the currency on save', async () => {
    const server = fakeServer();
    server.state.onboarded = true;
    server.state.settings = {
      config: { ...SETTINGS_CONFIG, currency: 'eur' },
      private: null,
      inCharge: true,
    };
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Overview'));
    await act(async () => buttonNamed(container, 'Settings').click());
    await settle(() =>
      [...container.querySelectorAll('button')].some((b) => b.textContent === 'Save'),
    );
    await act(async () => buttonNamed(container, 'Save').click());
    await settle(() => server.state.saved !== undefined);
    expect((server.state.saved as { currency: string }).currency).toBe('EUR');
  });

  it('shows onboarding, not the overview, for a store still being set up', async () => {
    const server = fakeServer();
    server.state.onboarded = true;
    server.state.stillOnboarding = true;
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Set up Askr for'));
    expect(text(container)).not.toContain('Overview');
  });

  it('refuses an answer without a clock and an empty session token', async () => {
    const api = new ShopifyApi({
      token: () => Promise.resolve('t'),
      base: BASE,
      fetch: async () => new Response(JSON.stringify({ now: 'soon' }), { status: 200 }),
    });
    await expect(api.time()).rejects.toThrow();
    Reflect.set(globalThis, 'shopify', { idToken: () => Promise.resolve('') });
    try {
      await expect(sessionToken()).rejects.toThrow(/no session/);
    } finally {
      Reflect.deleteProperty(globalThis, 'shopify');
    }
  });

  it('flags every kind of browser storage and a page with no chunk to check', () => {
    const html = `<script type="module" src="/admin/assets/e.js"></script>`;
    for (const code of ['sessionStorage.x', 'indexedDB.open()', 'localStorage.y']) {
      expect(storageProblems(html, new Map([['assets/e.js', code]]))).toHaveLength(1);
    }
    expect(storageProblems('<html></html>', new Map())).toEqual([
      'the embedded page loads no chunk under /admin/assets/: nothing was checked',
    ]);
    expect(storageProblems(html, new Map())).toEqual([
      'assets/e.js, loaded by the embedded admin, is not in the build',
    ]);
  });
});

describe('embedded admin confirm round (askr-shopify phase 3)', () => {
  it('drops the key of a store finished elsewhere even when the reload fails', async () => {
    const server = fakeServer();
    server.state.finishError = 'onboarded';
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Set up Askr for'));
    await act(async () => buttonNamed(container, 'Set up Askr').click());
    await settle(() => text(container).includes('Save your owner key'));
    server.state.storeFails = true;
    await act(async () =>
      (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
    );
    await act(async () => buttonNamed(container, 'Finish setup').click());
    await settle(() => !text(container).includes('Save your owner key'));
    expect(text(container)).not.toContain('nsec1');
    expect(text(container)).toContain('Shopify did not answer');
  });

  it('says how to write a domain, and how many fit, when a save is refused', async () => {
    for (const [code, words] of [
      ['bad_settings', 'full https address'],
      ['too_many_origins', '18 more at most'],
    ] as const) {
      const server = fakeServer();
      server.state.onboarded = true;
      server.state.saveError = code;
      server.state.settings = { config: SETTINGS_CONFIG, private: null, inCharge: true };
      mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
      const container = mounted.container;
      await settle(() => text(container).includes('Overview'));
      await act(async () => buttonNamed(container, 'Settings').click());
      await settle(() =>
        [...container.querySelectorAll('button')].some((button) => button.textContent === 'Save'),
      );
      await act(async () => buttonNamed(container, 'Save').click());
      await settle(() => text(container).includes(words));
      await mounted.unmount();
      mounted = undefined;
    }
  });
});

describe('the embedded plan, a paused store (phase 4 review)', () => {
  it('offers no Free start for a suspended store and says it is paused', async () => {
    const server = fakeServer();
    server.state.onboarded = true;
    server.state.status = 'suspended';
    server.state.tier = 'free';
    mounted = await mount(<ShopifyApp api={server.api} shop={SHOP} apiKey="key" />);
    const container = mounted.container;
    await settle(() => text(container).includes('Plan: free'));
    expect(text(container)).toContain('(paused)');
    expect(text(container)).not.toContain('Start on Free');
  });
});

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
  };
  const view = () => ({
    shop: SHOP,
    onboarded: state.onboarded,
    store: state.onboarded
      ? {
          owner: state.owner,
          npub: 'npub1store',
          onboarding: false,
          status: 'pending',
          tier: null,
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
      return reply(view());
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
    if (route === 'GET /v1/shopify/settings') {
      return reply(state.settings);
    }
    if (route === 'PUT /v1/shopify/settings') {
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
    const events = (finished?.body as { events: NostrEvent[] }).events;
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
      linkOrigins: [],
      name: 'Tea House',
      language: 'de',
      currency: 'EUR',
      greeting: 'Hallo',
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

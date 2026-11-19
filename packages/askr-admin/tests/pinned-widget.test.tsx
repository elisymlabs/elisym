import { afterEach, describe, expect, it, vi } from 'vitest';
import { widgetBundle } from '../../askr-server/src/gateway/widget';
import { EmbedSection } from '../src/components/EmbedSection';
import { AdminApi } from '../src/lib/api';
import { ADD_TO_CART_SNIPPET, pinnedScriptSnippet, scriptSnippet } from '../src/lib/embed';
import { npubOf, secretKeySigner } from '../src/lib/signer';
import { OWNER, OWNER_KEY, PINNED_WIDGET, adminConfig, storeView } from './fakes';
import { type Mounted, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const BASE = 'https://api.askr.example';

function apiAnswering(answer: () => Response, seen: RequestInit[] = []): AdminApi {
  return new AdminApi({
    signer: secretKeySigner(OWNER_KEY),
    base: BASE,
    fetch: async (input, init) => {
      expect(String(input)).toBe(`${BASE}/v1/widget`);
      seen.push(init ?? {});
      return answer();
    },
  });
}

describe('the pinned widget the server serves', () => {
  it('is read unsigned, so an extension is never asked for it, and as the server describes it', async () => {
    const bundle = widgetBundle('/* widget */');
    const seen: RequestInit[] = [];
    const api = apiAnswering(
      () =>
        new Response(JSON.stringify({ path: bundle.path, integrity: bundle.integrity }), {
          status: 200,
        }),
      seen,
    );
    // Addressed on the host it was read from, which is the server that has this bundle.
    expect(await api.pinnedWidget()).toEqual({
      src: `${BASE}${bundle.path}`,
      integrity: bundle.integrity,
    });
    expect(new Headers(seen[0]?.headers).get('authorization')).toBeNull();
    expect(seen[0]?.cache).toBe('no-store');
  });

  it('refuses an answer that is not a pinned path and a SHA-384 integrity', async () => {
    const bundle = widgetBundle('/* widget */');
    const answers = [
      { path: '/widget.js', integrity: bundle.integrity },
      { path: `https://evil.example${bundle.path}`, integrity: bundle.integrity },
      { path: `${bundle.path}?x=1`, integrity: bundle.integrity },
      { path: `/widget/${bundle.id}.js" onload="alert(1)`, integrity: bundle.integrity },
      { path: `/widget/x" onload="alert(1)`, integrity: bundle.integrity },
      { path: '/widget/abc.js', integrity: bundle.integrity },
      { path: `/widget/${bundle.id.toUpperCase()}.js`, integrity: bundle.integrity },
      { path: `/widget/${bundle.id.slice(1)}.js`, integrity: bundle.integrity },
      { path: `/widget/${bundle.id}0.js`, integrity: bundle.integrity },
      { path: `/widget/${bundle.id}.mjs`, integrity: bundle.integrity },
      { path: `/widgets/${bundle.id}.js`, integrity: bundle.integrity },
      { path: `/x/widget/${bundle.id}.js`, integrity: bundle.integrity },
      { path: `/widget/${bundle.id}.js\n`, integrity: bundle.integrity },
      { path: bundle.path, integrity: bundle.integrity.replace('sha384-', 'sha256-') },
      { path: bundle.path, integrity: `${bundle.integrity}" onload="alert(1)` },
      { path: bundle.path },
      'nonsense',
    ];
    for (const answer of answers) {
      const api = apiAnswering(() => new Response(JSON.stringify(answer), { status: 200 }));
      await expect(api.pinnedWidget()).rejects.toMatchObject({ code: 'unexpected' });
    }
    const missing = apiAnswering(() => new Response('{}', { status: 404 }));
    await expect(missing.pinnedWidget()).rejects.toMatchObject({ code: 'unexpected', status: 404 });
    const offline = new AdminApi({
      signer: secretKeySigner(OWNER_KEY),
      base: BASE,
      fetch: async () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(offline.pinnedWidget()).rejects.toMatchObject({ code: 'network' });
  });

  it('escapes every attribute value of the pinned snippet, whatever it is given', () => {
    const snippet = pinnedScriptSnippet('npub1"x', {
      src: 'https://a.example/widget/x" onload="alert(1)&<b>',
      integrity: 'sha384-"><script>',
    });
    expect(snippet).toBe(
      '<script src="https://a.example/widget/x&quot; onload=&quot;alert(1)&amp;&lt;b&gt;" integrity="sha384-&quot;&gt;&lt;script&gt;" crossorigin="anonymous" data-store="npub1&quot;x" async></script>',
    );
  });

  it('the pinned snippet names the exact bundle with its integrity, loaded anonymously', () => {
    const npub = npubOf(OWNER);
    expect(pinnedScriptSnippet(npub, PINNED_WIDGET)).toBe(
      `<script src="${PINNED_WIDGET.src}" integrity="${PINNED_WIDGET.integrity}" crossorigin="anonymous" data-store="${npub}" async></script>`,
    );
  });
});

describe('the embed section', () => {
  it('offers the auto-updating snippet and the pinned one, and says what pinning trades', async () => {
    const api = { pinnedWidget: vi.fn(async () => PINNED_WIDGET) };
    mounted = await mount(<EmbedSection api={api} view={storeView()} config={adminConfig()} />);
    const { container } = mounted;
    const npub = npubOf(OWNER);
    await settle(() =>
      (container.textContent ?? '').includes(pinnedScriptSnippet(npub, PINNED_WIDGET)),
    );
    expect(container.textContent).toContain(scriptSnippet(npub));
    expect(container.textContent).toContain('never changes under you');
    expect(container.textContent).toContain('paste a newer snippet');
    expect(container.textContent).toContain('script-src');
  });

  it('keeps the auto-updating snippet when the pinned version cannot be read', async () => {
    const api = { pinnedWidget: vi.fn(async () => Promise.reject(new Error('offline'))) };
    mounted = await mount(<EmbedSection api={api} view={storeView()} config={undefined} />);
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('could not be read'));
    expect(container.textContent).toContain(scriptSnippet(npubOf(OWNER)));
    expect(container.textContent).not.toContain('integrity=');
  });
});

describe('the embed section for a merchant', () => {
  const API = { pinnedWidget: async () => PINNED_WIDGET };
  const connectorSource = (platform: 'shopify' | 'woocommerce' | 'google', shopUrl?: string) =>
    adminConfig({
      source: { kind: 'connector', platform, ...(shopUrl === undefined ? {} : { shopUrl }) },
    });

  async function mountWith(view = storeView(), config = adminConfig()) {
    mounted = await mount(<EmbedSection api={API} view={view} config={config} />);
    return mounted.container;
  }

  it('says what a pending store shows and to reload once activated, and what a suspended one shows', async () => {
    const pending = await mountWith(storeView({ status: 'pending' }));
    expect(pending.textContent).toContain('The assistant is not set up for this store');
    expect(pending.textContent).toContain('reload');
    await mounted?.unmount();
    const suspended = await mountWith(storeView({ status: 'suspended' }));
    expect(suspended.textContent).toContain('suspended');
    expect(suspended.textContent).toContain('the chat says the assistant is unavailable');
    expect(suspended.textContent).toContain('reactivate');
    expect(suspended.textContent).not.toContain('not set up for this store');
    await mounted?.unmount();
    const active = await mountWith();
    expect(active.textContent).not.toContain('not set up for this store');
    expect(active.textContent).not.toContain('suspended');
  });

  it('decides add to cart from the published settings, as the widget does', async () => {
    for (const [platform, label] of [
      ['shopify', 'Shopify'],
      ['woocommerce', 'WooCommerce'],
    ] as const) {
      const native = await mountWith(storeView(), connectorSource(platform, 'https://tea.example'));
      expect(native.textContent).toContain(`come from your ${label} shop`);
      expect(native.textContent).toContain('(https://tea.example)');
      expect(native.textContent).toContain('once the shopper has picked');
      expect(native.textContent).not.toContain('window.Askr.onAddToCart');
      expect(native.textContent).toContain("takes the cart's place");
      await mounted?.unmount();
    }
    // A Shopify connector whose settings lack the shop's address: add it, not a hook.
    const noAddress = await mountWith(storeView(), connectorSource('shopify'));
    expect(noAddress.textContent).toContain('do not name its address');
    expect(noAddress.textContent).not.toContain('window.Askr.onAddToCart');
    await mounted?.unmount();
    // Another platform or source: no native cart, so the hook is offered.
    for (const config of [connectorSource('google'), adminConfig()]) {
      const hook = await mountWith(storeView(), config);
      expect(hook.textContent).toContain('window.Askr = window.Askr || {};');
      expect(hook.textContent).toContain('window.Askr.onAddToCart');
      expect(hook.textContent).toContain(ADD_TO_CART_SNIPPET);
      expect(hook.textContent).toContain('adds a button that does nothing');
      await mounted?.unmount();
    }
    // A default parameter would fill in undefined: mount it directly.
    mounted = await mount(<EmbedSection api={API} view={storeView()} config={undefined} />);
    const unknown = mounted.container;
    expect(unknown.textContent).toContain('Once your settings are published');
    expect(unknown.textContent).not.toContain('window.Askr.onAddToCart');
  });

  it('links the guide and names the allowed sites', async () => {
    const container = await mountWith();
    const link = [...container.querySelectorAll('a')].find((anchor) =>
      (anchor.textContent ?? '').includes('guide'),
    );
    expect(link?.getAttribute('href')).toBe('https://docs.elisym.network/askr/embed');
    expect(container.textContent).toContain('allowed sites: https://tea.example');
  });

  it('says where to paste the code on each builder, never in a page block', async () => {
    const container = await mountWith();
    expect(container.querySelector('ul[aria-label="Where to paste it"]')).not.toBeNull();
    for (const hint of [
      'theme.liquid',
      'WPCode',
      'set to the footer',
      'with a connected domain',
      'Not the Embed HTML element',
      'Code Injection, in the footer (a Core plan or higher)',
      'never a block on one page',
    ]) {
      expect(container.textContent).toContain(hint);
    }
  });

  it('keeps the chat element, the pinned version and CSP under Advanced only', async () => {
    const container = await mountWith();
    const advanced = container.querySelector('details');
    expect(advanced?.querySelector('summary')?.textContent).toBe('Advanced');
    expect(advanced?.hasAttribute('open')).toBe(false);
    expect(advanced?.textContent).toContain('Only if your security policy requires it');
    expect(advanced?.textContent).toContain('security fixes included');
    expect(advanced?.textContent).toContain('script-src');
    expect(advanced?.textContent).toContain('<askr-chat');
    expect(advanced?.textContent).toContain('nonce or hash');
    advanced?.remove();
    expect(container.textContent).not.toContain('script-src');
    expect(container.textContent).not.toContain('<askr-chat');
  });
});

describe('add to cart on the other sites of a store with a native cart', () => {
  const API = { pinnedWidget: async () => PINNED_WIDGET };

  it('offers the hook, folded, for the allowed sites that are not the shop', async () => {
    const config = adminConfig({
      origins: ['https://tea.example', 'https://blog.tea.example'],
      source: { kind: 'connector', platform: 'shopify', shopUrl: 'https://tea.example' },
    });
    mounted = await mount(<EmbedSection api={API} view={storeView()} config={config} />);
    const folded = [...mounted.container.querySelectorAll('details')].find((details) =>
      (details.textContent ?? '').includes('Your other sites'),
    );
    expect(folded?.textContent).toContain('https://blog.tea.example');
    expect(folded?.textContent).toContain(ADD_TO_CART_SNIPPET);
  });

  it('names each copy button by what it copies', async () => {
    mounted = await mount(<EmbedSection api={API} view={storeView()} config={adminConfig()} />);
    const names = [...mounted.container.querySelectorAll('button')].map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(names).toContain('Copy: Embed code');
    expect(names).toContain('Copy: Add to cart hook (for your developer)');
  });
});

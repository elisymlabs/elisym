import { afterEach, describe, expect, it, vi } from 'vitest';
import { widgetBundle } from '../../askr-server/src/gateway/widget';
import { EmbedSection } from '../src/components/EmbedSection';
import { AdminApi } from '../src/lib/api';
import { pinnedScriptSnippet, scriptSnippet } from '../src/lib/embed';
import { npubOf, secretKeySigner } from '../src/lib/signer';
import { OWNER, OWNER_KEY, PINNED_WIDGET, adminConfig } from './fakes';
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
    mounted = await mount(<EmbedSection api={api} owner={OWNER} config={adminConfig()} />);
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
    mounted = await mount(<EmbedSection api={api} owner={OWNER} config={undefined} />);
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('could not be read'));
    expect(container.textContent).toContain(scriptSnippet(npubOf(OWNER)));
    expect(container.textContent).not.toContain('integrity=');
  });
});

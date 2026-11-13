import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import {
  ADMIN_URL,
  ASKR_KEY_COMMAND,
  DOCS,
  GITHUB_URL,
  MCP_TOOLS,
  PLANS,
  WIDGET_SRC,
  X_URL,
} from '../src/constants';
import { PHOTOS, PRODUCTS } from '../src/media';
import { NICHES } from '../src/niches';
import { CART_HOOK_SNIPPET, PINNED_SNIPPET, embedSnippet } from '../src/snippets';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PACKAGE = process.cwd();
const PACKAGES = join(PACKAGE, '..');

const EM_DASH = '—';

let root: Root | undefined;
let container: HTMLElement | undefined;

async function render(element: React.ReactElement): Promise<HTMLElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

function docsPage(name: string): string {
  return readFileSync(join(PACKAGES, 'docs/pages/askr', `${name}.mdx`), 'utf8');
}

/** Every file under `dir`, recursively. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe('the links', () => {
  it('open the admin on the Askr server, with no handle and no referrer', async () => {
    expect(ADMIN_URL).toBe('https://api.askr.elisym.network/admin/');
    const page = await render(<App />);
    const links = [...page.querySelectorAll('a')].filter((link) => link.href === ADMIN_URL);
    expect(links.length).toBeGreaterThanOrEqual(3);
    expect(new URL(ADMIN_URL).origin).not.toBe(window.location.origin);
  });

  it('send every link off the page over https with no referrer', async () => {
    const page = await render(<App />);
    const external = [...page.querySelectorAll('a')].filter((link) => {
      const href = link.getAttribute('href') ?? '';
      return !href.startsWith('#') && href !== '/';
    });
    expect(external.length).toBeGreaterThan(0);
    for (const link of external) {
      expect(link.getAttribute('href'), link.textContent ?? '').toMatch(/^https:\/\//);
      expect(link.rel).toBe('noopener noreferrer');
    }
  });

  it('name the same admin as the docs and the Askr server', () => {
    expect(docsPage('overview')).toContain(ADMIN_URL);
    expect(readFileSync(join(PACKAGES, 'askr-server/src/admin/pages.ts'), 'utf8')).toContain(
      ADMIN_URL,
    );
  });

  it('point only to docs pages that exist, and to anchors on the page', async () => {
    for (const url of Object.values(DOCS)) {
      const path = new URL(url).pathname;
      expect(existsSync(join(PACKAGES, 'docs/pages', `${path}.mdx`)), url).toBe(true);
    }
    const page = await render(<App />);
    for (const link of page.querySelectorAll('a[href^="#"]')) {
      const id = link.getAttribute('href')?.slice(1) ?? '';
      expect(page.querySelector(`[id="${id}"]`), id).not.toBeNull();
    }
  });

  it('the footer links the admin, the docs overview, GitHub and X', async () => {
    const page = await render(<App />);
    const footer = page.querySelector('footer');
    const hrefs = [...(footer?.querySelectorAll('a') ?? [])].map((link) =>
      link.getAttribute('href'),
    );
    expect(DOCS.overview).toBe('https://docs.elisym.network/askr/overview');
    for (const href of [ADMIN_URL, DOCS.overview, GITHUB_URL, X_URL]) {
      expect(hrefs).toContain(href);
    }
  });
});

describe('the snippets', () => {
  it('the hero shows the embed tag the docs give, naming the widget the server serves', async () => {
    const snippet = embedSnippet();
    expect(snippet).toBe(
      '<script src="https://api.askr.elisym.network/widget.js" data-store="npub1..." async></script>',
    );
    expect(docsPage('embed')).toContain(snippet);
    expect(WIDGET_SRC.endsWith('/widget.js')).toBe(true);
    expect(readFileSync(join(PACKAGES, 'askr-server/src/gateway/gateway.ts'), 'utf8')).toContain(
      "pathname === '/widget.js'",
    );
    const page = await render(<App />);
    expect(page.querySelector('#embed-snippet')?.textContent).toBe(snippet);
  });

  it('the Copy button puts the embed tag on the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const page = await render(<App />);
    const copy = page.querySelector('#embed-snippet')?.parentElement?.querySelector('button');
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith(embedSnippet());
    expect(copy?.textContent).toBe('Copied');
  });

  it('the pinned tag is the one the embed guide gives', async () => {
    expect(docsPage('embed')).toContain(PINNED_SNIPPET);
    expect(PINNED_SNIPPET).toContain('integrity="sha384-..."');
    const page = await render(<App />);
    expect(page.querySelector('#pinned-snippet')?.textContent).toBe(PINNED_SNIPPET);
  });

  it('the cart hook uses the name and fields the widget reads', async () => {
    const embed = docsPage('embed');
    expect(embed).toContain('window.Askr.onAddToCart = function (detail)');
    expect(CART_HOOK_SNIPPET).toContain('window.Askr.onAddToCart = function (detail)');
    for (const field of ['detail.d', 'detail.sku', 'detail.variant', 'detail.options']) {
      expect(embed).toContain(field);
      expect(CART_HOOK_SNIPPET).toContain(field);
    }
    const page = await render(<App />);
    expect(page.querySelector('#cart-hook')?.textContent).toBe(CART_HOOK_SNIPPET);
  });

  it('names the CLI command the elisym CLI has, as the docs give it', async () => {
    const cli = readFileSync(join(PACKAGES, 'cli/src/index.ts'), 'utf8');
    expect(cli).toContain(".command('askr-key <name>')");
    expect(cli).toContain(".option('--store <owner>'");
    expect(docsPage('catalog-from-an-agent')).toContain(ASKR_KEY_COMMAND);
    const page = await render(<App />);
    expect(page.querySelector('#askr-key')?.textContent).toBe(ASKR_KEY_COMMAND);
  });

  it('lists only MCP tools the MCP server has, all of them', async () => {
    const tools = readFileSync(join(PACKAGES, 'mcp/src/tools/askr.ts'), 'utf8');
    const served = [...tools.matchAll(/name: '(askr_[a-z_]+)'/g)].map((match) => match[1]);
    expect(MCP_TOOLS.map((tool) => tool.name).sort()).toEqual([...served].sort());
    const page = await render(<App />);
    const shown = [...page.querySelectorAll('#agents dt')].map((term) => term.textContent);
    expect(shown).toEqual(MCP_TOOLS.map((tool) => tool.name));
  });
});

describe('the copy', () => {
  it('has no em dash, rendered or in the page source', async () => {
    const page = await render(<App />);
    expect(page.textContent).not.toContain(EM_DASH);
    for (const file of [...filesIn(join(PACKAGE, 'src')), join(PACKAGE, 'index.html')]) {
      expect(readFileSync(file, 'utf8'), file).not.toContain(EM_DASH);
    }
  });

  it('names the company "Elisym Labs", and writes "Elisym" capitalized only there, after "by" or at the start of a sentence', async () => {
    const page = await render(<App />);
    const html = readFileSync(join(PACKAGE, 'index.html'), 'utf8');
    for (const text of [page.textContent ?? '', html]) {
      expect(text).not.toMatch(/elisym labs/);
      for (const match of text.matchAll(/(.{0,3})Elisym(?! Labs)/g)) {
        expect(match[1] ?? '', text.slice(match.index ?? 0, (match.index ?? 0) + 40)).toMatch(
          /(?:by |\. |^|>)$/,
        );
      }
    }
  });

  it('shows every plan once, priced or custom, each with a way to start', async () => {
    const page = await render(<App />);
    const cards = [...page.querySelectorAll('#pricing li:has(> div > h3)')];
    expect(cards.map((card) => card.querySelector('h3')?.textContent)).toEqual(
      PLANS.map((plan) => plan.name),
    );
    PLANS.forEach((plan, index) => {
      const card = cards[index];
      expect(card?.textContent).toContain(plan.price ?? 'Custom');
      for (const feature of plan.features) {
        expect(card?.textContent).toContain(feature);
      }
      const start = [...(card?.querySelectorAll('a') ?? [])].map((link) => link.href);
      expect(start).toEqual([plan.start === 'admin' ? ADMIN_URL : `${X_URL}`]);
    });
    expect(PLANS.filter((plan) => plan.featured)).toHaveLength(1);
  });
});

describe('the page structure', () => {
  it('has one h1 and never skips a heading level', async () => {
    const page = await render(<App />);
    const levels = [...page.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) =>
      Number(heading.tagName.slice(1)),
    );
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    levels.forEach((level, index) => {
      const previous = levels[index - 1] ?? 1;
      expect(level, `heading ${index}`).toBeLessThanOrEqual(previous + 1);
    });
  });

  it('gives every section of the main content a heading', async () => {
    const page = await render(<App />);
    const sections = [...page.querySelectorAll('main > section')];
    expect(sections.length).toBe(15);
    for (const section of sections) {
      expect(section.querySelector('h1, h2'), section.id).not.toBeNull();
    }
  });

  it('renders no raw HTML and no inline style (the CSP has style-src self)', () => {
    for (const file of filesIn(join(PACKAGE, 'src'))) {
      const code = readFileSync(file, 'utf8');
      expect(code, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
      expect(code, file).not.toMatch(/\bstyle=\{/);
    }
  });

  it('shows every photo with its alt text and size, and keeps each file small', async () => {
    const page = await render(<App />);
    const shown = Object.values(PHOTOS).filter(
      (photo) => !NICHES.slice(1).some((niche) => niche.photo === photo),
    );
    for (const photo of shown) {
      const image = page.querySelector(`img[alt="${photo.alt}"]`);
      expect(image, photo.alt).not.toBeNull();
      expect(image?.getAttribute('width')).toBe(String(photo.width));
      expect(image?.getAttribute('height')).toBe(String(photo.height));
    }
    for (const file of filesIn(join(PACKAGE, 'src/media'))) {
      expect(file).toMatch(/\.webp$/);
      expect(readFileSync(file).byteLength, file).toBeLessThan(200_000);
    }
  });

  it('switches the hero demo to the niche a tab names, with its photo and its store', async () => {
    const page = await render(<App />);
    const tabs = [...page.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(NICHES.map((niche) => niche.label));
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    for (const [index, niche] of NICHES.entries()) {
      await act(async () => (tabs[index] as HTMLButtonElement | undefined)?.click());
      expect(tabs[index]?.getAttribute('aria-selected')).toBe('true');
      const panel = page.querySelector('#niche-demo');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tabs[index]?.id);
      expect(panel?.querySelector('figure')?.getAttribute('aria-label')).toContain(niche.store);
      expect(page.querySelector(`img[alt="${niche.photo.alt}"]`)).not.toBeNull();
    }
  });

  it('each niche answer names no price but those on its cards', () => {
    for (const niche of NICHES) {
      const prices = [...`${niche.question} ${niche.answer}`.matchAll(/\$\d+(?:\.\d{2})?/g)].map(
        (match) => match[0],
      );
      const asked = [...niche.question.matchAll(/\$\d+/g)].map((match) => match[0]);
      for (const price of prices) {
        expect(
          asked.includes(price) || niche.cards.some((card) => card.price === price),
          `${niche.id}: ${price}`,
        ).toBe(true);
      }
    }
  });

  it('draws product cards with the catalog prices, as decimal strings with cents', () => {
    for (const product of Object.values(PRODUCTS)) {
      expect(product.price).toMatch(/^\$\d+\.\d{2}$/);
    }
  });

  it('draws the focus ring in the readable accent ink', () => {
    expect(readFileSync(join(PACKAGE, 'src/app.css'), 'utf8')).toMatch(
      /:focus-visible \{\s*outline: 2px solid var\(--accent-ink\);/,
    );
  });

  it('wraps commands instead of cutting them off', async () => {
    const page = await render(<App />);
    for (const code of page.querySelectorAll('li code')) {
      expect(code.className).toContain('break-all');
    }
    for (const pre of page.querySelectorAll('pre')) {
      expect(pre.className).toContain('overflow-x-auto');
    }
  });
});

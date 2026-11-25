import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../askr/src/constants';
import { App } from '../src/App';
import {
  ADMIN_URL,
  CONTACT_URL,
  DOCS,
  ELISYM_URL,
  GITHUB_URL,
  PLANS,
  PRODUCT_PITCH,
  START_LABEL,
  WIDGET_SRC,
  WORKS_WITH_TEXT,
  X_URL,
} from '../src/constants';
import { PHOTOS } from '../src/media';
import { FEATURES_COMPARISON, NICHES } from '../src/niches';
import { embedSnippet } from '../src/snippets';

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

/** A link to a section of this page or a path on this site (not `//host`). */
function isOnSite(href: string): boolean {
  return href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//'));
}

describe('the links', () => {
  it('redirect /contact to the contact, temporarily, so a changed contact is never cached', () => {
    const config: unknown = JSON.parse(readFileSync(join(PACKAGE, 'vercel.json'), 'utf8'));
    const redirects: unknown =
      typeof config === 'object' && config !== null ? Reflect.get(config, 'redirects') : undefined;
    expect(redirects).toEqual([
      { source: '/contact', destination: CONTACT_URL, permanent: false },
      { source: '/terms', destination: '/terms-of-service', permanent: false },
    ]);
  });

  it('open the admin on the Askr server, with no handle and no referrer', async () => {
    expect(ADMIN_URL).toBe('https://app.askr.elisym.network/admin/');
    const page = await render(<App />);
    const links = [...page.querySelectorAll('a')].filter((link) => link.href === ADMIN_URL);
    expect(links.length).toBeGreaterThanOrEqual(3);
    expect(new URL(ADMIN_URL).origin).not.toBe(window.location.origin);
  });

  it('send every link off the site over https, in a new tab, with no referrer', async () => {
    const page = await render(<App />);
    const external = [...page.querySelectorAll('a')].filter((link) => {
      const href = link.getAttribute('href') ?? '';
      return !isOnSite(href);
    });
    expect(external.length).toBeGreaterThan(0);
    for (const link of external) {
      expect(link.getAttribute('href'), link.textContent ?? '').toMatch(/^https:\/\//);
      expect(link.rel).toBe('noopener noreferrer');
      expect(link.getAttribute('target'), link.textContent ?? '').toBe('_blank');
    }
    const onPage = [...page.querySelectorAll('a')].filter((link) => {
      const href = link.getAttribute('href') ?? '';
      return isOnSite(href);
    });
    expect(onPage.length).toBeGreaterThan(0);
    for (const link of onPage) {
      expect(link.getAttribute('target'), link.textContent ?? '').toBeNull();
    }
  });

  it('take the elisym logo, in the header and the footer, to elisym.network in a new tab', async () => {
    const page = await render(<App />);
    const logos = [...page.querySelectorAll('img[alt="elisym"]')];
    expect(logos).toHaveLength(2);
    for (const logo of logos) {
      expect(logo.closest('a')?.getAttribute('href')).toBe(ELISYM_URL);
      expect(logo.closest('a')?.getAttribute('target')).toBe('_blank');
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

describe('the hero', () => {
  it('says the pitch and the works-with line the llms.txt repeats', async () => {
    const page = await render(<App />);
    const hero = page.querySelector('#top');
    const paragraphs = [...(hero?.querySelectorAll('p') ?? [])].map(
      (paragraph) => paragraph.textContent,
    );
    expect(paragraphs).toContain(PRODUCT_PITCH);
    expect(paragraphs).toContain(WORKS_WITH_TEXT);
  });
});

describe('the snippets', () => {
  it('the hero shows the embed tag the docs give, naming the widget the server serves', async () => {
    const snippet = embedSnippet();
    expect(snippet).toBe(
      '<script src="https://app.askr.elisym.network/widget.js" data-store="npub1..." async></script>',
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
});

describe('the copy', () => {
  it('offers the four product sources the admin has, the PayCore store among them', async () => {
    const page = await render(<App />);
    const sources = [...page.querySelectorAll('#sources h3')].map((title) => title.textContent);
    expect(sources).toEqual([
      'Your shop, connected',
      'The admin',
      'Your code or your agent',
      'Your PayCore store',
    ]);
    expect(docsPage('overview')).toContain('## Sell from your PayCore store');
  });

  it('spells PayCore as one word, in the page, every source file and the Askr docs', async () => {
    const page = await render(<App />);
    const docs = readdirSync(join(PACKAGES, 'docs/pages/askr')).map((name) =>
      join(PACKAGES, 'docs/pages/askr', name),
    );
    const sources = filesIn(join(PACKAGE, 'src')).filter((path) => /\.tsx?$/.test(path));
    const texts = [
      ['page', page.textContent ?? ''],
      ...[...sources, ...docs].map((file) => [file, readFileSync(file, 'utf8')]),
    ];
    for (const [where, text] of texts) {
      for (const match of (text ?? '').matchAll(/(?<![-#/\w])pay\s*core(?![-\w])/gi)) {
        expect(match[0], where).toBe('PayCore');
      }
    }
  });

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

  it('promises a free start only while the first plan is free', async () => {
    expect(START_LABEL).toBe('Start free');
    expect(PLANS[0]?.price.monthly).toBe('$0');
    expect(PLANS[0]?.start).toBe('admin');
    const page = await render(<App />);
    const starts = [...page.querySelectorAll('a')].filter(
      (link) => link.textContent === START_LABEL,
    );
    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (const link of starts) {
      expect(link.href).toBe(ADMIN_URL);
    }
  });
});

describe('the catalog drawing', () => {
  it('shows the sources flowing into the product list, priced as the catalog writes them', async () => {
    const page = await render(<App />);
    const figure = page.querySelector('#sources figure');
    expect(figure?.getAttribute('aria-label')).toContain('Askr');
    const text = figure?.textContent ?? '';
    for (const source of ['Backend', 'CI/CD', 'WooCommerce', 'Google feed', 'CSV']) {
      expect(text).toContain(source);
    }
    const rows = [...(figure?.querySelectorAll('li:has(img)') ?? [])];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.textContent).toMatch(/\d+\.\d{2} USD/);
    }
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
    expect(sections.length).toBe(13);
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

  it('each niche answer names no price but those shown so far or the budget asked', () => {
    const dollars = (text: string) => [...text.matchAll(/\$(\d+)/g)].map((match) => match[1]);
    const amounts = (text: string) =>
      [...text.matchAll(/(\d+)\.\d\d USD/g)].map((match) => match[1]);
    for (const niche of NICHES) {
      const asked: (string | undefined)[] = [];
      const shown: (string | undefined)[] = [];
      for (const turn of niche.turns) {
        asked.push(...dollars(turn.question));
        const products = [
          ...(turn.cards ?? []).map((card) => card.product),
          ...(turn.comparison?.products ?? []),
        ];
        shown.push(...products.map((product) => product.price.split('.')[0]));
        for (const price of [...dollars(turn.answer), ...amounts(turn.answer)]) {
          expect(asked.includes(price) || shown.includes(price), `${niche.id}: ${price}`).toBe(
            true,
          );
        }
      }
    }
  });

  it('each niche taps only a chip the answer before it offered', () => {
    for (const niche of NICHES) {
      for (const [index, turn] of niche.turns.entries()) {
        const offered = niche.turns[index - 1]?.chips;
        if (offered !== undefined) {
          expect(offered, `${niche.id}: ${turn.question}`).toContain(turn.question);
        }
      }
    }
  });

  it('compares only as the assistant can: what present_comparison keeps', () => {
    const comparisons = [
      { where: 'features', comparison: FEATURES_COMPARISON },
      ...NICHES.flatMap((niche) =>
        niche.turns.map((turn) => ({
          where: `${niche.id}: ${turn.question}`,
          comparison: turn.comparison,
        })),
      ),
    ];
    for (const { where, comparison } of comparisons) {
      if (comparison === undefined) {
        continue;
      }
      const { products, rows, recommended } = comparison;
      expect(products.length, where).toBeGreaterThanOrEqual(LIMITS.MIN_COMPARISON);
      expect(products.length, where).toBeLessThanOrEqual(LIMITS.MAX_COMPARISON);
      expect(new Set(products).size, where).toBe(products.length);
      // The store adds the price row: the assistant's rows leave room for it and never name it.
      expect(rows.length, where).toBeGreaterThan(0);
      expect(rows.length, where).toBeLessThanOrEqual(LIMITS.MAX_COMPARISON_ROWS - 1);
      for (const row of rows) {
        const named = `${where}: ${row.dimension}`;
        expect(row.dimension, named).not.toMatch(/price|cost/i);
        expect(row.cells, named).toHaveLength(products.length);
        // The agent drops a row with nothing but dashes or bare numbers.
        expect(
          row.cells.every((cell) => /^[\d\s.,'’-]+$/.test(cell)),
          named,
        ).toBe(false);
      }
      if (recommended !== undefined) {
        expect(products, where).toContain(recommended);
      }
    }
  });

  it('draws the focus ring in the readable accent ink', () => {
    expect(readFileSync(join(PACKAGE, 'src/app.css'), 'utf8')).toMatch(
      /:focus-visible \{\s*outline: 2px solid var\(--accent-ink\);/,
    );
  });
});

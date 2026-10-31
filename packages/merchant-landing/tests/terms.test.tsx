import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Footer } from '../src/components/Footer';
import { TermsPage } from '../src/components/TermsPage';
import { TERMS, TERMS_VERSION } from '../src/terms';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

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
});

describe('the cloud terms', () => {
  it('show their version and every section, with a way back to the landing', async () => {
    const page = await render(<TermsPage />);
    expect(page.querySelector('h1')?.textContent).toContain('terms of service');
    expect(page.textContent).toContain(`Version ${TERMS_VERSION}`);
    expect([...page.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(
      TERMS.map((section) => section.title),
    );
    expect(page.textContent).toContain('We never hold your money');
    expect([...page.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '/',
      '/',
    ]);
  });

  it('are their own page at /terms, linked from the landing footer', async () => {
    const html = readFileSync(join(process.cwd(), 'terms.html'), 'utf8');
    expect(html).toContain('src="/src/terms-main.tsx"');
    expect(html).toContain(
      '<meta property="og:url" content="https://paycore.elisym.network/terms" />',
    );
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      cleanUrls?: boolean;
    };
    expect(vercel.cleanUrls).toBe(true);
    const footer = await render(<Footer />);
    expect(footer.querySelector('a[href="/terms"]')?.textContent).toBe('Cloud terms');
  });

  it('a date version, as cloud-api records the acceptance', () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

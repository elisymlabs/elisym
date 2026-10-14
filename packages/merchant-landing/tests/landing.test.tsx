import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { V3_LOADER_INTEGRITY, V3_LOADER_SRC } from '@elisym/react/constants';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { Demo } from '../src/components/Demo';
import {
  ADMIN_URL,
  AGENT_DOCS_URL,
  AGENT_PROMPT,
  DOCS,
  INIT_COMMAND,
  LOCAL_ADMIN_COMMAND,
} from '../src/constants';
import { htmlSnippet } from '../src/snippets';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PACKAGES = join(process.cwd(), '..');

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
  document.head.querySelectorAll('script').forEach((script) => script.remove());
});

describe('the landing', () => {
  it('links to the admin on its own origin, with no handle and no referrer', async () => {
    const page = await render(<App />);
    const links = [...page.querySelectorAll('a')].filter((link) => link.href.startsWith(ADMIN_URL));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.rel).toBe('noopener noreferrer');
    }
    expect(new URL(ADMIN_URL).origin).not.toBe(window.location.origin);
  });

  it('without a demo product shows the snippet and no checkout', async () => {
    const page = await render(<Demo demo={undefined} />);
    expect(page.querySelector('elisym-buy')).toBeNull();
    expect(page.querySelector('#snippet')?.textContent).toContain(V3_LOADER_INTEGRITY);
    expect(document.querySelector(`script[src="${V3_LOADER_SRC}"]`)).toBeNull();
  });

  it('with a demo product renders the checkout for it', async () => {
    const page = await render(
      <Demo demo={{ product: 'naddr1demo', network: 'mainnet', price: '0.05 USDC' }} />,
    );
    const element = page.querySelector('elisym-buy');
    expect(element?.getAttribute('product')).toBe('naddr1demo');
    expect(element?.getAttribute('network')).toBe('mainnet');
    expect(element?.getAttribute('theme')).toBe('auto');
  });

  it('the snippet pins the loader @elisym/react uses', () => {
    const snippet = htmlSnippet();
    expect(snippet).toContain(`src="${V3_LOADER_SRC}"`);
    expect(snippet).toContain(`integrity="${V3_LOADER_INTEGRITY}"`);
    expect(snippet).toContain('crossorigin="anonymous"');
  });

  it('names the same admin as the merchant CLI, its README and the quickstart', () => {
    const constants = readFileSync(join(PACKAGES, 'merchant-node/src/constants.ts'), 'utf8');
    expect(constants).toContain(`HOSTED_ADMIN_URL = '${ADMIN_URL}'`);
    expect(readFileSync(join(PACKAGES, 'merchant-node/README.md'), 'utf8')).toContain(ADMIN_URL);
    expect(readFileSync(join(PACKAGES, 'docs/pages/commerce/quickstart.mdx'), 'utf8')).toContain(
      ADMIN_URL,
    );
  });

  it('shows the React snippet on its tab', async () => {
    const page = await render(<Demo demo={undefined} />);
    const reactTab = [...page.querySelectorAll('button')].find(
      (button) => button.textContent === 'React',
    );
    await act(async () => reactTab?.click());
    expect(page.querySelector('#snippet')?.textContent).toContain('ElisymBuy');
    expect(page.querySelector('#snippet')?.textContent).not.toContain('<script');
  });

  it('links only to docs pages that exist, and to anchors on the page', async () => {
    for (const url of Object.values(DOCS)) {
      const path = new URL(url).pathname;
      expect(existsSync(join(PACKAGES, 'docs/pages', `${path}.mdx`))).toBe(true);
    }
    const page = await render(<App />);
    for (const link of page.querySelectorAll('a[href^="#"]')) {
      const id = link.getAttribute('href')?.slice(1) ?? '';
      expect(page.querySelector(`[id="${id}"]`)).not.toBeNull();
    }
  });

  it('hands the agent the quickstart as markdown, and the page shows the prompt it copies', async () => {
    expect(AGENT_DOCS_URL).toBe(`${DOCS.quickstart}.md`);
    expect(AGENT_PROMPT).toContain(AGENT_DOCS_URL);
    // The quickstart offers the same prompt, so both places hand an agent the same job.
    expect(readFileSync(join(PACKAGES, 'docs/pages/commerce/quickstart.mdx'), 'utf8')).toContain(
      `\n${AGENT_PROMPT}\n`,
    );
    const page = await render(<App />);
    expect(page.querySelector('#agent-prompt')).toBeNull();
    const agentTab = [...page.querySelectorAll('button')].find(
      (button) => button.textContent === 'AI agent',
    );
    await act(async () => agentTab?.click());
    expect(page.querySelector('#agent-prompt')?.textContent).toBe(AGENT_PROMPT);
    expect(page.querySelector('#snippet')).toBeNull();
  });

  it('renders no raw HTML and no inline style (the CSP has style-src self)', () => {
    const dir = join(process.cwd(), 'src/components');
    for (const name of readdirSync(dir)) {
      const code = readFileSync(join(dir, name), 'utf8');
      expect(code).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
      expect(code).not.toMatch(/\bstyle=\{/);
    }
  });

  it('draws the focus ring in the readable accent, never the light-mode lime', () => {
    expect(readFileSync(join(process.cwd(), 'src/app.css'), 'utf8')).toMatch(
      /:focus-visible \{\s*outline: 2px solid var\(--accent-ink\);/,
    );
  });

  it('wraps the local admin command instead of cutting it off', async () => {
    const page = await render(<App />);
    const command = [...page.querySelectorAll('code')].find(
      (code) => code.textContent === LOCAL_ADMIN_COMMAND,
    );
    expect(command?.className).toContain('break-all');
    expect(command?.className).not.toContain('truncate');
  });

  it('names commands the merchant CLI has', () => {
    const cli = readFileSync(join(PACKAGES, 'merchant-node/src/cli.ts'), 'utf8');
    expect(cli).toContain('init [--network devnet|mainnet]');
    for (const command of [INIT_COMMAND, LOCAL_ADMIN_COMMAND]) {
      const subcommand = command.split(' ')[2] ?? '';
      expect(cli).toMatch(new RegExp(`\\n  ${subcommand} `));
    }
  });
});

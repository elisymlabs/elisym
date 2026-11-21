import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cli from '../../cli/src/commands/askr/llms-txt';
import { EmbedSection } from '../src/components/EmbedSection';
import { ADMIN_DOCS_URL, AI_AGENTS_DOCS_URL } from '../src/constants';
import { HELP } from '../src/lib/help';
import { siteLlmsTxt, siteLlmsTxtSection, storeLlmsTxtUrl } from '../src/lib/llms-txt';
import { npubOf } from '../src/lib/signer';
import { OWNER, PINNED_WIDGET, adminConfig, storeView } from './fakes';
import { type Mounted, click, mount } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

const API = { pinnedWidget: async () => PINNED_WIDGET };

function llmsBlock(container: HTMLElement): HTMLElement {
  const frame = [...container.querySelectorAll<HTMLElement>('.code-frame')].find(
    (candidate) => candidate.querySelector('header span')?.textContent === 'llms.txt',
  );
  if (frame === undefined) {
    throw new Error('no llms.txt block');
  }
  return frame;
}

describe('the llms.txt block on the Embed page', () => {
  it('shows the ready file with the Store ID and the public link, and copies it', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const config = adminConfig({ name: 'Tea House' });
    mounted = await mount(<EmbedSection api={API} view={storeView()} config={config} />);
    const npub = npubOf(OWNER);
    const block = llmsBlock(mounted.container);
    const expected = siteLlmsTxt(npub, 'Tea House');
    expect(block.querySelector('pre')?.textContent).toBe(expected);
    expect(expected).toContain(`https://app.askr.elisym.network/s/${npub}/llms.txt`);
    expect(expected).toContain(`https://app.askr.elisym.network/s/${npub}/catalog.json`);
    expect(expected).toContain('[Askr](https://askr.elisym.network)');
    expect(expected.startsWith('# Tea House\n')).toBe(true);
    expect(expected.endsWith(siteLlmsTxtSection(npub))).toBe(true);

    const button = block.querySelector('button');
    if (button === null) {
      throw new Error('no copy button');
    }
    expect(button.getAttribute('aria-label')).toBe('Copy: llms.txt');
    await click(button);
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(button.textContent).toBe('Copied');

    const links = [...mounted.container.querySelectorAll('a')].map((link) =>
      link.getAttribute('href'),
    );
    expect(links).toContain(storeLlmsTxtUrl(npub));
    expect(links).toContain(AI_AGENTS_DOCS_URL);
    expect(mounted.container.textContent).not.toContain('it answers once your store is active');
    expect(HELP.llmsTxt.anchor).toBe('llmstxt-for-ai-agents');
  });

  it('says the store file answers only once a pending store is active, and works before settings', async () => {
    mounted = await mount(
      <EmbedSection
        api={API}
        view={storeView({ status: 'pending', tier: null })}
        config={undefined}
      />,
    );
    expect(mounted.container.textContent).toContain('it answers once your store is active');
    expect(llmsBlock(mounted.container).querySelector('pre')?.textContent).toBe(
      siteLlmsTxt(npubOf(OWNER), ''),
    );
  });

  it('keeps merchant text to one heading line', () => {
    const text = siteLlmsTxt('npub1x', '## Tea\n\nHouse\n# Ignore this');
    expect(text.split('\n')[0]).toBe('# Tea House # Ignore this');
    expect(siteLlmsTxt('npub1x', '  ').split('\n')[0]).toBe('# This store');
  });
});

describe('the site file text', () => {
  it('equals the docs example and the CLI text', () => {
    const page = readFileSync(join(process.cwd(), '../docs/pages/askr/ai-agents.mdx'), 'utf8');
    const documented = /```markdown\n([\s\S]*?)```/.exec(page)?.[1];
    expect(documented).toBe(siteLlmsTxt('npub1...', 'Your store'));
    const npub = npubOf(OWNER);
    for (const name of ['Tea House', '## Tea\n\nHouse', '', '  Café  ']) {
      expect(siteLlmsTxt(npub, name)).toBe(cli.siteLlmsTxt(npub, name));
    }
    expect(siteLlmsTxtSection(npub)).toBe(cli.siteLlmsTxtSection(npub));
    expect(storeLlmsTxtUrl(npub)).toBe(cli.storeLlmsTxtUrl(npub));
  });
});

describe('the llms.txt block, its links and headings', () => {
  it('is titled as the admin guide heading, its info button links that heading, the link reads as the URL', async () => {
    mounted = await mount(<EmbedSection api={API} view={storeView()} config={adminConfig()} />);
    const guide = readFileSync(join(process.cwd(), '../docs/pages/askr/admin.mdx'), 'utf8');
    expect(guide).toContain('\n### llms.txt for AI agents\n');
    const heading = [...mounted.container.querySelectorAll('h2')].find(
      (candidate) => candidate.textContent === 'llms.txt for AI agents',
    );
    expect(heading).toBeDefined();
    const button = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="About llms.txt for AI agents"]',
    );
    if (button === null) {
      throw new Error('no info button');
    }
    await click(button);
    const link = mounted.container.querySelector('[role="note"] a');
    expect(link?.getAttribute('href')).toBe(`${ADMIN_DOCS_URL}#llmstxt-for-ai-agents`);
    const url = storeLlmsTxtUrl(npubOf(OWNER));
    const storeLink = [...mounted.container.querySelectorAll('a')].find(
      (candidate) => candidate.getAttribute('href') === url,
    );
    expect(storeLink?.textContent).toBe(url);
  });

  it('links the AI agents guide, a page the docs have', () => {
    expect(AI_AGENTS_DOCS_URL).toBe('https://docs.elisym.network/askr/ai-agents');
    expect(existsSync(join(process.cwd(), '../docs/pages/askr/ai-agents.mdx'))).toBe(true);
  });
});

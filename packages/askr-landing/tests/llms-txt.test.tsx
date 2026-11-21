import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { headerProblems, llmsTxtProblems } from '../scripts/build-checks';
import { LLMS_TXT_HEADERS, deployProblems } from '../scripts/deploy-checks';
import { AGENT_PROMPT } from '../src/agent-prompt';
import { App } from '../src/App';
import {
  ADMIN_URL,
  AGENT_SETUP_ID,
  API_ORIGIN,
  CHOOSE_PLAN_TEXT,
  CONTACT_REDIRECT_URL,
  CONTRACT_PRICE_NOTE,
  DOCS,
  DOCS_LLMS_TXT_URL,
  GITHUB_URL,
  PLANS,
  PRICE_TAX_NOTE,
  PRICING_SMALL_PRINT,
  PRICING_URL,
  PRODUCT_PITCH,
  SITE_URL,
  WIDGET_SRC,
  WORKS_WITH_TEXT,
  isContractPlan,
  isFlatPlan,
} from '../src/constants';
import { PRIVACY_PATH, TERMS_PATH } from '../src/legal';
import { CLI_COMMAND, LLMS_TXT_PATH, renderLlmsTxt } from '../src/llms-txt';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PACKAGE = process.cwd();
const DOCS_PAGES = join(PACKAGE, '..', 'docs', 'pages');
const DOCS_ORIGIN = 'https://docs.elisym.network';
const EM_DASH = '—';

const text = renderLlmsTxt();

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

/** A feature as the plan's sentence writes it after the first: from a lower-case letter. */
function inSentence(feature: string): string {
  return `${feature.charAt(0).toLowerCase()}${feature.slice(1)}`;
}

function planLine(name: string): string | undefined {
  return text.split('\n').find((entry) => entry.startsWith(`- **${name}**: `));
}

describe('llms.txt', () => {
  it('is in the llms.txt form: one H1, the pitch as the summary quote, then sections', () => {
    const lines = text.split('\n');
    expect(lines[0]).toBe('# Askr');
    expect(lines[2]).toBe(`> ${PRODUCT_PITCH}`);
    expect(lines.filter((line) => line.startsWith('# '))).toHaveLength(1);
    for (const section of [
      '## Set up Askr for a store',
      '## Plans and prices',
      "## How a shopper's agent reads a store",
      '## Docs',
      '## Links',
      '## Setup prompt',
    ]) {
      expect(text).toContain(`\n${section}\n`);
    }
    expect(text).toContain(` ${WORKS_WITH_TEXT} `);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('states every plan with the exact prices and limits the page shows, tax included', () => {
    for (const plan of PLANS) {
      const line = planLine(plan.name);
      expect(line, plan.name).toBeDefined();
      expect(line).toContain(plan.blurb);
      const [first = '', ...rest] = plan.features;
      expect(line).toContain(first);
      for (const feature of rest) {
        expect(line).toContain(inSentence(feature));
      }
      if (isFlatPlan(plan) && plan.price.monthly !== '$0') {
        expect(line).toContain(`${plan.price.monthly} / month ${PRICE_TAX_NOTE} billed monthly`);
        expect(line).toContain(
          `${plan.price.yearlyPerMonth} / month ${PRICE_TAX_NOTE} billed yearly (${plan.price.yearlyTotal} a year)`,
        );
      } else if (isFlatPlan(plan)) {
        expect(line).toContain('$0 / month, no payment needed');
      } else if (isContractPlan(plan)) {
        expect(line).toContain(
          `from ${plan.price.monthly} / month ${PRICE_TAX_NOTE}. ${CONTRACT_PRICE_NOTE}.`,
        );
      }
    }
  });

  it('says how to get on a plan once, in the words the page uses, and nowhere per plan', () => {
    expect(text).toContain(`\n${PRICING_SMALL_PRINT} ${CHOOSE_PLAN_TEXT}\n`);
    for (const plan of PLANS) {
      expect(planLine(plan.name), plan.name).not.toMatch(/Start:|message us|contact us/iu);
    }
    expect(text).toContain(`(${PRICING_URL})`);
    expect(text).toContain(`- [Contact](${CONTACT_REDIRECT_URL}): message us about a plan\n`);
  });

  it('says how an agent sets Askr up, as the setup prompt does', () => {
    expect(CLI_COMMAND).toBe('npx -y @elisym/cli@latest askr <command>');
    // Before the prompt itself, which says them all too.
    const promptAt = text.indexOf('\n## Setup prompt\n');
    expect(promptAt).toBeGreaterThan(0);
    const beforePrompt = text.slice(0, promptAt);
    for (const step of [CLI_COMMAND, 'askr init', 'askr embed', 'askr status --probe']) {
      expect(AGENT_PROMPT, step).toContain(step);
      expect(beforePrompt, step).toContain(`\`${step}\``);
    }
    expect(AGENT_PROMPT).toContain('(Node 22 or newer)');
    expect(beforePrompt).toContain('(Node 22 or newer)');
    expect(text).toContain(`(\`${WIDGET_SRC}\`)`);
  });

  it("links the landing's agent setup section, which the page has", async () => {
    expect(text).toContain(`(${SITE_URL}/#${AGENT_SETUP_ID})`);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    expect(container.querySelector(`section#${AGENT_SETUP_ID}`)).not.toBeNull();
  });

  it('says how a shopper agent reads a store: the per-store files on the Askr server', () => {
    expect(text).toContain(`\`${API_ORIGIN}/s/npub1.../llms.txt\``);
    expect(text).toContain(`\`${API_ORIGIN}/s/npub1.../catalog.json\``);
    expect(text).toContain('under a "Shopping assistant" heading');
    expect(text).toContain(`(${API_ORIGIN}${LLMS_TXT_PATH})`);
  });

  it('links the admin, the legal pages, the contact, the source and the docs', () => {
    expect(DOCS_LLMS_TXT_URL).toBe(`${DOCS_ORIGIN}/llms.txt`);
    for (const url of [
      ADMIN_URL,
      `${SITE_URL}${PRIVACY_PATH}`,
      `${SITE_URL}${TERMS_PATH}`,
      CONTACT_REDIRECT_URL,
      GITHUB_URL,
      ...Object.values(DOCS),
      DOCS_LLMS_TXT_URL,
    ]) {
      expect(text, url).toContain(`(${url})`);
    }
  });

  it('links only docs pages that exist', () => {
    const links = [...text.matchAll(/\]\((https:\/\/docs\.elisym\.network[^)\s]*)\)/gu)].map(
      (match) => match[1] ?? '',
    );
    expect(links.length).toBeGreaterThan(5);
    for (const url of links) {
      if (url === DOCS_LLMS_TXT_URL) {
        continue;
      }
      const path = url.slice(DOCS_ORIGIN.length).split('#')[0] ?? '';
      expect(readFileSync(join(DOCS_PAGES, `${path}.mdx`), 'utf8').length, url).toBeGreaterThan(0);
    }
  });

  it('holds the whole setup prompt in one fence the prompt cannot close', () => {
    expect(AGENT_PROMPT).not.toContain('```');
    expect(text).toContain(`\`\`\`text\n${AGENT_PROMPT}\n\`\`\`\n`);
  });

  it('has no em dash', () => {
    expect(text).not.toContain(EM_DASH);
  });
});

describe('llms.txt in the build', () => {
  it('is checked against what the constants render, byte for byte', () => {
    expect(llmsTxtProblems(text, text)).toEqual([]);
    expect(llmsTxtProblems(undefined, text)).toEqual(['dist/llms.txt was not built']);
    const differs = ['dist/llms.txt differs from renderLlmsTxt()'];
    expect(llmsTxtProblems(`${text}stale`, text)).toEqual(differs);
    expect(llmsTxtProblems(`${text}\n`, text)).toEqual(differs);
  });

  it('fails the deploy check when dist/llms.txt is missing or stale', () => {
    const vercel = JSON.parse(readFileSync(join(PACKAGE, 'vercel.json'), 'utf8'));
    const dist = mkdtempSync(join(tmpdir(), 'askr-landing-dist-'));
    try {
      writeFileSync(join(dist, 'index.html'), '<link rel="stylesheet" href="/a.css">');
      const llmsProblems = () =>
        deployProblems(dist, vercel, ['index.html']).filter((problem) =>
          problem.includes('llms.txt'),
        );
      expect(llmsProblems()).toEqual(['dist/llms.txt was not built']);
      writeFileSync(join(dist, 'llms.txt'), `${text}stale`);
      expect(llmsProblems()).toEqual(['dist/llms.txt differs from renderLlmsTxt()']);
      writeFileSync(join(dist, 'llms.txt'), text);
      expect(deployProblems(dist, vercel, ['index.html'])).toEqual([]);
      const wrongType = {
        ...vercel,
        headers: vercel.headers.map((rule: { source: string }) =>
          rule.source === LLMS_TXT_PATH
            ? { source: LLMS_TXT_PATH, headers: [{ key: 'Content-Type', value: 'text/plain' }] }
            : rule,
        ),
      };
      expect(deployProblems(dist, wrongType, ['index.html']).length).toBeGreaterThan(0);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('is served by Vercel as UTF-8 Markdown, readable from any origin', () => {
    const vercel = JSON.parse(readFileSync(join(PACKAGE, 'vercel.json'), 'utf8'));
    expect(LLMS_TXT_HEADERS).toEqual({
      'Content-Type': 'text/markdown; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    expect(headerProblems(vercel, LLMS_TXT_HEADERS, LLMS_TXT_PATH)).toEqual([]);
  });

  it('is named by the landing page as its Markdown alternate', () => {
    const html = readFileSync(join(PACKAGE, 'index.html'), 'utf8');
    expect(html).toContain(`<link rel="alternate" type="text/markdown" href="${LLMS_TXT_PATH}"`);
  });
});

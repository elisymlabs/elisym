import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { Cloud } from '../src/components/Cloud';
import { Pricing } from '../src/components/Pricing';
import {
  CLOUD_AGENT_PROMPT,
  CLOUD_CONSOLE_URL,
  CLOUD_TIERS,
  CONTACT_URL,
  cloudStartUrl,
} from '../src/constants';

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
  document.head.querySelectorAll('script').forEach((script) => script.remove());
});

function tierCard(page: HTMLElement, id: string): HTMLElement {
  const card = page.querySelector<HTMLElement>(`[data-tier="${id}"]`);
  if (card === null) {
    throw new Error(`no ${id} tier`);
  }
  return card;
}

describe('the cloud section', () => {
  it('is on the page and in the header, with the pricing after it', async () => {
    const page = await render(<App />);
    expect(page.querySelector('section#cloud h2')?.textContent).toBe('Run it in our cloud');
    expect(page.querySelector('header a[href="#cloud"]')).not.toBeNull();
    expect(page.querySelector('header a[href="#pricing"]')?.textContent).toBe('Pricing');
    // Five section links fit one line from lg up (at md they wrapped): never wrapped, shown from lg.
    for (const link of page.querySelectorAll('header nav a[href^="#"]')) {
      expect(link.className).toContain('whitespace-nowrap');
      expect(link.className).toContain('lg:inline');
      expect(link.className).not.toContain('md:inline');
    }
    const signIn = [...page.querySelectorAll('header nav a')].find(
      (link) => link.textContent === 'Sign in',
    );
    expect(signIn?.className).toContain('whitespace-nowrap');
    expect(page.querySelector('section#cloud + section#pricing')).not.toBeNull();
  });

  it("starts only the self-serve plans, on the console's own origin, with no handle and no referrer", async () => {
    const page = await render(<Pricing />);
    const starts = [...page.querySelectorAll('a')].filter((link) => link.textContent === 'Start');
    expect(starts.map((link) => link.getAttribute('href'))).toEqual([
      'https://cloud.elisym.network/start?tier=starter',
      'https://cloud.elisym.network/start?tier=business',
    ]);
    for (const link of starts) {
      expect(link.rel).toBe('noopener noreferrer');
      expect(new URL(link.href).origin).toBe(CLOUD_CONSOLE_URL);
    }
    expect(starts.map((link) => link.getAttribute('aria-label'))).toEqual([
      'Start with Starter',
      'Start with Business',
    ]);
    expect(cloudStartUrl('starter')).toBe(`${CLOUD_CONSOLE_URL}/start?tier=starter`);
    expect(new URL(CLOUD_CONSOLE_URL).origin).not.toBe(window.location.origin);
  });

  it('sends Enterprise and White-label to "Contact us", never to a Start', async () => {
    const page = await render(<Pricing />);
    for (const [id, name] of [
      ['high-risk', 'Enterprise'],
      ['white-label', 'White-label'],
    ]) {
      const links = [...tierCard(page, id).querySelectorAll('a')];
      expect(links.map((link) => [link.textContent, link.getAttribute('href'), link.rel])).toEqual([
        ['Contact us', CONTACT_URL, 'noopener noreferrer'],
      ]);
      expect(links[0]?.getAttribute('aria-label')).toBe(`Contact us about ${name}`);
    }
    expect(tierCard(page, 'high-risk').textContent).toContain('from $499/mo');
    // White-label is agreed with each platform: no figure.
    expect(tierCard(page, 'white-label').textContent).toContain("Let's talk");
    expect(tierCard(page, 'white-label').textContent).not.toContain('$');
    expect(CLOUD_TIERS.filter((tier) => tier.selfServe).map((tier) => tier.id)).toEqual([
      'starter',
      'business',
    ]);
  });

  it("states each plan's price and limits, and highlights Business", async () => {
    const page = await render(<Pricing />);
    expect(page.querySelector('section#pricing h2')?.textContent).toBe(
      'One monthly price, every network',
    );
    const starter = tierCard(page, 'starter').textContent ?? '';
    expect(starter).toContain('$29/mo');
    expect(starter).toContain('Up to 100 products');
    expect(starter).toContain('2,000 paid orders a month included');
    expect(starter).toContain('Solana, Base, Arbitrum, Ethereum and Tempo');
    const business = tierCard(page, 'business');
    expect(business.textContent).toContain('$99/mo');
    expect(business.textContent).toContain('Up to 1,000 products');
    expect(business.textContent).toContain('No cap on orders');
    expect(business.textContent).toContain('Recommended');
    const badge = [...business.querySelectorAll('span')].find(
      (span) => span.textContent === 'Recommended',
    );
    expect(badge?.className).toContain('text-accent-ink');
    expect(badge?.className).toContain('bg-accent-soft');
    expect(business.className).toContain('border-accent-ink');
    expect(tierCard(page, 'starter').textContent).not.toContain('Recommended');
    const enterprise = tierCard(page, 'high-risk').textContent ?? '';
    expect(enterprise).toContain('No cap on products');
    expect(enterprise).toContain('No cap on orders');
    expect(enterprise).toContain('no payouts to players');
    expect(page.textContent).not.toContain('announced at launch');
  });

  it('states a limit by its display string when the catalog gives one', async () => {
    const page = await render(
      <Pricing
        tiers={CLOUD_TIERS.map((tier) =>
          tier.id === 'business'
            ? { ...tier, display: { products: 'Plenty', ordersPerMonth: 'Unlimited' } }
            : tier,
        )}
      />,
    );
    expect(tierCard(page, 'business').textContent).toContain('Plenty on products');
    expect(tierCard(page, 'business').textContent).toContain('Unlimited on orders');
  });

  it('states an orders limit from the number when no display string is set', async () => {
    const page = await render(
      <Pricing
        tiers={CLOUD_TIERS.map((tier) =>
          tier.id === 'business' ? { ...tier, limits: { products: 5 }, display: {} } : tier,
        )}
      />,
    );
    expect(tierCard(page, 'business').textContent).toContain('No cap on orders');
    expect(tierCard(page, 'business').textContent).toContain('Up to 5 products');
  });

  it("says what stays the merchant's and how it works, and points at the plans", async () => {
    const page = await render(<Cloud />);
    const text = page.textContent ?? '';
    expect(text).toContain('never passes through us');
    expect(text).toContain('never leaves it');
    expect(text).toContain('export your store and run it yourself any time');
    const steps = [...page.querySelectorAll('section#cloud ol > li h3')].map(
      (heading) => heading.textContent,
    );
    expect(steps).toEqual(['Create your key', 'Pay the first month', 'Set up and launch']);
    const runCard = [...page.querySelectorAll('h3')].find(
      (heading) => heading.textContent === 'What we run',
    )?.parentElement;
    expect([...(runCard?.querySelectorAll('li') ?? [])].map((item) => item.textContent)).toEqual([
      'Your store node, online around the clock',
      'Watching the chains for your payments',
      'Signed order webhooks to your backend',
      'RPC endpoints, updates and monitoring',
    ]);
    expect(page.querySelector('ul[aria-label="Plans"]')).toBeNull();
    // The plans follow right below: no link to them.
    expect(page.querySelector('a[href="#pricing"]')).toBeNull();
  });

  it('hands an AI agent the cloud runbook, linked and copyable', async () => {
    const page = await render(<Cloud />);
    const prompt = page.querySelector('#cloud-agent-prompt');
    expect(prompt?.textContent).toBe(CLOUD_AGENT_PROMPT);
    expect(prompt?.querySelector('a')?.getAttribute('href')).toBe(
      'https://docs.elisym.network/commerce/cloud-agents.md',
    );
    expect(prompt?.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(CLOUD_AGENT_PROMPT).toContain('only after I agree to the terms');
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    const button = page.querySelector('button');
    await act(async () => button?.click());
    expect(written).toEqual([CLOUD_AGENT_PROMPT]);
    expect(button?.textContent).toBe('Copied');
  });

  it('holds nothing: no form, no input, and the page CSP is unchanged', async () => {
    for (const section of [<Cloud key="cloud" />, <Pricing key="pricing" />]) {
      const page = await render(section);
      expect(page.querySelector('form, input, iframe')).toBeNull();
      // The only button copies the agent prompt to the clipboard: it sends nothing.
      expect([...page.querySelectorAll('button')].map((button) => button.textContent)).toEqual(
        section.key === 'cloud' ? ['Copy prompt'] : [],
      );
      await act(async () => root?.unmount());
      container?.remove();
    }
    const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      headers: { headers: { key: string; value: string }[] }[];
    };
    const csp = config.headers
      .flatMap((rule) => rule.headers)
      .find((header) => header.key === 'Content-Security-Policy')?.value;
    expect(csp).toBe(
      "default-src 'none'; script-src 'self' https://pay.elisym.network; frame-src https://pay.elisym.network; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    );
  });

  it('names the rails, each plan audience, the White-label terms and the own-RPC line, and how plans are billed', async () => {
    const page = await render(<Pricing />);
    const text = page.textContent ?? '';
    expect(text).toContain(
      'Every plan takes payments on Solana, Base, Arbitrum, Ethereum and Tempo, straight to your own wallets. Paste one script and a button; we run the rest.',
    );
    expect(CLOUD_TIERS.map((tier) => tier.audience)).toEqual([
      'For a first store',
      'For a store with steady sales',
      'For deposits matched to player or customer accounts',
      'For platforms that onboard merchants',
    ]);
    for (const tier of CLOUD_TIERS) {
      expect(tierCard(page, tier.id).textContent).toContain(tier.audience);
    }
    expect(tierCard(page, 'white-label').textContent).toContain(
      'Priced by the number of stores you run',
    );
    expect(tierCard(page, 'business').textContent).toContain(
      'Your own RPC on any network, if you want one',
    );
    expect(tierCard(page, 'starter').textContent).not.toMatch(/own rpc/i);
    // Every card's lines, exactly: its limits first, then what it includes.
    const lines = (id: string) =>
      [...tierCard(page, id).querySelectorAll('ul li')].map((item) => item.textContent);
    expect(lines('starter')).toEqual([
      'Up to 100 products',
      '2,000 paid orders a month included',
      'Solana, Base, Arbitrum, Ethereum and Tempo',
      'Signed order webhooks to your backend',
      'Monthly, by card or stablecoins',
    ]);
    expect(lines('business')).toEqual([
      'Up to 1,000 products',
      'No cap on orders',
      'Everything in Starter',
      'Your own RPC on any network, if you want one',
    ]);
    expect(lines('high-risk')).toEqual([
      'No cap on products',
      'No cap on orders',
      'Each deposit matched to an account, for your backend to credit',
      'Deposits only: no payouts to players',
      'Reviewed before launch',
    ]);
    expect(lines('white-label')).toEqual([
      'No cap on products',
      'No cap on orders',
      'Priced by the number of stores you run',
      'Checkout on your own domain',
      'Your brand, no "by Elisym"',
      'Optionally, a dedicated relay for your stores',
    ]);
    expect(page.querySelectorAll('section#pricing ul[aria-label="Plans"] > li')).toHaveLength(4);
    for (const tier of CLOUD_TIERS) {
      expect(tierCard(page, tier.id).querySelector('h3')?.textContent).toBe(tier.name);
      // The Start or Contact button sits at the card's bottom, level across the row.
      expect(tierCard(page, tier.id).querySelector(':scope > a')?.className).toContain('mt-auto');
    }
    expect(page.querySelector('section#pricing p.uppercase')?.textContent).toBe('Pricing');
    for (const tier of CLOUD_TIERS.filter((each) => each.highlighted !== true)) {
      expect(tierCard(page, tier.id).className).not.toContain('border-accent');
      expect(tierCard(page, tier.id).className).toContain('border-line');
    }
    expect(text).toContain(
      'Prices in US dollars. Self-serve plans are billed monthly by card or stablecoins. Buyers always pay straight to your wallets.',
    );
  });

  it('the FAQ offers the hosted option', async () => {
    const page = await render(<App />);
    expect(page.querySelector('#faq')?.textContent).toContain(
      'or let us host it for a monthly fee (see Run it in our cloud)',
    );
  });
});

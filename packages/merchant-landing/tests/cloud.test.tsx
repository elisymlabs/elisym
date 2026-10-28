import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { Cloud } from '../src/components/Cloud';
import { CLOUD_CONSOLE_URL, CLOUD_TIERS, CONTACT_URL, cloudStartUrl } from '../src/constants';

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
  it('is on the page and in the header', async () => {
    const page = await render(<App />);
    expect(page.querySelector('section#cloud h2')?.textContent).toBe('Run it in our cloud');
    expect(page.querySelector('header a[href="#cloud"]')).not.toBeNull();
  });

  it("starts only Starter and Business, on the console's own origin, with no handle and no referrer", async () => {
    const page = await render(<Cloud />);
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

  it('sends High-risk and White-label to "Contact us", never to a Start', async () => {
    const page = await render(<Cloud />);
    for (const id of ['high-risk', 'white-label']) {
      const links = [...tierCard(page, id).querySelectorAll('a')];
      expect(links.map((link) => [link.textContent, link.getAttribute('href'), link.rel])).toEqual([
        ['Contact us', CONTACT_URL, 'noopener noreferrer'],
      ]);
      expect(links[0]?.getAttribute('aria-label')).toBe(
        `Contact us about ${id === 'high-risk' ? 'High-risk' : 'White-label'}`,
      );
      expect(tierCard(page, id).textContent).toContain('Custom pricing');
    }
    expect(CLOUD_TIERS.filter((tier) => tier.selfServe).map((tier) => tier.id)).toEqual([
      'starter',
      'business',
    ]);
  });

  it("says what stays the merchant's, how it works, and a price only once one is set", async () => {
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
    expect(page.querySelector('ul[aria-label="Plans"]')).not.toBeNull();
    expect(text).toContain(
      'Self-serve prices, and how many orders each plan includes a month, are announced at launch.',
    );
    expect(tierCard(page, 'high-risk').textContent).toContain('no payouts to players');
    for (const tier of CLOUD_TIERS.filter((each) => each.selfServe)) {
      expect(tierCard(page, tier.id).textContent).toContain(tier.price ?? 'Price at launch');
    }
  });

  it('holds nothing: no form, no input, and the page CSP is unchanged', async () => {
    const page = await render(<Cloud />);
    expect(page.querySelector('form, input, button, iframe')).toBeNull();
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

  it('shows a price once one is set', async () => {
    const page = await render(
      <Cloud
        tiers={CLOUD_TIERS.map((tier) =>
          tier.id === 'starter' ? { ...tier, price: 'from $19 / month' } : tier,
        )}
      />,
    );
    expect(tierCard(page, 'starter').textContent).toContain('from $19 / month');
    expect(tierCard(page, 'business').textContent).toContain('Price at launch');
  });

  it('the FAQ offers the hosted option', async () => {
    const page = await render(<App />);
    expect(page.querySelector('#faq')?.textContent).toContain(
      'or let us host it for a monthly fee (see Run it in our cloud)',
    );
  });
});

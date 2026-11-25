import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanUrlProblems,
  htmlProblems,
  pageSetProblems,
  stylesheetProblems,
  withPrerendered,
} from '../scripts/build-checks';
import { App } from '../src/App';
import { LegalNotice } from '../src/components/LegalNotice';
import { PageLink } from '../src/components/PageLink';
import { PrivacyPolicy } from '../src/components/PrivacyPolicy';
import { TermsOfService } from '../src/components/TermsOfService';
import { CONTACT_REDIRECT_URL } from '../src/constants';
import {
  LEGAL_ADDRESS,
  LEGAL_EMAIL,
  LEGAL_LAST_UPDATED,
  LEGAL_NAME,
  LEGAL_NIF,
  PRIVACY_PATH,
  TERMS_PATH,
} from '../src/legal';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PACKAGE = process.cwd();
const PACKAGES = join(PACKAGE, '..');

const LEGAL_PAGES = [
  { name: 'privacy policy', file: 'privacy', path: PRIVACY_PATH, element: <PrivacyPolicy /> },
  {
    name: 'terms of service',
    file: 'terms-of-service',
    path: TERMS_PATH,
    element: <TermsOfService />,
  },
];

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

function read(path: string): string {
  return readFileSync(join(PACKAGES, path), 'utf8');
}

function vercelConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PACKAGE, 'vercel.json'), 'utf8'));
}

/** The page's text with runs of whitespace as one space, as a reader sees it. */
function textOf(page: HTMLElement): string {
  return (page.textContent ?? '').replace(/\s+/g, ' ');
}

/** The text of the section `id` on a rendered page; throws when there is none. */
function sectionText(page: HTMLElement, id: string): string {
  const node = page.querySelector(`#${id}`);
  if (!(node instanceof HTMLElement)) {
    throw new Error(`no section ${id}`);
  }
  return textOf(node);
}

describe('the legal pages are served', () => {
  it('at /privacy and /terms-of-service, each its own HTML page with its own script', () => {
    expect(PRIVACY_PATH).toBe('/privacy');
    expect(TERMS_PATH).toBe('/terms-of-service');
    expect(
      readdirSync(PACKAGE)
        .filter((file) => file.endsWith('.html'))
        .sort(),
    ).toEqual(['index.html', 'privacy.html', 'terms-of-service.html']);
    for (const { file } of LEGAL_PAGES) {
      const html = readFileSync(join(PACKAGE, `${file}.html`), 'utf8');
      expect(html).toContain(`<script type="module" src="/src/${file}.tsx"></script>`);
      expect(html).toContain(`content="https://askr.elisym.network/${file}"`);
      expect(html).toContain('<div id="root"></div>');
      expect(existsSync(join(PACKAGE, 'src', `${file}.tsx`))).toBe(true);
    }
  });

  it('without .html (cleanUrls), with /terms sent on to /terms-of-service', () => {
    const config = vercelConfig();
    expect(config.cleanUrls).toBe(true);
    expect(cleanUrlProblems({ cleanUrls: true })).toEqual([]);
    expect(cleanUrlProblems({})).toHaveLength(1);
    expect(config.redirects).toContainEqual({
      source: '/terms',
      destination: TERMS_PATH,
      permanent: false,
    });
  });

  it('linked from the landing footer, in the same tab', async () => {
    const page = await render(<App />);
    expect(textOf(page)).toContain(
      'Prices include VAT or sales tax where it applies: checkout charges the price shown.',
    );
    const footer = page.querySelector('footer');
    for (const path of [PRIVACY_PATH, TERMS_PATH]) {
      const link = footer?.querySelector(`a[href="${path}"]`);
      expect(link, path).not.toBeNull();
      expect(link?.getAttribute('target')).toBeNull();
    }
  });
});

describe('the build checks', () => {
  it('want every source page built, and no built page without a source', () => {
    const pages = ['index.html', 'privacy.html'];
    expect(pageSetProblems(pages, pages)).toEqual([]);
    expect(pageSetProblems(['index.html'], pages)).toEqual(['privacy.html was not built']);
    expect(pageSetProblems([...pages, 'extra.html'], pages)).toEqual([
      'extra.html is built but has no source page',
    ]);
  });

  it('want each page to link its stylesheet', () => {
    expect(stylesheetProblems('<link rel="stylesheet" crossorigin href="/assets/a.css">')).toEqual(
      [],
    );
    expect(stylesheetProblems('<link rel="icon" href="/favicon.svg">')).toEqual(['no stylesheet']);
  });

  it('put the prerendered text into the empty #root, even with a $ in it', () => {
    const html = '<body><div id="root"></div></body>';
    expect(withPrerendered(html, "<p>$29 and $& and $'</p>")).toBe(
      '<body><div id="root"><p>$29 and $& and $\'</p></div></body>',
    );
    expect(() => withPrerendered('<body></body>', '<p></p>')).toThrow();
  });

  it('let a page link to other sites, but not load from them or carry inline styles', () => {
    expect(
      htmlProblems('<a href="https://www.aepd.es">aepd.es</a><a href="mailto:x@y">x</a>'),
    ).toEqual([]);
    expect(htmlProblems('<img src="https://cdn.example/x.png">')).toHaveLength(1);
    expect(htmlProblems('<abbr><link href="https://cdn.example/x.css"></abbr>')).toHaveLength(1);
    expect(htmlProblems('<p style="color: red">x</p>')).toEqual(['an inline style']);
  });
});

describe.each(LEGAL_PAGES)('the $name', ({ element }) => {
  it('has one h1 first, never skips a heading level, and says when it last changed', async () => {
    const page = await render(element);
    const levels = [...page.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) =>
      Number(heading.tagName.slice(1)),
    );
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    levels.forEach((level, index) => {
      expect(level, `heading ${index}`).toBeLessThanOrEqual((levels[index - 1] ?? 1) + 1);
    });
    expect(textOf(page)).toContain(`Last updated: ${LEGAL_LAST_UPDATED}`);
    expect(textOf(page)).not.toMatch(/draft/i);
  });

  it('names the operator and the email, and shows no empty NIF or address line', async () => {
    const page = await render(element);
    const notice = page.querySelector('[aria-labelledby="legal-notice"]');
    expect(notice?.textContent).toContain(LEGAL_NAME);
    expect(notice?.querySelector(`a[href="mailto:${LEGAL_EMAIL}"]`)).not.toBeNull();
    const terms = [...(notice?.querySelectorAll('dt') ?? [])].map((term) => term.textContent);
    expect(terms.includes('NIF')).toBe(LEGAL_NIF.length > 0);
    expect(terms.includes('Address')).toBe(LEGAL_ADDRESS.length > 0);
    expect(textOf(page)).not.toMatch(/<pending>|TODO|undefined/i);
  });

  it('gives the email and the request form as the contact', async () => {
    const page = await render(element);
    const main = page.querySelector('main');
    expect(main?.querySelector(`a[href="${CONTACT_REDIRECT_URL}"]`)).not.toBeNull();
    expect(main?.querySelectorAll(`a[href="mailto:${LEGAL_EMAIL}"]`).length).toBeGreaterThan(1);
  });

  it('points its section links at the landing, and sends other sites to a new tab', async () => {
    const landing = await render(<App />);
    const ids = new Set([...landing.querySelectorAll('[id]')].map((node) => node.id));
    await act(async () => root?.unmount());
    container?.remove();
    const page = await render(element);
    const links = [...page.querySelectorAll('a')];
    expect(page.querySelectorAll('a[href^="#"]')).toHaveLength(0);
    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      if (href.startsWith('/#')) {
        expect(ids.has(href.slice(2)), href).toBe(true);
      } else if (href.startsWith('/') || href.startsWith('mailto:')) {
        expect(link.getAttribute('target'), href).toBeNull();
      } else {
        expect(href).toMatch(/^https:\/\//);
        expect(link.getAttribute('target'), href).toBe('_blank');
        expect(link.rel).toBe('noopener noreferrer');
      }
    }
  });
});

describe('the privacy policy says what the code does', () => {
  it('the message size, the session length and the relay', async () => {
    const page = textOf(await render(<PrivacyPolicy />));
    expect(read('askr/src/constants.ts')).toContain('ASK_TEXT_CHARS: 2_000,');
    expect(page).toContain('up to 2,000 characters');
    expect(read('askr/src/constants.ts')).toContain(
      'export const SESSION_TTL_SECS = 24 * 60 * 60;',
    );
    expect(page).toContain('up to 24 hours from your first message');
    expect(read('askr/src/constants.ts')).toContain("['wss://relay.elisym.network']");
    expect(page).toContain('relay.elisym.network');
  });

  it('the browser storage the chat and the admin use', async () => {
    const page = textOf(await render(<PrivacyPolicy />));
    const widget = read('askr-widget/src/constants.ts');
    expect(widget).toContain("export const STORAGE_PREFIX = 'askr:';");
    for (const prefix of ['v:', 'card:', 'open:']) {
      expect(widget).toContain(`\${STORAGE_PREFIX}${prefix}`);
      expect(page).toContain(`"askr:${prefix}"`);
    }
    expect(read('askr-admin/src/lib/remembered.ts')).toContain(
      "const STORAGE_KEY = 'askr-admin.remembered-keys';",
    );
    expect(read('askr-admin/src/lib/remembered.ts')).toContain("const DEVICE_DB = 'askr-admin';");
    expect(read('askr-admin/src/lib/tab-session.ts')).toContain(
      "const TAB_SESSION_KEY = 'askr-admin-tab-session';",
    );
    for (const key of ['askr-admin.remembered-keys', 'askr-admin', 'askr-admin-tab-session']) {
      expect(page).toContain(`"${key}"`);
    }
  });

  it('the page address without its query or fragment, and no China-hosted model host', async () => {
    const page = textOf(await render(<PrivacyPolicy />));
    expect(read('askr-widget/src/client.ts')).toContain(
      'page = `${parsed.origin}${parsed.pathname}`;',
    );
    expect(page).toContain('never the query (?…) or fragment (#…) part');
    const config = read('askr-server/src/config.ts');
    expect(config).toContain("data_collection: 'deny'");
    expect(config).toContain('allow_fallbacks: false');
    expect(page).toContain('never a host in China');
  });
});

describe('the links between pages', () => {
  it('open another host (//host) in a new tab with no referrer, and a path on this site in place', async () => {
    const page = await render(
      <p>
        <PageLink href="//example.com/x" className="">
          other
        </PageLink>
        <PageLink href={PRIVACY_PATH} className="">
          privacy
        </PageLink>
      </p>,
    );
    const [other, privacy] = [...page.querySelectorAll('a')];
    expect(other?.getAttribute('target')).toBe('_blank');
    expect(other?.rel).toBe('noopener noreferrer');
    expect(privacy?.getAttribute('target')).toBeNull();
    expect(privacy?.getAttribute('rel')).toBeNull();
  });
});

describe('the legal notice', () => {
  it('is a valid list: each term and its value grouped in one div', async () => {
    const page = await render(<LegalNotice />);
    const list = page.querySelector('dl');
    const children = [...(list?.children ?? [])];
    expect(children.length).toBeGreaterThan(0);
    for (const group of children) {
      expect(group.tagName).toBe('DIV');
      expect([...group.children].map((child) => child.tagName)).toEqual(['DT', 'DD']);
    }
  });
});

describe('the legal pages say what the code and the setup do', () => {
  it('a removed product is republished hidden with a deletion event, which relays may ignore', async () => {
    const sync = read('askr/src/sync.ts');
    expect(sync).toContain(".concat([['visibility', 'hidden']])");
    expect(sync).toContain('toPublish.push({ d, template: deletionOf(d, hiddenAt) });');
    const page = textOf(await render(<PrivacyPolicy />));
    expect(page).toContain('published again marked hidden');
    expect(page).toContain('The listing itself may stay readable on relays.');
    expect(page).toContain("remove its events from our relay's database");
  });

  it('the request form is a Google form, and both are named as processors', async () => {
    expect(new URL(CONTACT_REDIRECT_URL).pathname).toBe('/contact');
    expect(vercelConfig().redirects).toContainEqual(
      expect.objectContaining({
        source: '/contact',
        destination: expect.stringMatching(/^https:\/\/forms\.gle\//),
      }),
    );
    const page = textOf(await render(<PrivacyPolicy />));
    expect(page).toContain('Google (Google Forms): our request form');
    expect(page).toContain(
      `Zoho (Zoho Mail): the emails you send to and receive from ${LEGAL_EMAIL}.`,
    );
  });

  it('paid plans are bought self-serve through Stripe Checkout, and an unpaid or canceled plan falls back to Free or pending', async () => {
    const termsPage = await render(<TermsOfService />);
    const terms = textOf(termsPage);
    expect(terms).not.toContain('Until self-serve checkout opens');
    // A store is suspended only for breaking the rules (section 6), never for an unpaid plan.
    expect(sectionText(termsPage, 'billing')).not.toContain('suspend');
    expect(terms).not.toMatch(/is deactivated/);
    for (const sentence of [
      'Paid plans are sold through Stripe as the merchant of record: checkout and your card statement show the sale as made through Link',
      'Prices on our site include the applicable tax: Stripe charges the price shown and states the tax it includes on the receipt.',
      'Refunds and payment disputes may be handled by Stripe under its own terms.',
      'If you are a consumer in the European Union or the United Kingdom, you can cancel a purchase within 14 days of getting access to it, as Link\'s terms describe: ask Link support for a refund and give "cooling-off period" as the reason.',
      'A subscription renews automatically at the end of each period until you cancel it.',
      'You can change or cancel your plan at any time with "Manage billing" in the admin (it opens Stripe\'s customer portal), at link.com, or by writing to us.',
      'After a cancel the plan stays active until the end of the period you paid for and is not renewed; the store then moves to the Free plan if Free has room, otherwise it is paused (pending) until you choose a plan.',
      'If a payment fails, Stripe tries it again for up to about a week, and your store keeps working on its plan meanwhile.',
      'If the payment still fails, the subscription ends and the store moves to the Free plan if Free has room, otherwise it is paused (pending) and the chat stops answering until you choose a plan.',
      "Your store's data is kept.",
      'Periods already paid are not refunded, unless the law requires it or Stripe refunds them under its terms.',
      'Prices are set in US dollars; checkout may show and charge them in your local currency; a renewal charged in your local currency may differ with exchange rates.',
      'Stripe takes the payment, issues the receipt and supports payments and subscriptions at link.com.',
      'You buy one yourself in the admin, or at the checkout link the Askr CLI gives you, through Stripe Checkout; the plan starts once the payment goes through.',
      'nothing in them limits the rights consumers have under mandatory law',
      'you may go to the courts of that country where the law gives you that right',
      'Askr is for anyone who runs an online store, whether a business or an individual.',
      "remove its events from our relay's database (a relay backup drops them when it is replaced)",
    ]) {
      expect(terms).toContain(sentence);
    }
    expect(terms).not.toMatch(/businesses only|reverse charge|VAT ID|IGIC|billing portal/);
    await act(async () => root?.unmount());
    container?.remove();
    const privacyPage = await render(<PrivacyPolicy />);
    const privacy = textOf(privacyPage);
    expect(privacy).not.toContain('Until self-serve checkout opens');
    expect(privacy).toContain(
      'You buy a paid plan yourself in the admin, or at the checkout link the Askr CLI gives you, through Stripe Checkout.',
    );
    expect(privacy).toContain(
      "Our server keeps only your Stripe customer ID; for each subscription, its ID, status, plan, billing period, whether it is set to cancel, when Stripe created it, when its current period ends and when we last updated it; and the ID of the last checkout your store opened, all linked to your store's public key (its Store ID).",
    );
    expect(privacy).toContain(
      'It also keeps the IDs and types of the Stripe events it received, and log lines that name your store and the event. Your card details never reach it.',
    );
    expect(sectionText(privacyPage, 'merchants')).toContain('Sold through Link');
    expect(privacy).toContain(
      "the merchant of record for paid plans. It receives buyers' payment data directly and is an independent controller for it, under its own privacy policy.",
    );
    expect(privacy).toContain(
      'Stripe shares with us, in our Stripe account, your name, email address, billing address, the plan, its billing period, payment status and invoices, and the card brand and last digits.',
    );
    expect(privacy).toContain(
      'These providers process data for us, or, where noted, receive it as controllers in their own right:',
    );
    expect(privacy).not.toMatch(/Stripe, Inc\.|Stripe Payments Europe|Stripe Payments/);
    expect(privacy).not.toMatch(/We receive only/);
    expect(privacy).toContain(
      'We receive the customer and subscription details Stripe shares with us (section 2), never the full card number.',
    );
    expect(privacy.match(/full card number/g)).toHaveLength(2);
  });

  it('the terms hold the data processing agreement, numbered in order', async () => {
    const page = await render(<TermsOfService />);
    const titles = [...page.querySelectorAll('main h2')]
      .map((heading) => heading.textContent ?? '')
      .filter((title) => /^\d+\. /.test(title));
    titles.forEach((title, index) => expect(title.startsWith(`${index + 1}. `), title).toBe(true));
    expect(titles).toContain('8. Data processing');
    expect(textOf(page)).toContain(
      'This section is the data processing agreement between you and us.',
    );
    const text = textOf(page);
    expect(text).toContain(
      "delete that data at the end of the service: chats are deleted within 24 hours anyway, and gone from the server's snapshots within 7 days, and the rest as the privacy policy describes",
    );
    expect(text).toContain(
      'tell you without undue delay, by email if you gave us one, of a personal data breach',
    );
    expect(text).toContain('allow reasonable audits of them');
    expect(text).toContain('bound by data protection obligations equivalent to these');
    expect(text).toContain(
      "When a store is closed, we delete its data from our server and remove its events from our relay's database",
    );
  });
});

describe('the privacy policy keeps its promises in step with the terms', () => {
  it('announces model and host changes before they apply', async () => {
    const page = textOf(await render(<PrivacyPolicy />));
    expect(page).toContain(
      'keeping them in the United States or the European Union, and announce changes on this page before they apply.',
    );
  });

  it('says the logs never hold IP addresses, in section 2 and section 3', async () => {
    const page = await render(<PrivacyPolicy />);
    const logs =
      "servers and relay keep no access or connection logs. Their logs never contain IP addresses; they may contain Store IDs and error details, are capped in size and overwritten, and also sit in the server's 7-day snapshots.";
    for (const id of ['merchants', 'shoppers']) {
      expect(sectionText(page, id), id).toContain(logs);
    }
  });

  it('gives the same 7 days for snapshots in sections 2, 3, 5 and 7 as the terms', async () => {
    const page = await render(<PrivacyPolicy />);
    const section = (id: string): string => sectionText(page, id);
    expect(section('merchants')).toContain("sit in the server's 7-day snapshots");
    expect(section('shoppers')).toContain(
      'keeps each for 7 days, so a chat from the last 24 hours can remain in them for up to 7 days',
    );
    expect(section('processors')).toContain(
      'daily snapshot of the whole server and keeps each for 7 days',
    );
    expect(section('rights')).toContain("gone from the server's snapshots within 7 days");
    for (const id of ['merchants', 'shoppers', 'processors', 'rights']) {
      expect(section(id), id).not.toMatch(/snapshots?[^.]*\b(?!7\b)\d+[ -]days?/);
    }
    await act(async () => root?.unmount());
    container?.remove();
    const terms = textOf(await render(<TermsOfService />));
    expect(terms).toContain("gone from the server's snapshots within 7 days");
  });

  it('the terms define the processing by reference to the privacy policy', async () => {
    const terms = textOf(await render(<TermsOfService />));
    expect(terms).toContain(
      'Its subject matter, duration, nature and purpose, the kinds of personal data and the people concerned (your shoppers) are those described in section 3 of our privacy policy.',
    );
  });

  it('says a relay backup is replaced, not kept, in sections 4 and 5', async () => {
    const page = await render(<PrivacyPolicy />);
    const backup =
      "We may take occasional manual backups of the relay's data for recovery, and keep at most the latest one: closed stores' events and expired chats leave it when it is replaced.";
    for (const id of ['public', 'processors']) {
      expect(sectionText(page, id), id).toContain(backup);
    }
  });
});

describe('facts the privacy policy repeats agree between sections', () => {
  it('the relay is in Ashburn, Virginia, in sections 3 and 5', async () => {
    const page = await render(<PrivacyPolicy />);
    for (const id of ['shoppers', 'processors']) {
      expect(sectionText(page, id), id).toContain('Ashburn, Virginia, United States');
    }
  });

  it('the dumps hold no chats since the same date, in sections 3 and 5', async () => {
    const page = await render(<PrivacyPolicy />);
    expect(sectionText(page, 'shoppers')).toContain(
      'Since 21 November 2026, our nightly database dumps contain no chat messages.',
    );
    expect(sectionText(page, 'processors')).toContain(
      'since 21 November 2026 they contain no chat messages or per-chat counts',
    );
    for (const id of ['shoppers', 'processors']) {
      const dates = sectionText(page, id).match(/since \d{1,2} \w+ \d{4}/gi) ?? [];
      expect(dates.length, id).toBeGreaterThan(0);
      expect(new Set(dates.map((date) => date.toLowerCase())), id).toEqual(
        new Set(['since 21 november 2026']),
      );
    }
  });
});

describe('the Shopify app in the privacy policy (askr-shopify launch prep)', () => {
  it('names what the app reads, keeps and erases, and Shopify as a controller', async () => {
    const page = await render(<PrivacyPolicy />);
    const merchants = sectionText(page, 'merchants');
    expect(merchants).toContain('The Askr app for Shopify.');
    expect(merchants).toContain('only to read products and legal policies');
    expect(merchants).toContain('It reads no customer, order or payment data.');
    expect(merchants).toContain('never what it said');
    expect(merchants).toContain('48 hours later, when Shopify asks apps to erase');
    expect(sectionText(page, 'processors')).toContain('Shopify, if you use our Shopify app');
  });
});

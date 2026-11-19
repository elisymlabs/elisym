import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Decimal from 'decimal.js-light';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import {
  ADMIN_URL,
  CONTACT_URL,
  CONVERSATION_DEFINITION,
  PLANS,
  PRODUCT_NAME,
  YEARLY_DISCOUNT_BPS,
  YEARLY_DISCOUNT_LABEL,
  isContractPlan,
  isFlatPlan,
} from '../src/constants';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let container: HTMLElement | undefined;

async function render(): Promise<HTMLElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<App />));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

function dollars(text: string): Decimal {
  return new Decimal(text.replace('$', '').replaceAll(',', ''));
}

/** The plan cards, in order. */
function cards(page: HTMLElement): Element[] {
  return [...page.querySelectorAll('#pricing li:has(> div > div > h3)')];
}

/** The card showing `name`, choosing it on the size switch first when it is one of the sizes. */
async function cardOf(page: HTMLElement, name: string): Promise<Element | undefined> {
  const size = [
    ...page.querySelectorAll<HTMLButtonElement>(
      '#pricing [role="radiogroup"][aria-label="Plan size"] [role="radio"]',
    ),
  ].find((radio) => radio.textContent === name);
  if (size !== undefined) {
    await act(async () => size.click());
  }
  return cards(page).find((card) => card.querySelector('h3')?.textContent === name);
}

/** The plans as agreed, written out: any drift in the table fails here. */
const AGREED = [
  {
    name: 'Free',
    price: ['$0', '$0', '$0'],
    features: [
      'About 50 conversations a month',
      'Up to 100 products',
      'Syncs with your shop once a day',
      'Shows "Powered by Askr"',
      'Up to 20 sites',
    ],
    start: 'admin',
  },
  {
    name: 'Starter',
    price: ['$29', '$23', '$276'],
    features: [
      'About 500 conversations a month',
      'Up to 1,000 products',
      'Syncs every 6 hours',
      'Shows "Powered by Askr"',
      'Up to 20 sites',
    ],
    start: 'choose',
  },
  {
    name: 'Growth',
    price: ['$99', '$79', '$948'],
    features: [
      'About 2,000 conversations a month',
      'Up to 5,000 products',
      'Syncs every hour',
      'Shows "Powered by Askr"',
      'Up to 20 sites',
    ],
    start: 'choose',
  },
  {
    name: 'Pro',
    price: ['$199', '$159', '$1,908'],
    features: [
      'About 6,000 conversations a month',
      'Up to 10,000 products',
      'Syncs every 30 minutes',
      '"Powered by Askr" can be removed',
      'Up to 20 sites',
    ],
    start: 'choose',
  },
  {
    name: 'Scale',
    price: ['$499', '$399', '$4,788'],
    features: [
      'About 15,000 conversations a month',
      'Up to 20,000 products',
      'Syncs every 15 minutes',
      '"Powered by Askr" can be removed',
      'Up to 20 sites',
    ],
    start: 'choose',
  },
  {
    name: 'Enterprise',
    price: ['$1,500'],
    features: [
      'From 25,000 conversations a month',
      'Catalog size and sync by agreement',
      'An SLA',
      '"Powered by Askr" can be removed',
    ],
    start: 'contact',
  },
];

describe('the plans', () => {
  it('are the agreed table, word for word', () => {
    expect(
      PLANS.map((plan) => ({
        name: plan.name,
        price:
          plan.price.kind === 'flat'
            ? [plan.price.monthly, plan.price.yearlyPerMonth, plan.price.yearlyTotal]
            : [plan.price.monthly],
        features: plan.features,
        start: plan.start,
      })),
    ).toEqual(AGREED);
    expect(CONTACT_URL).toBe('https://t.me/new_acc_nata');
    expect(CONVERSATION_DEFINITION).toBe(
      "A conversation is one visitor's chat, up to 24 hours from their first message, that got at least one answer.",
    );
  });

  it('write the discount as its basis points say', () => {
    expect(YEARLY_DISCOUNT_LABEL).toBe(`${new Decimal(YEARLY_DISCOUNT_BPS).div(100).toString()}%`);
  });

  it('are the final six, in order, with Growth featured and Growth, Pro and Scale as sizes', () => {
    expect(PLANS.map((plan) => plan.name)).toEqual([
      'Free',
      'Starter',
      'Growth',
      'Pro',
      'Scale',
      'Enterprise',
    ]);
    expect(PLANS.filter((plan) => plan.featured).map((plan) => plan.name)).toEqual(['Growth']);
    expect(PLANS.filter((plan) => plan.group === 'sizes').map((plan) => plan.name)).toEqual([
      'Growth',
      'Pro',
      'Scale',
    ]);
  });

  it('take 20% off for yearly billing, and the yearly total is twelve of those months', () => {
    expect(YEARLY_DISCOUNT_BPS).toBe(2000);
    const keep = new Decimal(10_000 - YEARLY_DISCOUNT_BPS).div(10_000);
    for (const plan of PLANS) {
      if (plan.price.kind !== 'flat') {
        continue;
      }
      const monthly = dollars(plan.price.monthly);
      const perMonth = dollars(plan.price.yearlyPerMonth);
      expect(perMonth.toString(), plan.name).toBe(
        monthly.times(keep).toDecimalPlaces(0, Decimal.ROUND_DOWN).toString(),
      );
      expect(dollars(plan.price.yearlyTotal).toString(), plan.name).toBe(
        perMonth.times(12).toString(),
      );
    }
  });

  it('let only Pro, Scale and Enterprise remove "Powered by Askr"', () => {
    const removable = PLANS.filter((plan) =>
      plan.features.includes(`"Powered by ${PRODUCT_NAME}" can be removed`),
    ).map((plan) => plan.name);
    expect(removable).toEqual(['Pro', 'Scale', 'Enterprise']);
    for (const plan of PLANS.filter((entry) => !removable.includes(entry.name))) {
      expect(plan.features, plan.name).toContain(`Shows "Powered by ${PRODUCT_NAME}"`);
    }
  });

  it('allow the sites the protocol allows', () => {
    const limits = readFileSync(join(process.cwd(), '../askr/src/constants.ts'), 'utf8');
    const max = /MAX_ORIGINS: (\d+)/.exec(limits)?.[1];
    for (const plan of PLANS.filter((entry) => entry.price.kind === 'flat')) {
      expect(plan.features, plan.name).toContain(`Up to ${max} sites`);
    }
  });

  it('give conversations as approximate and list no per-visitor limits', () => {
    for (const plan of PLANS) {
      const conversations = plan.features.find((feature) => feature.includes('conversations'));
      expect(conversations, plan.name).toMatch(/^(About|From) [\d,]+ conversations a month$/);
      expect(plan.features.join(' '), plan.name).not.toMatch(/per visitor|per minute|per day/i);
    }
  });
});

describe('the pricing section', () => {
  it('shows Free, Starter, one card for the sizes and Enterprise, yearly first', async () => {
    const page = await render();
    expect(cards(page).map((card) => card.querySelector('h3')?.textContent)).toEqual([
      'Free',
      'Starter',
      'Growth',
      'Enterprise',
    ]);
    const sizes = [
      ...page.querySelectorAll(
        '#pricing [role="radiogroup"][aria-label="Plan size"] [role="radio"]',
      ),
    ];
    expect(sizes.map((radio) => radio.textContent)).toEqual(['Growth', 'Pro', 'Scale']);
    expect(sizes.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    const billing = [
      ...page.querySelectorAll<HTMLButtonElement>(
        '#pricing [role="radiogroup"][aria-label="Billing period"] [role="radio"]',
      ),
    ];
    expect(billing.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    await act(async () => billing[0]?.click());
    for (const plan of PLANS) {
      const card = await cardOf(page, plan.name);
      expect(card?.textContent, plan.name).toContain(plan.price.monthly);
      expect(card?.textContent, plan.name).toContain(plan.blurb);
      for (const feature of plan.features) {
        expect(card?.textContent, plan.name).toContain(feature);
      }
    }
    const pricing = page.querySelector('#pricing')?.textContent ?? '';
    expect(pricing).toContain(CONVERSATION_DEFINITION);
    expect(pricing).toContain('Conversation counts are approximate.');
    expect(pricing).toContain('spend cap');
  });

  it('switches between monthly and yearly prices, leaving Free and Enterprise as they are', async () => {
    const page = await render();
    const radios = [
      ...page.querySelectorAll<HTMLButtonElement>(
        '#pricing [role="radiogroup"][aria-label="Billing period"] [role="radio"]',
      ),
    ];
    expect(radios.map((radio) => radio.textContent)).toEqual(['Monthly', 'Yearly']);
    await act(async () => radios[0]?.click());
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    await act(async () => radios[1]?.click());
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    for (const plan of PLANS) {
      const text = (await cardOf(page, plan.name))?.textContent ?? '';
      if (plan.price.kind === 'from' || plan.price.monthly === '$0') {
        expect(text, plan.name).toContain(plan.price.monthly);
        expect(text, plan.name).not.toContain('billed yearly');
      } else {
        expect(text, plan.name).toContain(plan.price.yearlyPerMonth);
        expect(text, plan.name).toContain(`${plan.price.yearlyTotal} billed yearly`);
      }
    }
  });

  it('moves between options with the arrow keys, one tab stop for each switch', async () => {
    const page = await render();
    for (const [label, count] of [
      ['Billing period', 2],
      ['Plan size', 3],
    ] as const) {
      const group = page.querySelector(`#pricing [role="radiogroup"][aria-label="${label}"]`);
      const radios = [...(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
      expect(radios, label).toHaveLength(count);
      expect(
        radios.filter((radio) => radio.tabIndex === 0),
        label,
      ).toHaveLength(1);
      const start = radios.findIndex((radio) => radio.getAttribute('aria-checked') === 'true');
      await act(async () => {
        group?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      });
      const next = (start + 1) % count;
      expect(radios[next]?.getAttribute('aria-checked'), label).toBe('true');
      expect(radios[next]?.tabIndex, label).toBe(0);
      expect(document.activeElement, label).toBe(radios[next]);
      await act(async () => {
        group?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      });
      expect(radios[start]?.getAttribute('aria-checked'), label).toBe('true');
    }
  });

  it('starts Free in the admin and every other plan with us', async () => {
    const page = await render();
    for (const plan of PLANS) {
      const links = [...((await cardOf(page, plan.name))?.querySelectorAll('a') ?? [])];
      expect(
        links.map((link) => link.href),
        plan.name,
      ).toEqual([plan.start === 'admin' ? ADMIN_URL : CONTACT_URL]);
      expect(links[0]?.textContent, plan.name).toBe(
        { admin: 'Start free', choose: `Choose ${plan.name}`, contact: 'Contact us' }[plan.start],
      );
    }
  });

  it('reads every price as a subscription, and says what yearly billing pays', async () => {
    const page = await render();
    const pricing = () => page.querySelector('#pricing')?.textContent ?? '';
    expect(pricing()).toContain(`Save ${YEARLY_DISCOUNT_LABEL} yearly`);
    expect(pricing()).toContain(
      `Plans are subscriptions priced per month; yearly billing pays twelve months up front at ${YEARLY_DISCOUNT_LABEL} off.`,
    );
    expect((await cardOf(page, 'Growth'))?.textContent).toContain(
      'Subscription, $948 billed yearly',
    );
    expect((await cardOf(page, 'Free'))?.textContent).toContain('No payment needed');
    const enterprise = (await cardOf(page, 'Enterprise'))?.textContent ?? '';
    expect(enterprise).toContain('from$1,500/ month');
    expect(enterprise).toContain('Monthly subscription, terms by agreement');
    const billing = page.querySelectorAll<HTMLButtonElement>(
      '#pricing [role="radiogroup"][aria-label="Billing period"] [role="radio"]',
    );
    await act(async () => billing[0]?.click());
    expect((await cardOf(page, 'Pro'))?.textContent).toContain('Monthly subscription');
    expect((await cardOf(page, 'Pro'))?.textContent).not.toContain('billed yearly');
  });

  it('opens every paid plan and Enterprise on Telegram in a new tab', async () => {
    const page = await render();
    for (const plan of PLANS.filter((entry) => entry.start !== 'admin')) {
      const link = (await cardOf(page, plan.name))?.querySelector('a');
      expect(link?.getAttribute('target'), plan.name).toBe('_blank');
      expect(link?.getAttribute('rel'), plan.name).toBe('noopener noreferrer');
    }
  });

  it('takes the up and down arrows too, and keeps them from scrolling the page', async () => {
    const page = await render();
    const group = page.querySelector('#pricing [role="radiogroup"][aria-label="Plan size"]');
    const radios = [...(group?.querySelectorAll('[role="radio"]') ?? [])];
    const press = async (key: string) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      await act(async () => {
        group?.dispatchEvent(event);
      });
      return event;
    };
    const down = await press('ArrowDown');
    expect(down.defaultPrevented).toBe(true);
    expect(radios[1]?.getAttribute('aria-checked')).toBe('true');
    await press('ArrowUp');
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true');
    const other = await press('a');
    expect(other.defaultPrevented).toBe(false);
  });

  it('draws the focus ring light on ink, where the dark one would not show', () => {
    const css = readFileSync(join(process.cwd(), 'src/app.css'), 'utf8');
    expect(css).toMatch(
      /\.bg-ink :focus-visible,\s*\.on-ink-focus :focus-visible \{\s*outline-color: var\(--on-ink\);/,
    );
  });

  it('keeps the chosen size when the billing changes, on the ink card, Growth marked most popular', async () => {
    const page = await render();
    expect((await cardOf(page, 'Growth'))?.textContent).toContain('Most popular');
    const pro = await cardOf(page, 'Pro');
    expect(pro?.className).toContain('bg-ink');
    expect(pro?.textContent).not.toContain('Most popular');
    for (const name of ['Free', 'Starter', 'Enterprise']) {
      expect((await cardOf(page, name))?.textContent, name).not.toContain('Most popular');
    }
    const billing = page.querySelectorAll<HTMLButtonElement>(
      '#pricing [role="radiogroup"][aria-label="Billing period"] [role="radio"]',
    );
    await act(async () => billing[0]?.click());
    const sizes = [
      ...page.querySelectorAll(
        '#pricing [role="radiogroup"][aria-label="Plan size"] [role="radio"]',
      ),
    ];
    expect(sizes.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(cards(page).some((card) => card.querySelector('h3')?.textContent === 'Pro')).toBe(true);
  });

  it('puts every plan on the page: flat ones in cards, the contract one in its row', () => {
    const flat = PLANS.filter(isFlatPlan).map((plan) => plan.name);
    const contract = PLANS.filter(isContractPlan).map((plan) => plan.name);
    expect([...flat, ...contract].sort()).toEqual(PLANS.map((plan) => plan.name).sort());
    expect(contract).toEqual(['Enterprise']);
  });

  it('marks the closing for the light focus ring, and hides the FAQ toggles from screen readers', async () => {
    const page = await render();
    expect(page.querySelector('#closing .on-ink-focus a')).not.toBeNull();
    const toggles = [...page.querySelectorAll('#faq summary > span:last-child')];
    expect(toggles.length).toBeGreaterThan(0);
    for (const toggle of toggles) {
      expect(toggle.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

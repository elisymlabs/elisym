import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Decimal from 'decimal.js-light';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import {
  ADMIN_URL,
  CONVERSATION_DEFINITION,
  PLANS,
  PRODUCT_NAME,
  X_URL,
  YEARLY_DISCOUNT_BPS,
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

/** The plan cards, in order, keyed by name. */
function cards(page: HTMLElement): Map<string, Element> {
  return new Map(
    [...page.querySelectorAll('#pricing li:has(> div > div > h3)')].map((card) => [
      card.querySelector('h3')?.textContent ?? '',
      card,
    ]),
  );
}

describe('the plans', () => {
  it('are the final six, in order, with Growth featured', () => {
    expect(PLANS.map((plan) => plan.name)).toEqual([
      'Free',
      'Starter',
      'Growth',
      'Pro',
      'Scale',
      'Enterprise',
    ]);
    expect(PLANS.filter((plan) => plan.featured).map((plan) => plan.name)).toEqual(['Growth']);
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
  it('shows monthly prices first, with the small print', async () => {
    const page = await render();
    const shown = cards(page);
    expect([...shown.keys()]).toEqual(PLANS.map((plan) => plan.name));
    for (const plan of PLANS) {
      const card = shown.get(plan.name);
      expect(card?.textContent, plan.name).toContain(plan.price.monthly);
      for (const feature of plan.features) {
        expect(card?.textContent, plan.name).toContain(feature);
      }
    }
    const pricing = page.querySelector('#pricing')?.textContent ?? '';
    expect(pricing).toContain(CONVERSATION_DEFINITION);
    expect(pricing).toContain('Conversation counts are approximate.');
    expect(pricing).toContain('spend cap');
  });

  it('switches to yearly prices, leaving Free and Enterprise as they are', async () => {
    const page = await render();
    const radios = [...page.querySelectorAll<HTMLButtonElement>('#pricing [role="radio"]')];
    expect(page.querySelector('#pricing [role="radiogroup"]')?.getAttribute('aria-label')).toBe(
      'Billing period',
    );
    expect(radios.map((radio) => radio.textContent)).toEqual(['Monthly', 'Yearly']);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    await act(async () => radios[1]?.click());
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    const shown = cards(page);
    for (const plan of PLANS) {
      const text = shown.get(plan.name)?.textContent ?? '';
      if (plan.price.kind === 'from' || plan.price.monthly === '$0') {
        expect(text, plan.name).toContain(plan.price.monthly);
        expect(text, plan.name).not.toContain('billed yearly');
      } else {
        expect(text, plan.name).toContain(plan.price.yearlyPerMonth);
        expect(text, plan.name).toContain(`${plan.price.yearlyTotal} billed yearly`);
      }
    }
  });

  it('moves between Monthly and Yearly with the arrow keys, one tab stop for the group', async () => {
    const page = await render();
    const group = page.querySelector('#pricing [role="radiogroup"]');
    const radios = [...page.querySelectorAll<HTMLButtonElement>('#pricing [role="radio"]')];
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1]);
    await act(async () => {
      group?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0]);
    expect(document.activeElement).toBe(radios[1]);
    await act(async () => {
      group?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  });

  it('starts Free in the admin and every other plan with us', async () => {
    const page = await render();
    const shown = cards(page);
    for (const plan of PLANS) {
      const links = [...(shown.get(plan.name)?.querySelectorAll('a') ?? [])];
      expect(
        links.map((link) => link.href),
        plan.name,
      ).toEqual([plan.start === 'admin' ? ADMIN_URL : X_URL]);
    }
    expect(shown.get('Enterprise')?.querySelector('a')?.textContent).toBe('Contact us');
  });
});
